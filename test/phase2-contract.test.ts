/**
 * Phase 2 contract test: full Coder ↔ Reviewer loop against the REAL server.
 * Seeded defect (add returns a-b); reviewer must catch it, coder fixes,
 * reviewer approves. Zero manual message transfer — the engine drives all turns.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OpenCodeAdapter } from '../src/adapter/adapter.js';
import { discoverConnection } from '../src/adapter/client.js';
import { AgentRegistry } from '../src/registry/registry.js';
import { StateStore } from '../src/store/store.js';
import { WorkflowEngine } from '../src/workflow/engine.js';

let available = false;
let dir: string;

const PLAN = `# Plan: mathutil documentation and validator correctness
1. \`add(a, b)\` in mathutil.js must have a JSDoc comment describing parameters and return value.
2. \`add(a, b)\` must return the exact sum a + b.
3. Both functions must remain exported via module.exports.
4. \`isAdult(age)\` in validator.js must return true for age >= 18 and false otherwise.
`;

const MATHUTIL = `function add(a, b) {
  return a + b;
}

module.exports = { add };
`;

const VALIDATOR_SEEDED = `function isAdult(age) {
  return age > 18;
}

module.exports = { isAdult };
`;

before(async () => {
  try {
    discoverConnection();
    available = true;
  } catch (e) {
    console.log(`phase-2 contract tests skipped: ${(e as Error).message}`);
  }
});

describe('phase-2 loop (live OpenCode, seeded defect)', () => {
  it('reviewer rejects the seeded defect, coder fixes, reviewer approves', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-p2-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
    fs.writeFileSync(path.join(dir, 'mathutil.js'), MATHUTIL);
    fs.writeFileSync(path.join(dir, 'validator.js'), VALIDATOR_SEEDED);
    execFileSync('git', ['add', '.'], { cwd: dir });

    // State/logs MUST live outside the agent workdir: the adapter appends to
    // raw.log during turns, and session diffs attribute any file changed in the
    // workdir during a turn (a raw.log inside broke D7 write-detection once).
    const home = `${dir}-home`;
    const adapter = new OpenCodeAdapter({ logPath: path.join(home, 'raw.log') });
    const registry = new AgentRegistry(path.join(home, 'registry.json'));
    const store = new StateStore(home);
    const engine = new WorkflowEngine({ adapter, registry, store });

    const coderSession = await adapter.createSession({ title: 'p2-coder', location: { directory: dir } });
    const reviewerSession = await adapter.createSession({ title: 'p2-reviewer', location: { directory: dir } });
    // Reviewer independence: a different model from the coder default (D5).
    // Anthropic key in env is invalid (401, verified 2026-10-14), so the judge is
    // a different free-tier model — weaker independence, recorded honestly.
    await adapter.setModel(reviewerSession.id, { id: 'mimo-v2.6-flash-free', providerID: 'opencode' });

    const coder = registry.add({ role: 'coder', sessionId: coderSession.id, serverUrl: '', model: 'opencode/cat-jam-free', workdir: dir });
    const reviewer = registry.add({ role: 'reviewer', sessionId: reviewerSession.id, serverUrl: '', model: 'opencode/mimo-v2.6-flash-free', workdir: dir });

    const task = engine.createTask({
      objective: 'Document add() in mathutil.js with JSDoc according to plan.md items 1-3. Do not change any logic. Do not touch any other file.',
      // The reviewer judges the whole tree against the full plan — including
      // the seeded validator.js defect the coder was never asked to touch.
      reviewObjective: 'Implement all of plan.md (documentation and correctness).',
      planExcerpt: PLAN,
      planPath: path.join(dir, 'plan.md'),
      coderAgentId: coder.id,
      reviewerAgentId: reviewer.id,
      workdir: dir,
      // validator.js has no diff yet but is plan-relevant: the reviewer must
      // verify it against plan item 4 from its current content.
      reviewFiles: ['validator.js'],
      maxIterations: 4,
      coderTimeoutMs: 300000,
      reviewerTimeoutMs: 240000,
    });

    const terminal = await engine.run(task.id);
    const done = store.getTask(task.id);
    const verdicts = store.messagesFor(task.id).filter((m) => m.type === 'review.verdict');

    console.log(`terminal=${terminal} iterations=${done?.iteration} verdicts=${verdicts.map((v) => (v.payload as { status: string }).status).join(',')}`);
    fs.writeFileSync(path.join(home, 'EVIDENCE.txt'),
      `terminal=${terminal}\niterations=${done?.iteration}\nreason=${done?.reason ?? ''}\n` +
      `verdicts=${JSON.stringify(verdicts.map((v) => v.payload))}\nfinal validator.js:\n${fs.readFileSync(path.join(dir, 'validator.js'), 'utf8')}\n`);

    // The required reject → fix → approve cycle.
    assert.equal(terminal, 'APPROVED');
    assert.ok(verdicts.length >= 2, 'at least two review rounds');
    assert.equal((verdicts[0].payload as { status: string }).status, 'reject');
    assert.equal((verdicts[verdicts.length - 1].payload as { status: string }).status, 'approve');
    assert.ok((done?.iteration ?? 0) >= 2, 'loop iterated');
    // Fix actually landed in validator.js (off-by-one corrected).
    const finalValidator = fs.readFileSync(path.join(dir, 'validator.js'), 'utf8');
    assert.ok(finalValidator.includes('age >= 18'), `validator.js still buggy:\n${finalValidator}`);
    // Audit reconstructs every step with no human relay.
    const trail = store.readAudit(task.id, 200).map((r) => String(r.detail)).join('\n');
    for (const hop of ['CREATED → CODING', 'CODING → REVIEWING', 'REVIEWING → FIXING', 'FIXING → REVIEWING', '→ APPROVED']) {
      assert.ok(trail.includes(hop), `audit missing ${hop}`);
    }
    console.log(`E2E artifacts: ${home}`);
  });
});
