import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync('spike/findings/openapi-2.0.28.json', 'utf8'));
const S = spec.components.schemas;
console.log('=== SessionGenerateResponse:');
console.log(JSON.stringify(S['SessionGenerateResponse'], null, 1).slice(0, 1200));
console.log('=== Agent list op:');
console.log(JSON.stringify(spec.paths['/api/agent']['get'], null, 1).slice(0, 800));
console.log('=== permission request list:');
console.log(JSON.stringify(spec.paths['/api/session/{sessionID}/permission']['get'] ?? spec.paths['/api/permission/request'], null, 1).slice(0, 1200));
