// AutoSlave Phase 0 spike, part 2: wait semantics, model switch, tool-use +
// permission behavior, real diff, abort-during-execution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(ROOT, 'spike', 'findings');
const WORKDIR = path.join(ROOT, 'spike', 'work');
const sum = JSON.parse(fs.readFileSync(path.join(FINDINGS, 'spike-summary.json'), 'utf8'));
const CODER = sum.summary.createCoder.id;
const BASE = sum.server;
const AUTH = 'Basic ' + Buffer.from('opencode:' + JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8')).password).toString('base64');

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
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: r.status, ms: Date.now() - t0, json };
}

function subscribeSSE(filter, signal) {
  const seen = [];
  const ready = new Promise((resolve, reject) => {
    fetch(BASE + '/api/event', { headers: { Authorization: AUTH, Accept: 'text/event-stream' }, signal })
      .then((r) => {
        if (!r.ok || !r.body) return reject(new Error('SSE ' + r.status));
        resolve(true);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '', cur = {};
        const go = async () => {
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
                  if (filter(JSON.stringify(d))) seen.push({ t: Date.now(), type: d?.type, d });
                  cur = {};
                }
                continue;
              }
              if (t.startsWith(':')) continue;
              const i = t.indexOf(':');
              if (i > 0) cur[t.slice(0, i).trim()] = t.slice(i + 1).trim();
            }
          }
        };
        go();
      })
      .catch(reject);
  });
  return { seen, ready };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, s) => console.log(`\n--- step ${n}: ${s} ---`);
const out = {};
const has = (id) => (s) => s.includes(id);

try {
  step('A', 'wait semantics: prompt, await execution.started via SSE, THEN call wait');
  const ctl = new AbortController();
  const sub = subscribeSSE(has(CODER), ctl.signal);
  await sub.ready;
  await api('POST', `/api/session/${CODER}`, undefined).catch(() => {});
  const p = await api('POST', `/api/session/${CODER}/prompt`, { text: 'Reply with exactly the token WAIT-TEST and nothing else. No tools.' });
  console.log('prompt status', p.status);
  let started = 0;
  for (let i = 0; i < 100 && !started; i++) { await sleep(200); started = sub.seen.find((e) => e.type === 'session.execution.started')?.t ?? 0; }
  console.log('execution.started observed:', !!started);
  const w = await api('POST', `/api/experimental/session/${CODER}/wait`, undefined, 120000);
  const endEv = sub.seen.find((e) => e.type === 'session.execution.succeeded' || e.type === 'session.execution.failed');
  console.log(`wait -> ${w.status} in ${w.ms}ms; terminal event at +${endEv ? endEv.t - started : '?'}ms vs wait ${w.ms}ms`);
  out.waitRetest = { waitStatus: w.status, waitMs: w.ms, execMs: endEv ? endEv.t - started : null };
  ctl.abort();

  step('B', 'per-session model switch');
  const m = await api('POST', `/api/session/${CODER}/model`, { model: { id: 'mimo-v2.6-flash-free', providerID: 'opencode' } });
  console.log('model switch status', m.status, JSON.stringify(m.json));
  out.modelSwitch = { status: m.status, body: m.json };

  step('C', 'tool-use + permission default behavior + real diff');
  const ctl2 = new AbortController();
  const sub2 = subscribeSSE(has(CODER), ctl2.signal);
  await sub2.ready;
  await api('POST', `/api/session/${CODER}/prompt`, { text: 'Create a file named spike-note.txt in your working directory containing exactly the word HELLO. Do not do anything else. Do not call shell commands.' });
  let done = null;
  for (let i = 0; i < 150 && !done; i++) { await sleep(1000); done = sub2.seen.find((e) => e.type === 'session.execution.succeeded' || e.type === 'session.execution.failed'); }
  const permEvents = sub2.seen.filter((e) => (e.type ?? '').includes('permission'));
  console.log('terminal:', done?.type, '| permission events:', permEvents.length, permEvents.map((e) => e.type).join(','));
  console.log('file exists:', fs.existsSync(path.join(WORKDIR, 'spike-note.txt')), '| content:', fs.existsSync(path.join(WORKDIR, 'spike-note.txt')) ? JSON.stringify(fs.readFileSync(path.join(WORKDIR, 'spike-note.txt'), 'utf8')) : null);
  const d = await api('GET', `/api/session/${CODER}/diff`);
  console.log('diff status', d.status, 'entries:', Array.isArray(d.json?.data) ? d.json.data.length : JSON.stringify(d.json).slice(0, 200));
  fs.writeFileSync(path.join(FINDINGS, 'diff-with-changes.json'), JSON.stringify(d.json, null, 1));
  out.toolUse = { terminal: done?.type, permissionEvents: permEvents.map((e) => e.type), fileCreated: fs.existsSync(path.join(WORKDIR, 'spike-note.txt')) };
  ctl2.abort();

  step('D', 'abort DURING execution (long story, interrupt at +4s)');
  const ctl3 = new AbortController();
  const sub3 = subscribeSSE(has(CODER), ctl3.signal);
  await sub3.ready;
  await api('POST', `/api/session/${CODER}/prompt`, { text: 'Write a 1500-word fantasy story about a lighthouse keeper. No tools, just write.' });
  await sleep(4000);
  const intr = await api('POST', `/api/session/${CODER}/interrupt`);
  console.log('interrupt:', intr.status, JSON.stringify(intr.json));
  await sleep(3000);
  const h = await api('GET', `/api/session/${CODER}/message?order=desc&limit=3`);
  console.log('latest:', JSON.stringify(h.json.data.map((x) => ({ type: x.type, outcome: x.outcome }))));
  out.abort = { interrupt: intr.json, latest: h.json.data.map((x) => ({ type: x.type, outcome: x.outcome })) };
  ctl3.abort();
  await sleep(500);
} catch (e) { out.fatal = e.message; console.error('FATAL:', e); }

fs.writeFileSync(path.join(FINDINGS, 'spike2-summary.json'), JSON.stringify({ at: new Date().toISOString(), out }, null, 1));
console.log('\n=== spike2 summary ===');
console.log(JSON.stringify(out, null, 1).slice(0, 2500));
process.exit(0);
