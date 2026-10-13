/** Mocked workflow engine tests: transitions, routing, retries, caps, escalation. No OpenCode. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from '../src/workflow/engine.js';
import type { EngineAdapter } from '../src/workflow/engine.js';
import { AgentRegistry } from '../src/registry/registry.js';
import { StateStore } from '../src/store/store.js';
import type { StoreData } from '../src/store/store.js';
import type { DiffEntry, TurnResult } from '../src/adapter/types.js';
import {
  buildFeedbackApply,
  buildReviewRequest,
  buildTaskAssign,
  LIMITS,
} from '../src/workflow/packets.js';
import { extractJsonCandidate, parseStructured, validateReport, validateVerdict } from '../src/workflow/types.js';
import type { CompletionReport, Verdict } from '../src/workflow/types.js';

function turn(text: string, outcome: TurnResult['outcome'] = 'succeeded'): TurnResult {
  return { sessionID: 'ses_x', outcome, assistantText: text, idleMessageID: 'm_idle', idleAt: Date.now() };
}

function reportJson(over: Partial<CompletionReport> = {}): string {
  return JSON.stringify({
    status: 'complete',
    summary: 'did the thing',
    filesChanged: ['a.js'],
    commandsRun: [],
    knownGaps: [],
    blockers: [],
    ...over,
  });
}

function rejectJson(next: string[] = ['fix it']): string {
  return JSON.stringify({ status: 'reject', summary: 'broken', issues: [{ id: 'I1', severity: 'high', file: 'a.js', description: 'bad' }], next_actions: next });
}

const APPROVE = JSON.stringify({ status: 'approve', summary: 'looks good' });

class FakeAdapter implements EngineAdapter {
  prompts: Array<{ sessionID: string; text: string }> = [];
  private queues = new Map<string, TurnResult[]>();
  diffs = new Map<string, DiffEntry[]>();
  aborted: string[] = [];

  script(sessionID: string, turns: TurnResult[]): void {
    this.queues.set(sessionID, [...turns]);
  }

  async sendTask(sessionID: string, text: string): Promise<{ id: string }> {
    this.prompts.push({ sessionID, text });
    return { id: `inbox_${this.prompts.length}` };
  }

  async waitForTurn(sessionID: string): Promise<TurnResult> {
    const q = this.queues.get(sessionID);
    const t = q?.shift();
    if (!t) throw new Error(`no scripted turn for ${sessionID}`);
    return t;
  }

  async getDiff(sessionID: string): Promise<DiffEntry[]> {
    return this.diffs.get(sessionID) ?? [];
  }

  async abort(sessionID: string): Promise<boolean> {
    this.aborted.push(sessionID);
    return true;
  }
}

function diffEntry(file: string, patch: string): DiffEntry {
  return { file, patch, additions: 1, deletions: 0, status: 'modified' };
}

let dir: string;
let adapter: FakeAdapter;
let registry: AgentRegistry;
let store: StateStore;
let engine: WorkflowEngine;

const CODER_SES = 'ses_coder';
const REV_SES = 'ses_reviewer';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoslave-wf-'));
  adapter = new FakeAdapter();
  registry = new AgentRegistry(path.join(dir, 'registry.json'));
  store = new StateStore(path.join(dir, 'home'));
  engine = new WorkflowEngine({ adapter, registry, store });
  registry.add({ role: 'coder', sessionId: CODER_SES, serverUrl: 'http://x', workdir: '/w' });
  registry.add({ role: 'reviewer', sessionId: REV_SES, serverUrl: 'http://x', workdir: '/w' });
  const coder = registry.findBySession(CODER_SES);
  const reviewer = registry.findBySession(REV_SES);
  (engine as unknown as { __ids?: unknown }).__ids = { coder: coder?.id, reviewer: reviewer?.id };
});

function ids(): { coder: string; reviewer: string } {
  return {
    coder: registry.findBySession(CODER_SES)?.id as string,
    reviewer: registry.findBySession(REV_SES)?.id as string,
  };
}

function makeTask(over: Record<string, unknown> = {}): string {
  const { coder, reviewer } = ids();
  const t = engine.createTask({
    objective: 'do the thing',
    planExcerpt: 'the plan',
    coderAgentId: coder,
    reviewerAgentId: reviewer,
    workdir: '/w',
    ...over,
  });
  return t.id;
}

describe('happy paths', () => {
  it('approve on first review → APPROVED with full message trail', async () => {
    adapter.script(CODER_SES, [turn('working…'), turn(reportJson())]);
    adapter.script(REV_SES, [turn(APPROVE)]);
    adapter.diffs.set(CODER_SES, [diffEntry('a.js', '+x')]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'APPROVED');
    const task = store.getTask(store.listTasks()[0].id);
    assert.equal(task?.state, 'APPROVED');
    const types = store.messagesFor(task?.id as string).map((m: { type: string }) => m.type);
    assert.deepEqual(types, ['task.assign', 'task.progress', 'task.result', 'review.request', 'review.verdict']);
    // persist-before-delivery: every message has id + delivery record
    for (const m of store.messagesFor(task?.id as string)) {
      assert.match(m.id, /^msg_/);
      assert.equal(m.delivery?.status, 'sent');
    }
    const audit = store.readAudit(task?.id);
    assert.ok(audit.some((r: Record<string, unknown>) => String(r.detail).includes('CODING → REVIEWING')));
    assert.ok(audit.some((r: Record<string, unknown>) => String(r.detail).includes('→ APPROVED')));
  });

  it('reject → fix → approve routes next_actions automatically', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson()), turn('v2 fixed'), turn(reportJson({ summary: 'fixed' }))]);
    adapter.script(REV_SES, [turn(rejectJson(['add the missing check'])), turn(APPROVE)]);
    adapter.diffs.set(CODER_SES, [diffEntry('a.js', '+v1')]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'APPROVED');
    const task = store.getTask(store.listTasks()[0].id);
    assert.equal(task?.iteration, 2);
    const feedback = adapter.prompts.find((p) => p.text.includes('REJECTED'));
    assert.ok(feedback, 'feedback.apply prompt sent to coder');
    assert.ok(feedback?.text.includes('add the missing check'), 'next_actions reach the coder verbatim');
    assert.ok(!feedback || !feedback.text.includes('```'), 'no transcript forwarded');
  });
});

describe('verdict robustness', () => {
  it('invalid verdict → retry once → valid approve', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson())]);
    adapter.script(REV_SES, [turn('looks mostly fine, maybe check things?'), turn(APPROVE)]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'APPROVED');
    assert.ok(adapter.prompts.some((p) => p.text.includes('not a valid verdict')), 'retry prompt sent');
  });

  it('invalid verdict twice → ESCALATED, never approved', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson())]);
    adapter.script(REV_SES, [turn('meh'), turn('still meh')]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'ESCALATED');
    const task = store.getTask(store.listTasks()[0].id);
    assert.match(task?.reason ?? '', /malformed verdict/);
  });

  it('reject without next_actions is invalid → escalate after retry', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson())]);
    const bad = JSON.stringify({ status: 'reject', summary: 'bad', issues: [{ id: 'I1', description: 'x' }], next_actions: [] });
    adapter.script(REV_SES, [turn(bad), turn(bad)]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'ESCALATED');
  });
});

describe('bounds', () => {
  it('iteration limit escalates', async () => {
    adapter.script(CODER_SES, [
      turn('v1'), turn(reportJson()),
      turn('v2'), turn(reportJson()),
    ]);
    // distinct issues + changing diff each round → no stall trip, hits the cap
    adapter.script(REV_SES, [
      turn(rejectJson(['fix A'])),
      turn(JSON.stringify({ status: 'reject', summary: 'still bad', issues: [{ id: 'I2', severity: 'low', file: 'b.js', description: 'other' }], next_actions: ['fix B'] })),
    ]);
    adapter.diffs.set(CODER_SES, [diffEntry('a.js', '+v1')]);
    const id = makeTask({ maxIterations: 2 });
    // change the diff before iteration 2's review so it is not a stall
    const origGetDiff = adapter.getDiff.bind(adapter);
    let calls = 0;
    adapter.getDiff = async (sid: string) => {
      calls++;
      if (sid === CODER_SES && calls > 2) return [diffEntry('a.js', '+v1'), diffEntry('b.js', '+v2')];
      return origGetDiff(sid);
    };
    const terminal = await engine.run(id);
    assert.equal(terminal, 'ESCALATED');
    assert.match(store.getTask(id)?.reason ?? '', /iteration limit/);
  });

  it('same issues with no diff change escalates early as stalled', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson()), turn('v1 again'), turn(reportJson())]);
    adapter.script(REV_SES, [turn(rejectJson(['fix A'])), turn(rejectJson(['fix A']))]);
    adapter.diffs.set(CODER_SES, [diffEntry('a.js', '+same')]);
    const terminal = await engine.run(makeTask({ maxIterations: 5 }));
    assert.equal(terminal, 'ESCALATED');
    assert.match(store.getTask(store.listTasks()[0].id)?.reason ?? '', /stalled/);
  });

  it('coder turn failure escalates', async () => {
    adapter.script(CODER_SES, [turn('boom', 'failed'), turn(reportJson())]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'ESCALATED');
    assert.match(store.getTask(store.listTasks()[0].id)?.reason ?? '', /outcome=failed/);
  });

  it('invalid report twice escalates', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn('not json'), turn('still not json')]);
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'ESCALATED');
    assert.match(store.getTask(store.listTasks()[0].id)?.reason ?? '', /completion report/);
  });

  it('reviewer writes are detected and escalated', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson())]);
    adapter.script(REV_SES, [turn(APPROVE)]);
    // Reviewer diff grows DURING the review turn: clean before, dirty after.
    let revCalls = 0;
    const origGetDiff = adapter.getDiff.bind(adapter);
    adapter.getDiff = async (sid: string) => {
      if (sid === REV_SES) {
        revCalls++;
        return revCalls === 1 ? [] : [diffEntry('evil.js', '+reviewer wrote this')];
      }
      return origGetDiff(sid);
    };
    const terminal = await engine.run(makeTask());
    assert.equal(terminal, 'ESCALATED');
    assert.match(store.getTask(store.listTasks()[0].id)?.reason ?? '', /reviewer modified/);
  });
});

describe('user control', () => {
  it('kill before first send → KILLED with nothing sent', async () => {
    const id = makeTask();
    store.requestControl(id, 'kill');
    const terminal = await engine.run(id);
    assert.equal(terminal, 'KILLED');
    assert.equal(adapter.prompts.length, 0);
  });

  it('pause then resume completes the run', async () => {
    adapter.script(CODER_SES, [turn('v1'), turn(reportJson())]);
    adapter.script(REV_SES, [turn(APPROVE)]);
    const id = makeTask();
    store.requestControl(id, 'pause');
    setTimeout(() => store.requestControl(id, 'resume'), 50);
    const terminal = await engine.run(id);
    assert.equal(terminal, 'APPROVED');
    const audit = store.readAudit(id);
    assert.ok(audit.some((r: Record<string, unknown>) => String(r.detail).includes('→ PAUSED')));
    assert.ok(audit.some((r: Record<string, unknown>) => String(r.detail).includes('resume')));
  });
});

describe('packets and validators', () => {
  it('task assign embeds objective, plan excerpt, workdir', () => {
    const p = buildTaskAssign('build auth', 'plan §3', '/w');
    assert.ok(p.includes('build auth') && p.includes('plan §3') && p.includes('/w'));
  });

  it('packets are capped, never transcripts', () => {
    const big = 'x'.repeat(100000);
    const p = buildReviewRequest({
      objective: 'o',
      planExcerpt: big,
      iteration: 1,
      maxIterations: 5,
      diff: [{ file: 'f', patch: big, additions: 1, deletions: 0, status: 'modified' }],
      report: JSON.parse(reportJson()) as CompletionReport,
    });
    assert.ok(p.length < LIMITS.planExcerpt + LIMITS.diffChars + 6000);
    assert.ok(p.includes('truncated'));
    const fb = buildFeedbackApply('o', big, JSON.parse(rejectJson(['a', 'b'])) as Verdict as Extract<Verdict, { status: 'reject' }>);
    assert.ok(fb.includes('1. a') && fb.includes('2. b'));
  });

  it('extractJsonCandidate handles fences and prose', () => {
    assert.deepEqual(JSON.parse(extractJsonCandidate('```json\n{"a":1}\n```') as string), { a: 1 });
    assert.deepEqual(JSON.parse(extractJsonCandidate('here: {"a":1} thanks') as string), { a: 1 });
    assert.equal(extractJsonCandidate('no json here'), null);
  });

  it('validators accept good, reject bad', () => {
    assert.deepEqual(parseStructured(reportJson(), validateReport).errors, []);
    assert.deepEqual(parseStructured(APPROVE, validateVerdict).errors, []);
    assert.deepEqual(parseStructured(rejectJson(), validateVerdict).errors, []);
    assert.ok(parseStructured('{"status":"reject","summary":"x","issues":[],"next_actions":[]}', validateVerdict).errors.length > 0);
    assert.ok(parseStructured('{"status":"complete"}', validateReport).errors.length > 0);
    assert.ok(parseStructured('nope', validateReport).errors.length > 0);
  });

  it('review packet carries broader objective, coder scope, and extra files', () => {
    const p = buildReviewRequest({
      objective: 'Implement all of plan.md',
      coderScope: 'Document mathutil.js only',
      planExcerpt: 'plan',
      iteration: 1,
      maxIterations: 5,
      diff: [],
      report: JSON.parse(reportJson()) as CompletionReport,
      extraFiles: [{ file: 'validator.js', content: 'return age > 18;' }],
    });
    assert.ok(p.includes('Implement all of plan.md'));
    assert.ok(p.includes("coder's assignment was scoped to: Document mathutil.js only"));
    assert.ok(p.includes('validator.js') && p.includes('age > 18'));
    assert.ok(p.includes('Verify EVERY plan item'));
  });

  it('review files are confined to the workdir', () => {
    const { coder } = ids();
    fs.writeFileSync(path.join(dir, 'ok.js'), 'fine');
    const t = engine.createTask({
      objective: 'o',
      planExcerpt: 'p',
      coderAgentId: coder,
      reviewerAgentId: coder,
      workdir: dir,
      reviewFiles: ['ok.js', '../evil.js', '/abs/evil.js'],
    });
    const files = (engine as unknown as { readReviewFiles: (t: unknown) => Array<{ file: string; content: string }> }).readReviewFiles(t);
    assert.deepEqual(files.map((f) => f.file), ['ok.js']);
    assert.equal(files[0].content, 'fine');
  });
});

describe('store', () => {
  it('persists tasks, messages, audit across instances', () => {
    const id = makeTask();
    const store2 = new StateStore(path.join(dir, 'home'));
    assert.equal(store2.getTask(id)?.objective, 'do the thing');
    store.audit({ task: id, agent: 't', kind: 'k', detail: 'd' });
    const audit2 = new StateStore(path.join(dir, 'home')).readAudit(id);
    assert.equal(audit2.length, 2); // task.created + k
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'home', 'workflows.json'), 'utf8')) as StoreData;
    assert.ok(raw.tasks[id]);
  });
});
