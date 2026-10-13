import fs from 'node:fs';
const home = process.argv[2];
const s = JSON.parse(fs.readFileSync(home + '/workflows.json', 'utf8'));
const t = Object.values(s.tasks)[0];
console.log('state=' + t.state, 'iter=' + t.iteration);
console.log('verdicts: ' + s.messages.filter((m) => m.type === 'review.verdict').map((m) => m.payload.status).join(' -> '));
console.log('types: ' + s.messages.map((m) => m.type).join(', '));
