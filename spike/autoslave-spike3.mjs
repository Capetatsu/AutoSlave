// AutoSlave Phase 0 spike, part 3:
// (local) model-switch stick check, diff shape, formal verdict validation;
// (live) concurrency + mid-flight SSE reconnect test with two tiny prompts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(ROOT, 'spike', 'findings');
const sum = JSON.parse(fs.readFileSync(path.join(FINDINGS, 'spike-summary.json'), 'utf8'));
const CODER = sum.summary.createCoder.id;
const BASE = sum.server;
const AUTH = 'Basic ' + Buffer.from('opencode:' + JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8')).password).toString('base64');
const out = {};

async function api(method, p, body, timeoutMs = 60000) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: r.status, ms: Date.now() - t0, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, s) => console.log(`\n--- step ${n}: ${s} ---`);

function sseBucket(signal) {
  const frames = [];
  const p = fetch(BASE + '/api/event', { headers: { Authorization: AUTH, Accept: 'text/event-stream' }, signal })
    .then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', cur = {};
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (t === '') {
            if (cur.data !== undefined) {
              let d = cur.data;
              try { d = JSON.parse(JSON.parse(cur.data)); } catch { try { d = JSON.parse(cur.data); } catch { /* raw */ } }
              frames.push({ t: Date.now(), type: d?.type, sid: d?.data?.sessionID, raw: JSON.stringify(d).slice(0, 200) });
              cur = {};
            }
            continue;
          }
          if (t.startsWith(':')) continue;
          const i = t.indexOf(':');
          if (i > 0) cur[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        }
      }
    }).catch(() => {});
  return { frames, p };
}

try {
  step('1', 'model-switch stick check (messages after switch)');
  const h = await api('GET', `/api/session/${CODER}/message?order=desc&limit=6`);
  out.modelsAfterSwitch = h.json.data.filter((m) => m.type === 'assistant').map((m) => m.model);
  console.log(JSON.stringify(out.modelsAfterSwitch));

  step('2', 'diff shape with real changes');
  const d = JSON.parse(fs.readFileSync(path.join(FINDINGS, 'diff-with-changes.json'), 'utf8'));
  console.log(JSON.stringify(d).slice(0, 900));
  out.diffShape = Array.isArray(d?.data) && d.data.length > 0 ? Object.keys(d.data[0]) : null;

  step('3', 'formal verdict validation from reviewer history');
  const list = await api('GET', '/api/session?limit=50&order=desc');
  const reviewer = list.json.data.find((s) => s.title === 'autoslave-spike-reviewer');
  const rh = await api('GET', `/api/session/${reviewer.id}/message?order=desc&limit=3`);
  const lastAssistant = rh.json.data.find((m) => m.type === 'assistant');
  const texts = (lastAssistant.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const fence = texts.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = (fence ? fence[1] : texts).trim();
  let v = null, err = null;
  try { v = JSON.parse(cand); } catch (e) { err = e.message; }
  out.verdict = {
    parsed: !!v, err,
    status: v?.status, issues: v?.issues?.length, nextActions: v?.next_actions?.length,
    schemaValid: v?.status === 'reject' && Array.isArray(v.issues) && v.issues.length > 0 && Array.isArray(v.next_actions) && v.next_actions.length > 0,
  };
  console.log(JSON.stringify(out.verdict));

  step('4', 'live: concurrent prompts on two sessions + mid-flight reconnect');
  const c2 = (await api('POST', '/api/session', { title: 'autoslave-spike-conc' })).json.data;
  console.log('second session:', c2.id);
  const ctl1 = new AbortController();
  const b1 = sseBucket(ctl1.signal);
  await sleep(800);
  // send both prompts back-to-back without waiting (concurrency)
  const t0 = Date.now();
  const [pa, pb] = await Promise.all([
    api('POST', `/api/session/${CODER}/prompt`, { text: 'Reply with exactly the token CONC-A and nothing else. No tools.' }),
    api('POST', `/api/session/${c2.id}/prompt`, { text: 'Reply with exactly the token CONC-B and nothing else. No tools.' }),
  ]);
  console.log('both prompts accepted:', pa.status, pb.status, `in ${Date.now() - t0}ms`);
  await sleep(400);
  ctl1.abort(); // kill stream mid-flight (Q10)
  const missed = b1.frames.length;
  await sleep(300);
  const ctl2 = new AbortController();
  const b2 = sseBucket(ctl2.signal); // reconnect
  const w = await Promise.all([
    api('POST', `/api/experimental/session/${CODER}/wait`, undefined, 120000),
    api('POST', `/api/experimental/session/${c2.id}/wait`, undefined, 120000),
  ]);
  await sleep(1500);
  ctl2.abort();
  await Promise.allSettled([b1.p, b2.p]);
  const term = (frames, sid) => frames.filter((f) => f.sid === sid && (f.type === 'session.execution.succeeded' || f.type === 'session.execution.failed')).length;
  const ha = await api('GET', `/api/session/${CODER}/message?order=desc&limit=2`);
  const hb = await api('GET', `/api/session/${c2.id}/message?order=desc&limit=2`);
  const txt = (msgs) => { const a = msgs.find((m) => m.type === 'assistant'); return (a.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '); };
  out.live = {
    framesBeforeKill: missed,
    framesAfterReconnect: b2.frames.length,
    terminalA_beforeKill: term(b1.frames, CODER),
    terminalA_afterReconnect: term(b2.frames, CODER),
    terminalB_afterReconnect: term(b2.frames, c2.id),
    textA: txt(ha.json.data), textB: txt(hb.json.data),
  };
  console.log(JSON.stringify(out.live, null, 1));
  out.concSession = c2.id;
} catch (e) { out.fatal = e.message; console.error('FATAL:', e); }

fs.writeFileSync(path.join(FINDINGS, 'spike3-summary.json'), JSON.stringify({ at: new Date().toISOString(), out }, null, 1));
console.log('\n=== spike3 done ===');
process.exit(0);
