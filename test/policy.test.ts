/** Static policy tests: globs, decisions, model-independence. No OpenCode. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answerPermission,
  checkWriteScope,
  defaultPolicy,
  evaluate,
  loadPolicy,
  matchGlob,
} from '../src/policy/policy.js';

describe('matchGlob', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**', 'a/b/c.js', true],
    ['src/**', 'src/a/b.js', true],
    ['src/**', 'other/a.js', false],
    ['*.js', 'a.js', true],
    ['*.js', 'a/b.js', false],
    ['test/**', 'test/x.test.js', true],
    ['**/*.test.*', 'a/b.test.js', true],
    ['node *', 'node --test', true],
    ['npm test', 'npm test', true],
    ['npm test', 'npm test --watch', false],
    ['npm run test*', 'npm run test:unit', true],
  ];
  for (const [pat, target, want] of cases) {
    it(`${pat} vs ${target} → ${want}`, () => {
      assert.equal(matchGlob(pat, target), want);
    });
  }
});

describe('evaluate', () => {
  const policy = defaultPolicy();
  it('reviewer is read-only', () => {
    assert.equal(evaluate(policy, 'reviewer', { kind: 'read', target: 'src/a.js' }), 'allow');
    assert.equal(evaluate(policy, 'reviewer', { kind: 'write', target: 'src/a.js' }), 'deny');
    assert.equal(evaluate(policy, 'reviewer', { kind: 'write', target: 'notes.md' }), 'deny');
    assert.equal(evaluate(policy, 'reviewer', { kind: 'exec', target: 'node --test' }), 'escalate');
  });
  it('coder writes in scope, exec via allowlist', () => {
    assert.equal(evaluate(policy, 'coder', { kind: 'write', target: 'src/a.js' }), 'allow');
    assert.equal(evaluate(policy, 'coder', { kind: 'exec', target: 'npm test' }), 'allow');
    assert.equal(evaluate(policy, 'coder', { kind: 'exec', target: 'rm -rf /' }), 'escalate');
  });
  it('unknown roles are denied (closed default)', () => {
    assert.equal(evaluate(policy, 'hacker', { kind: 'read', target: 'x' }), 'deny');
  });
});

describe('answerPermission', () => {
  const policy = defaultPolicy();
  it('maps rules to replies; worst wins', () => {
    assert.deepEqual(answerPermission(policy, 'reviewer', { action: 'write', resources: ['a.js'] }), { decision: 'deny', reply: 'reject' });
    assert.deepEqual(answerPermission(policy, 'reviewer', { action: 'read', resources: ['a.js'] }), { decision: 'allow', reply: 'always' });
    assert.deepEqual(answerPermission(policy, 'coder', { action: 'exec', resources: ['rm -rf /'] }), { decision: 'escalate' });
  });
  it('takes no model input by construction', () => {
    // Three parameters only: policy, role, request. There is nowhere to pass
    // model output, so a model can never grant itself permissions.
    assert.equal(answerPermission.length, 3);
  });
});

describe('checkWriteScope', () => {
  it('flags out-of-scope files', () => {
    assert.deepEqual(checkWriteScope(defaultPolicy(), 'reviewer', ['a.js', 'b/c.js']), ['a.js', 'b/c.js']);
    assert.deepEqual(checkWriteScope(defaultPolicy(), 'coder', ['a.js']), []);
  });
});

describe('loadPolicy', () => {
  it('defaults when absent, validates file content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-pol-'));
    assert.equal(loadPolicy(dir).source, 'defaults');
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ roles: { reviewer: { read: ['**'], write: [], exec: [] } } }));
    const loaded = loadPolicy(dir);
    assert.equal(loaded.source, 'file');
    assert.equal(evaluate(loaded.policy, 'reviewer', { kind: 'write', target: 'x' }), 'deny');
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ roles: { reviewer: { read: ['**'] } } }));
    assert.throws(() => loadPolicy(dir), /write/);
  });
});
