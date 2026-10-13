// AutoSlave Phase 0 spike: drive real OpenCode sessions through the v2 HTTP API.
// No SDK, no scraping. Evidence lands in spike/findings/.
// Usage: node spike/autoslave-spike.mjs  (or npm run spike)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(ROOT, 'spike', 'findings');
const WORKDIR = path.join(ROOT, 'spike', 'work');
fs.mkdirSync(WORKDIR, { recursive: true });

function serverUrl() {
  if (process.env.AUTOSLAVE_OPENCODE_URL) return process.env.AUTOSLAVE_OPENCODE_URL;
  const out = execFileSync('opencode service status', { encoding: 'utf8', shell: true }).trim();
  return out.split(/\s+/)[0];
}
function password() {
  const p = path.join(os.homedir(), '.config', 'opencode', 'service.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).password;
}
const BASE = serverUrl();
const AUTH = 'Basic ' + Buffer.from('opencode:' + password()).toString('base64');
console.log('server:', BASE);

async function api(method, p, body, timeoutMs = 30000) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, ms: Date.now() - t0, json, text: json ? undefined : text.slice(0, 500) };
}

// Minimal SSE client. Calls onEvent({event, data}) for each frame.
async function subscribeSSE(onEvent, signal) {
  const r = await fetch(BASE + '/api/event', {
    headers: { Authorization: AUTH, Accept: 'text/event-stream' },
    signal,
  });
  if (!r.ok || !r.body) throw new Error('SSE subscribe failed: ' + r.status);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let cur = {};
  const dispatch = () => {
    if (cur.data !== undefined) {
      let data = cur.data;
      try { data = JSON.parse(data); } catch { /* keep raw */ }
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* keep */ } }
      onEvent({ event: cur.event || 'message', data });
      cur = {};
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t === '') { dispatch(); continue; }
      if (t.startsWith(':')) continue;
      const i = t.indexOf(':');
      if (i > 0) cur[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, s) => console.log(`\n--- step ${n}: ${s} ---`);
const summary = {};

try {
  step(1, 'list sessions (before)');
  let r = await api('GET', '/api/session?limit=50&order=desc');
  summary.listBefore = { status: r.status, count: r.json?.data?.length };
  console.log('status', r.status, 'sessions:', (r.json?.data ?? []).map((s) => `${s.id} [${s.title}]`).join(' | '));

  step(2, 'create coder session in spike/work');
  r = await api('POST', '/api/session', { title: 'autoslave-spike-coder', location: { directory: WORKDIR } });
  const coder = r.json?.data;
  summary.createCoder = { status: r.status, id: coder?.id, location: coder?.location };
  console.log('status', r.status, 'id', coder?.id, 'location', JSON.stringify(coder?.location));

  step(3, 'subscribe SSE (sub A) BEFORE sending prompt');
  const eventsA = [];
  const eventsB = [];
  const ctlA = new AbortController();
  const subA = subscribeSSE((e) => {
    if (e.data?.sessionID === coder.id || JSON.stringify(e).includes(coder.id)) eventsA.push({ t: Date.now(), ...e });
  }, ctlA.signal).catch((e) => console.log('subA ended:', e.message));

  step(4, 'send async prompt to coder (timed)');
  const t0 = Date.now();
  r = await api('POST', `/api/session/${coder.id}/prompt`, {
    text: 'Reply with exactly the single token SPIKE-OK and nothing else. Do not call any tools.',
  });
  summary.promptCoder = { status: r.status, returnMs: Date.now() - t0, inboxId: r.json?.data?.id, delivery: r.json?.data?.delivery };
  console.log('status', r.status, `returned in ${Date.now() - t0}ms`, 'inbox:', r.json?.data?.id, r.json?.data?.delivery);

  step(5, 'late subscribe (sub B, ~2s after prompt) to test event loss');
  await sleep(2000);
  const ctlB = new AbortController();
  const subB = subscribeSSE((e) => {
    if (JSON.stringify(e).includes(coder.id)) eventsB.push({ t: Date.now(), ...e });
  }, ctlB.signal).catch((e) => console.log('subB ended:', e.message));

  step(6, 'wait for idle via experimental wait endpoint (120s cap)');
  const tw = Date.now();
  const w = await api('POST', `/api/experimental/session/${coder.id}/wait`, undefined, 120000).catch((e) => ({ status: 'ERR', ms: Date.now() - tw, error: e.message }));
  summary.waitCoder = { status: w.status, waitedMs: Date.now() - tw, error: w.error };
  console.log('wait result:', w.status, `after ${Date.now() - tw}ms`);
  await sleep(1500); // let trailing events land

  step(7, 'fetch message history');
  r = await api('GET', `/api/session/${coder.id}/message?order=asc&limit=50`);
  const msgs = r.json?.data ?? [];
  summary.historyCoder = { status: r.status, count: msgs.length, types: msgs.map((m) => m.info?.type ?? m.type) };
  const assistantTexts = [];
  for (const m of msgs) {
    if (m.type !== 'assistant') continue;
    for (const p of m.content ?? []) if (p.type === 'text') assistantTexts.push((p.text ?? '').slice(0, 200));
  }
  summary.historyCoder.assistantPreview = assistantTexts;
  console.log('messages:', msgs.length, 'types:', summary.historyCoder.types.join(','));
  console.log('assistant text:', JSON.stringify(assistantTexts).slice(0, 300));
  console.log('coder session model:', JSON.stringify((await api('GET', `/api/session/${coder.id}`)).json?.data?.model));

  step(8, 'coder events observed');
  const typesA = {};
  for (const e of eventsA) typesA[e.event + ':' + (e.data?.type ?? '?')] = (typesA[e.event + ':' + (e.data?.type ?? '?')] ?? 0) + 1;
  summary.eventsA = { count: eventsA.length, types: typesA };
  summary.eventsB = { count: eventsB.length };
  console.log('subA frames:', eventsA.length, JSON.stringify(typesA, null, 1));
  console.log('subB frames:', eventsB.length, '(late subscriber; 0 suggests no replay/backfill)');
  fs.writeFileSync(path.join(FINDINGS, 'events-coder-subA.ndjson'), eventsA.map((e) => JSON.stringify(e)).join('\n'));

  step(9, 'reviewer session: structured-JSON-by-instruction verdict test');
  r = await api('POST', '/api/session', { title: 'autoslave-spike-reviewer', location: { directory: WORKDIR } });
  const reviewer = r.json?.data;
  console.log('reviewer id', reviewer?.id, 'status', r.status);
  const t1 = Date.now();
  r = await api('POST', `/api/session/${reviewer.id}/prompt`, {
    text: 'A coder claims it implemented session expiry but the diff is empty. Reply with ONLY a raw JSON object, no code fences, no prose, matching this shape: {"status":"reject","summary":"...","issues":[{"id":"I1","severity":"high","file":"src/auth/session.ts","description":"..."}],"next_actions":["..."]}.',
  }, 180000);
  summary.promptReviewer = { status: r.status, returnMs: Date.now() - t1 };
  await api('POST', `/api/experimental/session/${reviewer.id}/wait`, undefined, 180000).catch(() => {});
  await sleep(1000);
  const h = await api('GET', `/api/session/${reviewer.id}/message?order=asc&limit=20`);
  let verdictRaw = '';
  for (const m of h.json?.data ?? []) {
    if (m.type !== 'assistant') continue;
    for (const p of m.content ?? []) if (p.type === 'text') verdictRaw += p.text ?? '';
  }
  const fence = verdictRaw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : verdictRaw).trim();
  let verdict = null, verdictError = null;
  try { verdict = JSON.parse(candidate); } catch (e) { verdictError = e.message + ' | raw head: ' + candidate.slice(0, 160); }
  const valid = verdict && (verdict.status === 'approve' || verdict.status === 'reject')
    && (verdict.status === 'approve' || (Array.isArray(verdict.next_actions) && verdict.next_actions.length > 0));
  summary.verdict = { parsed: !!verdict, valid: !!valid, error: verdictError, rawHead: candidate.slice(0, 300) };
  console.log('verdict parsed:', !!verdict, 'schema-valid:', !!valid, verdictError ?? JSON.stringify(verdict).slice(0, 300));
  fs.writeFileSync(path.join(FINDINGS, 'verdict-sample.txt'), candidate);

  step(10, 'abort test: long task then interrupt');
  r = await api('POST', `/api/session/${coder.id}/prompt`, { text: 'Count slowly from 1 to 30, one number per line. Do not call any tools.' });
  console.log('count prompt status', r.status);
  await sleep(6000);
  const ti = Date.now();
  const intr = await api('POST', `/api/session/${coder.id}/interrupt`);
  summary.interrupt = { status: intr.status, ms: Date.now() - ti, body: intr.json };
  console.log('interrupt:', intr.status, JSON.stringify(intr.json));
  await sleep(2000);
  const h2 = await api('GET', `/api/session/${coder.id}/message?order=desc&limit=5`);
  summary.afterInterrupt = (h2.json?.data ?? []).map((m) => ({ type: m.info?.type ?? m.type, outcome: m.info?.outcome }));
  console.log('latest messages after interrupt:', JSON.stringify(summary.afterInterrupt));

  step(11, 'session diff endpoint');
  r = await api('GET', `/api/session/${coder.id}/diff`);
  summary.diff = { status: r.status, keys: r.json?.data ? Object.keys(r.json.data) : r.text };
  console.log('diff status', r.status, JSON.stringify(summary.diff.keys)?.slice(0, 300));

  step(12, 'CLI cross-check: opencode session list shows API-created sessions?');
  try {
    const out = execFileSync('opencode session list', { encoding: 'utf8', shell: true });
    summary.cliList = { coderVisible: out.includes(coder.id), reviewerVisible: out.includes(reviewer.id) };
    console.log('coder in CLI list:', out.includes(coder.id), '| reviewer in CLI list:', out.includes(reviewer.id));
  } catch (e) { summary.cliList = { error: e.message }; }

  ctlA.abort(); ctlB.abort();
  await Promise.allSettled([subA, subB]);
} catch (e) {
  summary.fatal = e.message;
  console.error('FATAL:', e);
}

fs.writeFileSync(path.join(FINDINGS, 'spike-summary.json'), JSON.stringify({ server: BASE, at: new Date().toISOString(), summary }, null, 1));
console.log('\n=== summary written to spike/findings/spike-summary.json ===');
console.log(JSON.stringify(summary, null, 1).slice(0, 3000));
