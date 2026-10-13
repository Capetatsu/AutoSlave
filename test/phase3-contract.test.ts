/**
 * Phase 3 contract test: deterministic checks gate approval, live.
 * Fixture: validator.js is seeded buggy so `node --test` FAILS initially.
 * The coder's scoped objective does not cover it; the reviewer judges the
 * scoped work. Whatever the reviewer does, a required failing check must
 * block APPROVED, its output must reach the coder automatically, and the
 * final APPROVED must coincide with genuinely passing tests (verified by
 * running them here, not by model claims).
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
import { loadChecks } from '../src/verify/checks.js';

let available = false;

const PLAN = `# Plan: mathutil documentation and validator correctness
1. \`add(a, b)\` in mathutil.js must have a JSDoc comment describing parameters and return value.
2. \`add(a, b)\` must return the exact sum a + b.
3. Both functions must remain exported via module.exports.
4. \`isAdult(age)\` in validator.js must return true for age >= 18 and false otherwise.
5. \`validator.test.js\` must test ages 17, 18, 21 and pass under \`node --test\`.
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

const TESTS = `const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAdult } = require('./validator');

describe('isAdult', () => {
  it('returns false for 17', () => {
    assert.strictEqual(isAdult(17), false);
  });
  it('returns true for 18', () => {
    assert.strictEqual(isAdult(18), true);
  });
  it('returns true for 21', () => {
    assert.strictEqual(isAdult(21), true);
  });
});
`;

// Wrapper so the check runs a REAL `node --test` even when AutoSlave itself is
// driven from a test harness: node refuses nested `run()` when NODE_TEST_CONTEXT
// is set (verified 2026-10-14: exit 0, zero tests). Deleting it restores exactly
// the production condition (the daemon never runs under node --test).
const RUN_TESTS = `delete process.env.NODE_TEST_CONTEXT;
const { spawnSync } = require('node:child_process');
const r = spawnSync(process.execPath, ['--test', 'validator.test.js'], { cwd: __dirname, encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
`;

const CHECKS = JSON.stringify({
  checks: [{ name: 'unit', command: 'node run-tests.cjs', required: true, timeoutMs: 120000 }],
});

before(async () => {
  try {
    discoverConnection();
    available = true;
  } catch (e) {
    console.log(`phase-3 contract tests skipped: ${(e as Error).message}`);
  }
});

describe('phase-3 gate (live OpenCode + real checks)', () => {
  it('failing checks block approval; fix flows back; APPROVED only with green tests', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-p3-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
    fs.writeFileSync(path.join(dir, 'mathutil.js'), MATHUTIL);
    fs.writeFileSync(path.join(dir, 'validator.js'), VALIDATOR_SEEDED);
    fs.writeFileSync(path.join(dir, 'validator.test.js'), TESTS);
    fs.writeFileSync(path.join(dir, 'run-tests.cjs'), RUN_TESTS);
    fs.writeFileSync(path.join(dir, 'autoslave.checks.json'), CHECKS);
    execFileSync('git', ['add', '.'], { cwd: dir });

    // Sanity: the seeded tests genuinely fail before the loop runs.
    let initiallyFailing = false;
    let sanityOut = '';
    try {
      sanityOut = execFileSync('node', ['run-tests.cjs'], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      initiallyFailing = true;
      sanityOut = String((e as { stdout?: unknown }).stdout ?? '').slice(0, 300);
    }
    assert.equal(initiallyFailing, true, `fixture must start red (output: ${sanityOut.slice(0, 200)})`);

    const home = `${dir}-home`;
    const adapter = new OpenCodeAdapter({ logPath: path.join(home, 'raw.log') });
    const registry = new AgentRegistry(path.join(home, 'registry.json'));
    const store = new StateStore(home);
    const engine = new WorkflowEngine({ adapter, registry, store });

    const coderSession = await adapter.createSession({ title: 'p3-coder', location: { directory: dir } });
    const reviewerSession = await adapter.createSession({ title: 'p3-reviewer', location: { directory: dir } });
    await adapter.setModel(reviewerSession.id, { id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
    const coder = registry.add({ role: 'coder', sessionId: coderSession.id, serverUrl: '', workdir: dir });
    const reviewer = registry.add({ role: 'reviewer', sessionId: reviewerSession.id, serverUrl: '', workdir: dir });

    const task = engine.createTask({
      objective: 'Document add() in mathutil.js with JSDoc per plan.md items 1-3. Do not change any logic. Do not touch any other file.',
      planExcerpt: PLAN,
      planPath: path.join(dir, 'plan.md'),
      coderAgentId: coder.id,
      reviewerAgentId: reviewer.id,
      workdir: dir,
      reviewFiles: ['validator.js', 'validator.test.js'],
      checks: loadChecks(dir),
      maxIterations: 4,
      coderTimeoutMs: 300000,
      reviewerTimeoutMs: 240000,
    });

    const terminal = await engine.run(task.id);
    const done = store.getTask(task.id);
    const verdicts = store.messagesFor(task.id).filter((m) => m.type === 'review.verdict');
    const audit = store.readAudit(task.id, 300);
    const kinds = audit.map((r) => String(r.kind));
    const blocked = audit.some((r) => r.kind === 'approval.blocked');
    console.log(`terminal=${terminal} iterations=${done?.iteration} verdicts=${verdicts.map((v) => (v.payload as { status: string }).status).join(',')} approvalBlocked=${blocked} home=${home}`);

    // Gate invariants hold on whichever path the models took.
    assert.equal(terminal, 'APPROVED');
    assert.ok(kinds.includes('checks.done'), 'checks ran and were logged');
    assert.ok((done?.lastChecks ?? []).some((c) => c.name === 'unit' && c.status === 'pass'), 'final iteration green');
    // The fix genuinely landed: run the project's own tests here (same wrapper).
    execFileSync('node', ['run-tests.cjs'], { cwd: dir, stdio: 'pipe' });
    assert.ok(fs.readFileSync(path.join(dir, 'validator.js'), 'utf8').includes('age >= 18'));
    // If a block occurred, approval was necessarily deferred: a blocked round
    // forces another iteration, so APPROVED at iteration 1 is impossible.
    if (blocked) {
      assert.ok((done?.iteration ?? 0) >= 2, 'blocked approval must continue the loop');
    }
    console.log(`path: ${blocked ? '(a) blocked-then-fixed' : '(b/c) reject-or-clean'}; E2E artifacts: ${home}`);
  });
});
