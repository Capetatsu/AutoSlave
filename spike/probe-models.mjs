// Probe: which reviewer models actually work on this server?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8'));
const BASE = 'http://127.0.0.1:49374';
const AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');

async function api(method, p, body, timeoutMs = 120000) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, json: text ? JSON.parse(text) : null };
}

const workdir = path.join(ROOT, 'spike', 'work');
const candidates = [
  { id: 'claude-haiku-4-5', providerID: 'anthropic' },
  { id: 'mimo-v2.6-flash-free', providerID: 'opencode' },
];
for (const model of candidates) {
  try {
    const s = await api('POST', '/api/session', { title: 'model-probe', location: { directory: workdir } });
    const sid = s.json.data.id;
    const sw = await api('POST', `/api/session/${sid}/model`, { model });
    await api('POST', `/api/session/${sid}/prompt`, { text: 'Reply with exactly the token PROBE-OK. No tools.' });
    await api('POST', `/api/experimental/session/${sid}/wait`, undefined, 180000);
    await new Promise((r) => setTimeout(r, 2000));
    const h = await api('GET', `/api/session/${sid}/message?order=desc&limit=3`);
    const asst = h.json.data.find((m) => m.type === 'assistant');
    const text = (asst?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    console.log(`${model.providerID}/${model.id}: switch=${sw.status} model=${JSON.stringify(asst?.model)} reply=${text.slice(0, 60)}`);
  } catch (e) {
    console.log(`${model.providerID}/${model.id}: FAILED ${e.message}`);
  }
}
process.exit(0);
