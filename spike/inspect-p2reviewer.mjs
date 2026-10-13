// Inspect what the reviewer session changed (D7 trip analysis).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const svc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8'));
const BASE = 'http://127.0.0.1:49374';
const AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');
async function api(method, p, body, timeoutMs = 30000) {
  const r = await fetch(BASE + p, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return JSON.parse(await r.text());
}
const list = await api('GET', '/api/session?limit=10&order=desc');
const rev = list.data.find((s) => s.title === 'p2-reviewer');
console.log('reviewer:', rev?.id);
const d = await api('GET', `/api/session/${rev.id}/diff`);
console.log(JSON.stringify(d, null, 1).slice(0, 2000));
const h = await api('GET', `/api/session/${rev.id}/message?order=asc&limit=10`);
for (const m of h.data) {
  if (m.type === 'assistant') {
    for (const c of m.content ?? []) {
      console.log(`--- assistant[${c.type}]:`, JSON.stringify(c).slice(0, 400));
    }
  } else if (m.type === 'user') console.log('--- user:', m.text.slice(0, 120));
  else console.log('---', m.type, m.outcome ?? '');
}
process.exit(0);
