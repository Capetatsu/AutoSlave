import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync('spike/findings/openapi-2.0.28.json', 'utf8'));
const S = spec.components.schemas;
console.log('Effect:', JSON.stringify(S['Permission.Effect']));
console.log('Action enum?', JSON.stringify(S['Permission.Action'] ?? 'none'));
console.log('Source:', JSON.stringify(S['Permission.Source'] ?? 'none').slice(0, 500));
// any description text mentioning permission semantics
const raw = JSON.stringify(spec.paths['/api/session']);
const i = raw.indexOf('permission');
console.log('session path mentions:', raw.slice(Math.max(0, i - 200), i + 500));
