// Phase 0 follow-up inspection: raw shapes for session.get, messages, lists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINDINGS = path.join(ROOT, 'spike', 'findings');
const sum = JSON.parse(fs.readFileSync(path.join(FINDINGS, 'spike-summary.json'), 'utf8'));
const CODER = sum.summary.createCoder.id;
const BASE = sum.server;
const AUTH = 'Basic ' + Buffer.from('opencode:' + JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8')).password).toString('base64');

async function api(method, p, body, timeoutMs = 30000) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: r.status, json, text: json ? undefined : text.slice(0, 300) };
}

console.log('coder:', CODER);
let r = await api('GET', `/api/session/${CODER}`);
console.log('--- session.get keys:', Object.keys(r.json?.data ?? {}));
console.log(JSON.stringify(r.json?.data, null, 1).slice(0, 1500));

r = await api('GET', `/api/session/${CODER}/message?order=asc&limit=50`);
const msgs = r.json?.data ?? [];
console.log('--- message count:', msgs.length);
for (const m of msgs) {
  console.log('msg:', JSON.stringify(m).slice(0, 600));
}
fs.writeFileSync(path.join(FINDINGS, 'messages-coder-raw.json'), JSON.stringify(msgs, null, 1));

r = await api('GET', '/api/session?limit=50&order=desc');
const ids = (r.json?.data ?? []).map((s) => s.id);
console.log('--- API list contains coder?', ids.includes(CODER), 'total:', ids.length);

for (const cwd of [ROOT, path.join(ROOT, 'spike', 'work')]) {
  try {
    const out = execFileSync('opencode session list', { encoding: 'utf8', shell: true, cwd });
    console.log(`--- CLI list (cwd=${cwd}): contains coder?`, out.includes(CODER), '| lines:', out.trim().split('\n').length);
  } catch (e) { console.log('CLI list ERR', cwd, e.message); }
}
