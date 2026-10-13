import fs from 'node:fs';
const raw = fs.readFileSync('spike/findings/openapi-2.0.28.json', 'utf8');
const spec = JSON.parse(raw);
// where does json_schema / structured output appear?
const lines = raw.split('\n');
let count = 0;
for (let i = 0; i < lines.length && count < 30; i++) {
  if (/json_schema|structured|outputFormat|OutputFormat/i.test(lines[i])) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 160));
    count++;
  }
}
console.log('---agent/model ops---');
for (const p of ['/api/session/{sessionID}/agent', '/api/session/{sessionID}/model']) {
  console.log(p, Object.keys(spec.paths[p] || {}));
  const ops = spec.paths[p] || {};
  for (const [m, op] of Object.entries(ops)) {
    console.log('  ' + m.toUpperCase(), JSON.stringify(op.requestBody || {}).slice(0, 500));
  }
}
console.log('---generate 200 schema---');
console.log(JSON.stringify(spec.paths['/api/session/{sessionID}/generate']['post'].responses['200'], null, 1).slice(0, 800));
