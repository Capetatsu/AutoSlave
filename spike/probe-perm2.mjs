// Q14 live probe: do OpenCode permission rulesets raise answerable requests?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'service.json'), 'utf8'));
const BASE = 'http://127.0.0.1:49374';
const AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');
const workdir = path.join(ROOT, 'spike', 'work');
fs.mkdirSync(workdir, { recursive: true });

async function api(method, p, body, timeoutMs = 60000) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, json: text ? JSON.parse(text) : null };
}

const frames = [];
const ctl = new AbortController();
const sub = fetch(BASE + '/api/event', { headers: { Authorization: AUTH, Accept: 'text/event-stream' }, signal: ctl.signal })
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
            frames.push({ t: Date.now(), type: d?.type, d });
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
await new Promise((r) => setTimeout(r, 800));

// Session with deny-write ruleset (best guess at effect vocabulary: deny).
const s = await api('POST', '/api/session', {
  title: 'perm-probe',
  location: { directory: workdir },
  permissions: [{ action: 'write', resource: '*', effect: 'ask' }],
});
console.log('create:', s.status, JSON.stringify(s.json).slice(0, 300));
const sid = s.json?.data?.id;

await api('POST', `/api/session/${sid}/prompt`, { text: 'Create a file named perm-probe.txt in your working directory containing the word PROBE. Do not do anything else.' });
await api('POST', `/api/experimental/session/${sid}/wait`, undefined, 120000).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
ctl.abort();
await sub;

const perm = frames.filter((f) => (f.type ?? '').includes('permission'));
console.log('permission frames:', perm.length);
for (const f of perm) console.log(JSON.stringify(f.d).slice(0, 600));
console.log('file exists:', fs.existsSync(path.join(workdir, 'perm-probe2.txt')));
const h = await api('GET', `/api/session/${sid}/message?order=desc&limit=3`);
console.log('latest:', h.json.data.map((m) => m.type + (m.outcome ? ':' + m.outcome : '')).join(', '));
// Pending permission requests listable?
const pl = await api('GET', `/api/session/${sid}/permission`);
console.log('permission list:', pl.status, JSON.stringify(pl.json).slice(0, 400));
process.exit(0);
