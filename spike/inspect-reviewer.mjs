// Re-check reviewer verdict with correct v2 message shape + analyze event timing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(ROOT, 'spike', 'findings');
const sum = JSON.parse(fs.readFileSync(path.join(FINDINGS, 'spike-summary.json'), 'utf8'));
const BASE = sum.server;
const AUTH = 'Basic ' + Buffer.from('opencode:' + JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8')).password).toString('base64');

async function api(method, p, body, timeoutMs = 30000) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, json: JSON.parse(await r.text()) };
}

// reviewer id is not in summary (create logged only to console) -> find by title
const list = await api('GET', '/api/session?limit=50&order=desc');
const reviewer = list.json.data.find((s) => s.title === 'autoslave-spike-reviewer');
console.log('reviewer:', reviewer?.id);
const h = await api('GET', `/api/session/${reviewer.id}/message?order=asc&limit=20`);
for (const m of h.json.data) {
  if (m.type === 'user') { console.log('USER:', m.text.slice(0, 120)); continue; }
  if (m.type === 'assistant') {
    console.log('ASSISTANT model:', JSON.stringify(m.model), 'agent:', m.agent);
    for (const c of m.content ?? []) console.log('  content[' + c.type + ']:', (c.text ?? '').slice(0, 500));
  }
  if (m.type === 'idle') console.log('IDLE outcome:', m.outcome);
}

// event timing analysis
const evts = fs.readFileSync(path.join(FINDINGS, 'events-coder-subA.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const t0 = evts[0].t;
console.log('--- subA event timeline (ms since first frame):');
for (const e of evts) console.log(`+${e.t - t0}ms`, e.event, JSON.stringify(e.data).slice(0, 160));
