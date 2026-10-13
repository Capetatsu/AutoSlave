/**
 * Phase 4 contract tests against real git + real OpenCode sessions.
 * T1: two concurrent writers in separate worktrees do not interfere.
 * T2: full loop in a coder worktree → APPROVED → controlled merge to main.
 * T3: unrecoverable states escalate safely (bogus session, dead server).
 * T4: SIGKILL mid-loop, then resume from files with no duplicates.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { OpenCodeAdapter } from '../src/adapter/adapter.js';
import { discoverConnection, setConnection } from '../src/adapter/client.js';
import { AgentRegistry } from '../src/registry/registry.js';
import { StateStore } from '../src/store/store.js';
import { WorkflowEngine } from '../src/workflow/engine.js';
import { createWorktree, removeWorktree } from '../src/git/worktrees.js';

let available = false;
before(async () => {
  try {
    discoverConnection();
    available = true;
  } catch (e) {
    console.log(`phase-4 contract tests skipped: ${(e as Error).message}`);
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-p4live-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  return dir;
}

function ctx(home: string): { adapter: OpenCodeAdapter; registry: AgentRegistry; store: StateStore; engine: WorkflowEngine } {
  const adapter = new OpenCodeAdapter({ logPath: path.join(home, 'raw.log') });
  const registry = new AgentRegistry(path.join(home, 'registry.json'));
  const store = new StateStore(home);
  return { adapter, registry, store, engine: new WorkflowEngine({ adapter, registry, store }) };
}

describe('phase-4 live', () => {
  it('T1: concurrent writers in separate worktrees do not interfere', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    const home = `${repo}-home`;
    const { adapter } = ctx(home);
    const wa = createWorktree(repo, 'autoslave/w1', 'w1');
    const wb = createWorktree(repo, 'autoslave/w2', 'w2');
    const sa = await adapter.createSession({ title: 'p4-w1', location: { directory: wa.path } });
    const sb = await adapter.createSession({ title: 'p4-w2', location: { directory: wb.path } });
    const since = Date.now();
    // Concurrent prompts, matching delivery observed in Phase 0 (Q21).
    await Promise.all([
      adapter.sendTask(sa.id, 'Create file writer-one.txt containing ONE. Nothing else. No shell.'),
      adapter.sendTask(sb.id, 'Create file writer-two.txt containing TWO. Nothing else. No shell.'),
    ]);
    const [ta, tb] = await Promise.all([
      adapter.waitForTurn(sa.id, since, 180000),
      adapter.waitForTurn(sb.id, since, 180000),
    ]);
    assert.equal(ta.outcome, 'succeeded');
    assert.equal(tb.outcome, 'succeeded');
    assert.equal(fs.existsSync(path.join(wa.path, 'writer-one.txt')), true);
    assert.equal(fs.existsSync(path.join(wb.path, 'writer-two.txt')), true);
    assert.equal(fs.existsSync(path.join(wa.path, 'writer-two.txt')), false, 'no cross-contamination A');
    assert.equal(fs.existsSync(path.join(wb.path, 'writer-one.txt')), false, 'no cross-contamination B');
    assert.equal(fs.existsSync(path.join(repo, 'writer-one.txt')), false, 'main checkout untouched');
    removeWorktree(repo, wa.path, true);
    removeWorktree(repo, wb.path, true);
  });

  it('T2: loop in coder worktree approves and merges to main', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    const repo = initRepo();
    const plan = '# Plan\n1. `add(a, b)` in mathutil.js must have a JSDoc comment.\n2. `add(a, b)` must return the exact sum a + b.\n3. `isAdult(age)` in validator.js must return true for age >= 18.\n';
    fs.writeFileSync(path.join(repo, 'plan.md'), plan);
    fs.writeFileSync(path.join(repo, 'mathutil.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
    fs.writeFileSync(path.join(repo, 'validator.js'), 'function isAdult(age) {\n  return age > 18;\n}\nmodule.exports = { isAdult };\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'fixture']);
    const target = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const home = `${repo}-home`;
    const { adapter, registry, store, engine } = ctx(home);

    const wt = createWorktree(repo, 'autoslave/p4t2', 'p4t2');
    const coderSession = await adapter.createSession({ title: 'p4t2-coder', location: { directory: wt.path } });
    // Reviewer stays in the repo root (outside the coder worktree) with a
    // deny-write second layer; verdicts must still work.
    const reviewerSession = await adapter.createSession({
      title: 'p4t2-reviewer',
      location: { directory: repo },
      permissions: [{ action: 'write', resource: '*', effect: 'deny' }],
    });
    await adapter.setModel(reviewerSession.id, { id: 'mimo-v2.6-flash-free', providerID: 'opencode' });
    const coder = registry.add({ role: 'coder', sessionId: coderSession.id, serverUrl: '', workdir: wt.path });
    const reviewer = registry.add({ role: 'reviewer', sessionId: reviewerSession.id, serverUrl: '', workdir: repo });
    const task = engine.createTask({
      objective: 'Document add() in mathutil.js with JSDoc per plan items 1-2. Do not change any logic. Do not touch any other file.',
      reviewObjective: 'Implement all of plan.md.',
      planExcerpt: plan,
      coderAgentId: coder.id,
      reviewerAgentId: reviewer.id,
      workdir: wt.path,
      reviewFiles: ['validator.js'],
      worktree: { repoRoot: repo, branch: 'autoslave/p4t2', path: wt.path, targetBranch: target, baseSha: wt.baseSha },
      maxIterations: 4,
      coderTimeoutMs: 300000,
      reviewerTimeoutMs: 240000,
    });
    const terminal = await engine.run(task.id);
    const done = store.getTask(task.id);
    const verdicts = store.messagesFor(task.id).filter((m) => m.type === 'review.verdict').map((m) => (m.payload as { status: string }).status);
    console.log(`T2 terminal=${terminal} iterations=${done?.iteration} verdicts=${verdicts.join(',')} home=${home}`);
    assert.equal(terminal, 'APPROVED');
    assert.ok(done?.integration?.sha, 'integration recorded');
    const mainValidator = execFileSync('git', ['show', `${target}:validator.js`], { cwd: repo, encoding: 'utf8' });
    assert.ok(mainValidator.includes('age >= 18'), `target branch lacks the fix:\n${mainValidator}`);
    assert.ok(verdicts.includes('reject') && verdicts[verdicts.length - 1] === 'approve', 'reject→fix→approve cycle');
  });

  it('T3: bogus session and dead server escalate safely', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-p4t3-'));
    const { registry, store, engine } = ctx(home);
    const coder = registry.add({ role: 'coder', sessionId: 'ses_deadbeef0001', serverUrl: '', workdir: os.tmpdir() });
    const reviewer = registry.add({ role: 'reviewer', sessionId: 'ses_deadbeef0002', serverUrl: '', workdir: os.tmpdir() });
    const task = engine.createTask({ objective: 'o', planExcerpt: 'p', coderAgentId: coder.id, reviewerAgentId: reviewer.id, workdir: os.tmpdir() });
    const stale = store.getTask(task.id);
    if (stale) {
      stale.state = 'CODING';
      store.saveTask(stale);
    }
    assert.equal(await engine.resume(task.id), 'ESCALATED');
    assert.match(store.getTask(task.id)?.reason ?? '', /reconcile/);

    // Dead server: point discovery at a closed port, then restore.
    const task2 = engine.createTask({ objective: 'o', planExcerpt: 'p', coderAgentId: coder.id, reviewerAgentId: reviewer.id, workdir: os.tmpdir() });
    const stale2 = store.getTask(task2.id);
    if (stale2) {
      stale2.state = 'CODING';
      store.saveTask(stale2);
    }
    setConnection({ baseUrl: 'http://127.0.0.1:9', authHeader: 'Basic eA==' });
    try {
      assert.equal(await engine.resume(task2.id), 'ESCALATED');
      assert.match(store.getTask(task2.id)?.reason ?? '', /reconcile/);
    } finally {
      setConnection(null);
    }
  });

  it('T4: SIGKILL mid-loop, then resume completes without duplicates', async (t) => {
    if (!available) {
      t.skip('no OpenCode server');
      return;
    }
    const repo = initRepo();
    fs.writeFileSync(path.join(repo, 'plan.md'), '# Plan\n1. mathutil.js add() must have a JSDoc comment.\n');
    fs.writeFileSync(path.join(repo, 'mathutil.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'fixture']);
    const home = `${repo}-home`;
    fs.mkdirSync(home, { recursive: true });
    const { adapter, registry, store } = ctx(home);
    const coderSession = await adapter.createSession({ title: 'p4t4-coder', location: { directory: repo } });
    const reviewerSession = await adapter.createSession({ title: 'p4t4-reviewer', location: { directory: repo } });
    const coder = registry.add({ role: 'coder', sessionId: coderSession.id, serverUrl: '', workdir: repo });
    const reviewer = registry.add({ role: 'reviewer', sessionId: reviewerSession.id, serverUrl: '', workdir: repo });

    const repoRoot = 'D:\\Things\\Work\\Projects\\Agent-Mesh';
    const cli = path.join(repoRoot, 'dist', 'src', 'cli', 'index.js');
    const child = spawn(process.execPath, [cli, 'run', '--task', 'Document add() in mathutil.js with JSDoc per plan.md.', '--plan', path.join(repo, 'plan.md'), '--coder', coder.id, '--reviewer', reviewer.id, '--max-iterations', '3'], {
      cwd: repoRoot,
      env: { ...process.env, AUTOSLAVE_HOME: home },
      stdio: 'ignore',
    });
    // Wait until the first prompt is delivered, then kill mid-turn.
    const auditFile = path.join(home, 'audit.log');
    const t0 = Date.now();
    let sent = false;
    while (Date.now() - t0 < 120000) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        if (fs.readFileSync(auditFile, 'utf8').includes('message.sent') && fs.readFileSync(auditFile, 'utf8').includes('task.assign')) {
          sent = true;
          break;
        }
      } catch {
        /* not written yet */
      }
    }
    assert.equal(sent, true, 'child delivered the first prompt before the kill');
    await new Promise((r) => setTimeout(r, 4000)); // mid-turn window
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(child.exitCode !== 0 || child.signalCode !== null, true, 'child actually died by force');

    // Fresh objects, same files: genuine restart.
    const fresh = ctx(home);
    const tasks = fresh.store.listTasks();
    assert.equal(tasks.length, 1);
    const engine2 = fresh.engine;
    const terminal = await engine2.resume(tasks[0].id);
    const done = fresh.store.getTask(tasks[0].id);
    console.log(`T4 terminal=${terminal} iterations=${done?.iteration} home=${home}`);
    assert.ok(['APPROVED', 'ESCALATED'].includes(terminal), `terminal=${terminal} reason=${done?.reason}`);
    assert.ok(fresh.store.readAudit(tasks[0].id).some((r) => r.kind === 'recover.start'), 'recovery audited');
    // No duplicate operations: each opId delivered at most once per message.
    const opIds = fresh.store.messagesFor(tasks[0].id).map((m) => m.opId).filter(Boolean);
    assert.equal(opIds.length, new Set(opIds).size, `duplicate opIds: ${opIds}`);
    if (terminal === 'APPROVED') {
      assert.ok(fs.readFileSync(path.join(repo, 'mathutil.js'), 'utf8').includes('@param'), 'docs landed');
    }
  });
});
