/** Crash-recovery tests: resume, idempotency, reconcile failures. No OpenCode. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkflowEngine } from '../src/workflow/engine.js';
import type { EngineAdapter } from '../src/workflow/engine.js';
import { AgentRegistry } from '../src/registry/registry.js';
import { StateStore, newId } from '../src/store/store.js';
import type { DiffEntry, TurnResult } from '../src/adapter/types.js';
import type { Task } from '../src/workflow/types.js';

function turn(text: string): TurnResult {
  return { sessionID: 's', outcome: 'succeeded', assistantText: text, idleMessageID: 'm', idleAt: Date.now() };
}
const REPORT = JSON.stringify({ status: 'complete', summary: 'd', filesChanged: ['a.js'], commandsRun: [], knownGaps: [], blockers: [] });
const APPROVE = JSON.stringify({ status: 'approve', summary: 'ok' });
const REJECT = JSON.stringify({ status: 'reject', summary: 'bad', issues: [{ id: 'I1', severity: 'high', file: 'a.js', description: 'x' }], next_actions: ['fix it'] });

class FakeAdapter implements EngineAdapter {
  prompts: Array<{ sessionID: string; text: string }> = [];
  turns = new Map<string, TurnResult[]>();
  history: Array<{ id: string; type: string; time?: { created: number } }> = [];
  sessions = new Set(['ses_c', 'ses_r']);
  serverDown = false;
  permissions = new Map<string, Array<{ id: string; action: string; resources: string[] }>>();
  replies: Array<{ requestID: string; decision: string }> = [];
  aborted: string[] = [];

  script(sid: string, texts: string[]): void {
    this.turns.set(sid, texts.map(turn));
  }
  async sendTask(sessionID: string, text: string): Promise<{ id: string }> {
    this.prompts.push({ sessionID, text });
    return { id: `inbox_${this.prompts.length}` };
  }
  async waitForTurn(sessionID: string): Promise<TurnResult> {
    const t = this.turns.get(sessionID)?.shift();
    if (!t) throw new Error(`no scripted turn for ${sessionID}`);
    return t;
  }
  async getDiff(): Promise<DiffEntry[]> {
    return [];
  }
  async abort(sessionID: string): Promise<boolean> {
    this.aborted.push(sessionID);
    return true;
  }
  async getHistory(): Promise<Array<{ id: string; type: string; time?: { created: number } }>> {
    return this.history;
  }
  async getSession(sessionID: string): Promise<{ tokens?: { input: number; output: number } }> {
    if (this.serverDown) throw new Error('connection refused');
    if (!this.sessions.has(sessionID)) {
      const e = new Error('HTTP 404: session not found') as Error & { status?: number };
      e.status = 404;
      throw e;
    }
    return { tokens: { input: 1, output: 1 } };
  }
  async listPermissions(sessionID: string): Promise<Array<{ id: string; action: string; resources: string[] }>> {
    return this.permissions.get(sessionID) ?? [];
  }
  async replyPermission(_sid: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
    this.replies.push({ requestID, decision });
  }
}

let dir: string;
let adapter: FakeAdapter;
let registry: AgentRegistry;
let store: StateStore;
let engine: WorkflowEngine;
let coderId: string;
let reviewerId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-rec-'));
  adapter = new FakeAdapter();
  registry = new AgentRegistry(path.join(dir, 'registry.json'));
  store = new StateStore(path.join(dir, 'home'));
  engine = new WorkflowEngine({ adapter, registry, store, runChecksFn: async () => [] });
  coderId = registry.add({ role: 'coder', sessionId: 'ses_c', serverUrl: 'http://x', workdir: '/w' }).id;
  reviewerId = registry.add({ role: 'reviewer', sessionId: 'ses_r', serverUrl: 'http://x', workdir: '/w' }).id;
});

function baseTask(over: Partial<Task> = {}): Task {
  return engine.createTask({
    objective: 'o', planExcerpt: 'p', coderAgentId: coderId, reviewerAgentId: reviewerId,
    workdir: '/w', maxIterations: 4, ...over,
  });
}

function feedbackPrompts(): string[] {
  return adapter.prompts.filter((p) => p.sessionID === 'ses_c' && p.text.includes('REJECTED')).map((p) => p.text);
}

describe('resume', () => {
  it('re-drives an interrupted CODING step without duplicating', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'CODING'; // crashed mid-first-turn, nothing persisted
    store.saveTask(t);
    adapter.script('ses_c', ['work', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'APPROVED');
    assert.equal(adapter.prompts.filter((p) => p.text.includes('You are the coder')).length, 1);
  });

  it('reuses delivered feedback whose turn completed (no duplicate send)', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'FIXING';
    t.iteration = 2;
    t.lastVerdict = JSON.parse(REJECT) as Task['lastVerdict'];
    t.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    store.saveTask(t);
    // Pre-crash: feedback delivered AND its turn completed in history.
    store.persistMessage({
      id: newId('msg'), opId: 'i2:feedback', type: 'feedback.apply', taskId: id,
      from: 'autoslave', to: 'coder', iteration: 2, createdAt: new Date(Date.now() - 60000).toISOString(),
      payload: {}, delivery: { status: 'sent', at: new Date().toISOString() },
    });
    adapter.history = [{ id: 'idle1', type: 'idle', time: { created: Date.now() } }];
    adapter.script('ses_c', ['fix work (replayed)', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'APPROVED');
    assert.equal(feedbackPrompts().length, 0, 'delivered feedback must not be resent');
    assert.equal(store.messagesFor(id).filter((m) => m.opId === 'i2:feedback').length, 1);
  });

  it('redelivers on the SAME message when delivery had no result', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'FIXING';
    t.iteration = 2;
    t.lastVerdict = JSON.parse(REJECT) as Task['lastVerdict'];
    t.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    store.saveTask(t);
    store.persistMessage({
      id: newId('msg'), opId: 'i2:feedback', type: 'feedback.apply', taskId: id,
      from: 'autoslave', to: 'coder', iteration: 2, createdAt: new Date(Date.now() - 60000).toISOString(),
      payload: {}, delivery: { status: 'sent', at: new Date().toISOString() },
    });
    adapter.history = []; // crashed mid-turn: nothing completed
    adapter.script('ses_c', ['fix work', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'APPROVED');
    const msgs = store.messagesFor(id).filter((m) => m.opId === 'i2:feedback');
    assert.equal(msgs.length, 1, 'no duplicate message');
    assert.match(msgs[0].delivery?.detail ?? '', /redelivered/);
    assert.equal(feedbackPrompts().length, 1);
  });

  it('FIXING without a persisted verdict escalates honestly', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'FIXING';
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /reconstruct/);
  });

  it('REVIEWING re-reviews with recomputed inputs', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'REVIEWING';
    t.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    store.saveTask(t);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'APPROVED');
  });

  it('terminal tasks are a no-op', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'APPROVED';
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'APPROVED');
    assert.equal(adapter.prompts.length, 0);
  });
});

describe('reconcile failures', () => {
  it('vanished session escalates, never succeeds', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'CODING';
    store.saveTask(t);
    adapter.sessions.delete('ses_c');
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /reconcile/);
    assert.equal(adapter.prompts.length, 0);
  });

  it('dead server escalates, never succeeds', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'REVIEWING';
    t.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    store.saveTask(t);
    adapter.serverDown = true;
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /reconcile/);
  });

  it('missing worktree branch escalates', async () => {
    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'CODING';
    t.worktree = { repoRoot: dir, branch: 'autoslave/gone', path: dir, targetBranch: 'main', baseSha: 'x' };
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /worktree/);
  });
});

describe('budgets and integration', () => {
  it('expired time budget escalates on resume', async () => {
    const id = baseTask({ timeBudgetMs: 1000 }).id;
    const t = store.getTask(id) as Task;
    t.state = 'CODING';
    t.startedAt = new Date(Date.now() - 3600000).toISOString();
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /time budget/);
    assert.equal(adapter.prompts.length, 0);
  });

  it('approved work integrates once; second pass skips as duplicate', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-int-'));
    const git = (args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'v1\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    git(['checkout', '-q', '-b', 'autoslave/x']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'v2\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'coder work']);
    git(['checkout', '-q', 'main']);

    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.worktree = { repoRoot: repo, branch: 'autoslave/x', path: repo, targetBranch: 'main', baseSha: 'x' };
    store.saveTask(t);
    adapter.script('ses_c', ['w', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    // First run integrates (CODING fresh task).
    const t2 = store.getTask(id) as Task;
    t2.state = 'CODING';
    store.saveTask(t2);
    assert.equal(await engine.resume(id), 'APPROVED');
    const after = store.getTask(id) as Task;
    assert.ok(after.integration?.sha, 'integration recorded');
    const mainContent = execFileSync('git', ['show', 'main:f.txt'], { cwd: repo, encoding: 'utf8' }).replace(/\r\n/g, '\n');
    assert.equal(mainContent, 'v2\n');
    // Approve-path again with integration set → skipped duplicate, still APPROVED.
    after.state = 'REVIEWING';
    after.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    store.saveTask(after);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'APPROVED');
    assert.ok(store.readAudit(id).some((r) => r.kind === 'integration.skipped-duplicate'));
  });

  it('merge conflict escalates with source preserved', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-int-'));
    const git = (args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    git(['checkout', '-q', '-b', 'autoslave/y']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'theirs\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'coder']);
    git(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'ours\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'ours']);

    const id = baseTask().id;
    const t = store.getTask(id) as Task;
    t.state = 'REVIEWING';
    t.lastReport = JSON.parse(REPORT) as Task['lastReport'];
    t.worktree = { repoRoot: repo, branch: 'autoslave/y', path: repo, targetBranch: 'main', baseSha: 'x' };
    store.saveTask(t);
    adapter.script('ses_r', [APPROVE]);
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /merge conflict/);
    const mainContent = execFileSync('git', ['show', 'main:f.txt'], { cwd: repo, encoding: 'utf8' }).replace(/\r\n/g, '\n');
    assert.equal(mainContent, 'ours\n', 'target untouched');
  });
});

describe('permission sweep', () => {
  it('reviewer write request is denied, replied, and audited', async () => {
    const id = baseTask().id;
    adapter.permissions.set('ses_r', [{ id: 'p1', action: 'write', resources: ['evil.js'] }]);
    adapter.script('ses_c', ['w', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    const t = store.getTask(id) as Task;
    t.state = 'CODING';
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'APPROVED');
    assert.deepEqual(adapter.replies, [{ requestID: 'p1', decision: 'reject' }]);
    assert.ok(store.readAudit(id).some((r) => r.kind === 'permission.deny'));
  });

  it('escalate-decision request stops the task', async () => {
    const id = baseTask().id;
    adapter.permissions.set('ses_r', [{ id: 'p2', action: 'exec', resources: ['rm -rf /'] }]);
    adapter.script('ses_c', ['w', REPORT]);
    adapter.script('ses_r', [APPROVE]);
    const t = store.getTask(id) as Task;
    t.state = 'CODING';
    store.saveTask(t);
    assert.equal(await engine.resume(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /permission requires human/);
    assert.equal(adapter.replies.length, 0, 'escalated requests are left pending, never auto-answered');
  });
});
