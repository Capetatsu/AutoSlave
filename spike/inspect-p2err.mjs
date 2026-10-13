// Inspect reviewer failure error payload.
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
const h = await api('GET', `/api/session/${rev.id}/message?order=desc&limit=5`);
for (const m of h.data) {
  console.log('===', m.type, m.outcome ?? '', '| error:', JSON.stringify(m.error ?? null).slice(0, 500));
  for (const c of m.content ?? []) console.log('   [' + c.type + ']', (c.text ?? JSON.stringify(c).slice(0, 200)).slice(0, 300));
}
process.exit(0);
