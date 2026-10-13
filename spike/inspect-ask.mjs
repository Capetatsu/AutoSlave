import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const svc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8'));
const BASE = 'http://127.0.0.1:49374';
const AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');
async function api(method, p, body, t = 30000) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(t) });
  return JSON.parse(await r.text());
}
const list = await api('GET', '/api/session?limit=5&order=desc');
const s = list.data.find((x) => x.title === 'perm-probe');
console.log('session:', s?.id);
const h = await api('GET', `/api/session/${s.id}/message?order=asc&limit=10`);
for (const m of h.data) {
  if (m.type === 'assistant') for (const c of m.content ?? []) console.log(`[${c.type}]`, (c.text ?? JSON.stringify(c)).slice(0, 400));
  else if (m.type === 'user') console.log('[user]', m.text.slice(0, 100));
  else console.log('[idle]', m.outcome);
}
process.exit(0);
