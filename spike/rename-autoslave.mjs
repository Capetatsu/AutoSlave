// Rename project OpenCode Mesh -> AutoSlave across the four governing docs.
// Ordered rules; reports counts per file for review.
import fs from 'node:fs';

const files = ['CONTEXT.md', 'MAIN_PLAN.md', 'FEATURES.md', 'WHAT_NOT_TO_DO.md'];
const rules = [
  [/OpenCode Mesh/g, 'AutoSlave'],
  [/[Tt]he [Mm]esh's/g, "AutoSlave's"],
  [/[Tt]he [Mm]esh\b/g, 'AutoSlave'],
  [/\bMESH\b/g, 'AUTOSLAVE'],
  [/\bMesh\b/g, 'AutoSlave'],
  [/\bmesh\b/g, 'autoslave'],
];

for (const f of files) {
  let t = fs.readFileSync(f, 'utf8');
  const counts = [];
  for (const [re, rep] of rules) {
    const n = (t.match(re) || []).length;
    t = t.replace(re, rep);
    counts.push(`${re.source}=${n}`);
  }
  fs.writeFileSync(f, t);
  console.log(f, counts.join(' | '));
}
