/** Mocked gate-rule tests: the three required scenarios + edge cases. No OpenCode. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from '../src/workflow/engine.js';
import type { EngineAdapter } from '../src/workflow/engine.js';
import { AgentRegistry } from '../src/registry/registry.js';
import { StateStore } from '../src/store/store.js';
import type { DiffEntry, TurnResult } from '../src/adapter/types.js';
import type { CheckResult } from '../src/verify/checks.js';

function turn(text: string): TurnResult {
  return { sessionID: 'ses_x', outcome: 'succeeded', assistantText: text, idleMessageID: 'm', idleAt: Date.now() };
}

function reportJson(): string {
  return JSON.stringify({ status: 'complete', summary: 'done', filesChanged: ['a.js'], commandsRun: [], knownGaps: [], blockers: [] });
}

function approveJson(): string {
  return JSON.stringify({ status: 'approve', summary: 'good' });
}

function rejectJson(): string {
  return JSON.stringify({ status: 'reject', summary: 'bad', issues: [{ id: 'I1', severity: 'high', file: 'a.js', description: 'x' }], next_actions: ['fix it'] });
}

function check(name: string, status: CheckResult['status'], required = true): CheckResult {
  return { name, command: `cmd-${name}`, required, status, exitCode: status === 'pass' ? 0 : 1, durationMs: 7, output: `${name} out`, excerpt: `${name} EXCERPT-42`, truncated: false };
}

class FakeAdapter implements EngineAdapter {
  prompts: Array<{ sessionID: string; text: string }> = [];
  private queues = new Map<string, TurnResult[]>();
  script(sessionID: string, turns: TurnResult[]): void {
    this.queues.set(sessionID, [...turns]);
  }
  async sendTask(sessionID: string, text: string): Promise<{ id: string }> {
    this.prompts.push({ sessionID, text });
    return { id: `inbox_${this.prompts.length}` };
  }
  async waitForTurn(sessionID: string): Promise<TurnResult> {
    const t = this.queues.get(sessionID)?.shift();
    if (!t) throw new Error(`no scripted turn for ${sessionID}`);
    return t;
  }
  async getDiff(): Promise<DiffEntry[]> {
    return [];
  }
  async abort(): Promise<boolean> {
    return true;
  }
}

const CODER = 'ses_coder';
const REV = 'ses_rev';
let dir: string;
let adapter: FakeAdapter;
let registry: AgentRegistry;
let store: StateStore;
let checkRuns: CheckResult[][];
let engine: WorkflowEngine;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-gate-'));
  adapter = new FakeAdapter();
  registry = new AgentRegistry(path.join(dir, 'registry.json'));
  store = new StateStore(path.join(dir, 'home'));
  checkRuns = [];
  engine = new WorkflowEngine({
    adapter,
    registry,
    store,
    runChecksFn: async () => {
      const next = checkRuns.shift();
      if (!next) throw new Error('no scripted checks');
      return next;
    },
  });
  registry.add({ role: 'coder', sessionId: CODER, serverUrl: 'http://x', workdir: '/w' });
  registry.add({ role: 'reviewer', sessionId: REV, serverUrl: 'http://x', workdir: '/w' });
});

function ids(): { coder: string; reviewer: string } {
  return {
    coder: registry.findBySession(CODER)?.id as string,
    reviewer: registry.findBySession(REV)?.id as string,
  };
}

function makeTask(): string {
  const { coder, reviewer } = ids();
  return engine.createTask({
    objective: 'o',
    planExcerpt: 'p',
    coderAgentId: coder,
    reviewerAgentId: reviewer,
    workdir: '/w',
    checks: [{ name: 'unit', command: 'node --test', required: true, timeoutMs: 1000 }],
    maxIterations: 4,
  }).id;
}

function coderScript(...texts: string[]): void {
  adapter.script(CODER, texts.map(turn));
}

describe('gate rule scenarios', () => {
  it('(a) checks fail + reviewer approves → blocked, failure routed, then APPROVED', async () => {
    coderScript('v1', reportJson(), 'v2', reportJson());
    adapter.script(REV, [turn(approveJson()), turn(approveJson())]);
    checkRuns = [[check('unit', 'fail')], [check('unit', 'pass')]];

    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'APPROVED');
    const task = store.getTask(store.listTasks()[0].id);
    assert.equal(task?.iteration, 2);
    // The coder's fix prompt carried the failing excerpt (automatic routing).
    const fixPrompt = adapter.prompts.filter((p) => p.sessionID === CODER)[2].text;
    assert.ok(fixPrompt.includes('FAILING CHECKS') && fixPrompt.includes('EXCERPT-42'), fixPrompt.slice(0, 200));
    // Audit shows which signal caused each decision.
    const trail = store.readAudit(task?.id).map((r) => `${r.kind}: ${r.detail}`).join('\n');
    assert.ok(trail.includes('approval.blocked'), 'block attributed to checks');
    assert.ok(trail.includes('review.verdict: approve'), 'approve verdict recorded');
    assert.ok(!trail.includes('→ APPROVED (reviewer approved at iteration 1'), 'never approved while blocked');
  });

  it('(b) checks pass + reviewer rejects → loop continues with checks in packet', async () => {
    coderScript('v1', reportJson(), 'v2', reportJson());
    adapter.script(REV, [turn(rejectJson()), turn(approveJson())]);
    checkRuns = [[check('unit', 'pass')], [check('unit', 'pass')]];

    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'APPROVED');
    assert.equal(store.getTask(store.listTasks()[0].id)?.iteration, 2);
    const reviewPrompt = adapter.prompts.find((p) => p.sessionID === REV)?.text ?? '';
    assert.ok(reviewPrompt.includes('DETERMINISTIC CHECKS') && reviewPrompt.includes('[required] unit: pass'), 'checks in packet');
  });

  it('(c) checks pass + reviewer approves → APPROVED first round', async () => {
    coderScript('v1', reportJson());
    adapter.script(REV, [turn(approveJson())]);
    checkRuns = [[check('unit', 'pass')]];

    assert.equal(await engine.run(makeTask()), 'APPROVED');
    assert.equal(store.getTask(store.listTasks()[0].id)?.iteration, 1);
  });

  it('optional check failure does not block approval', async () => {
    coderScript('v1', reportJson());
    adapter.script(REV, [turn(approveJson())]);
    checkRuns = [[check('unit', 'pass'), check('lint', 'fail', false)]];

    assert.equal(await engine.run(makeTask()), 'APPROVED');
  });

  it('identical failures with no change escalate as stalled, not forever', async () => {
    coderScript('v1', reportJson(), 'v2', reportJson());
    adapter.script(REV, [turn(approveJson()), turn(approveJson())]);
    checkRuns = [[check('unit', 'fail')], [check('unit', 'fail')]];

    const id = makeTask();
    assert.equal(await engine.run(id), 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /repeatedly/);
  });

  it('no checks configured → reviewer-only approval (audited)', async () => {
    const { coder, reviewer } = ids();
    const id = engine.createTask({
      objective: 'o', planExcerpt: 'p', coderAgentId: coder, reviewerAgentId: reviewer, workdir: '/w',
    }).id;
    coderScript('v1', reportJson());
    adapter.script(REV, [turn(approveJson())]);
    // runChecksFn must NOT be called when no checks are configured.
    let called = false;
    (engine as unknown as { deps: { runChecksFn: unknown } }).deps.runChecksFn = async () => {
      called = true;
      return [];
    };
    assert.equal(await engine.run(id), 'APPROVED');
    assert.equal(called, false);
    assert.ok(store.readAudit(id).some((r) => r.kind === 'checks.skipped'));
  });
});
