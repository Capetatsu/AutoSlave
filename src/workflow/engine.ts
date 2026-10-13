/**
 * WorkflowEngine — the minimal Coder ↔ Reviewer state machine (Phase 2).
 *
 * CREATED → CODING → REVIEWING → (approve) → APPROVED
 *                              → (reject) → FIXING → REVIEWING → …
 * any state → ESCALATED | PAUSED | KILLED
 *
 * Rules enforced here, never by a model:
 * - completion = terminal turn + history reconcile (adapter) + valid report;
 * - verdicts are parsed + schema-validated; retry once, then escalate;
 * - reject without next_actions is invalid; iterations are capped;
 * - reviewer writes are detected via the reviewer's session diff → escalate;
 * - messages persist before delivery; every transition is audit-logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DiffEntry, TurnResult } from '../adapter/types.js';
import type { AgentRegistry } from '../registry/registry.js';
import { StateStore, newId } from '../store/store.js';
import type { ControlAction } from '../store/store.js';
import {
  buildChecksFeedback,
  buildFeedbackApply,
  buildReportRequest,
  buildReviewRequest,
  buildTaskAssign,
  buildVerdictRetry,
} from './packets.js';
import { auditSummary, runChecks } from '../verify/checks.js';
import type { CheckDef, CheckResult } from '../verify/checks.js';
import type {
  BusMessage,
  CompletionReport,
  MessageType,
  Task,
  TaskState,
  Verdict,
} from './types.js';
import { parseStructured, validateReport, validateVerdict } from './types.js';

/** Minimal adapter surface the engine needs (OpenCodeAdapter satisfies this). */
export interface EngineAdapter {
  sendTask(sessionID: string, text: string): Promise<{ id: string }>;
  waitForTurn(sessionID: string, since: number, timeoutMs: number): Promise<TurnResult>;
  getDiff(sessionID: string): Promise<DiffEntry[]>;
  abort(sessionID: string): Promise<boolean>;
}

export interface EngineDeps {
  adapter: EngineAdapter;
  registry: AgentRegistry;
  store: StateStore;
  sleepMs?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to the real verification runner. */
  runChecksFn?: (workdir: string, checks: CheckDef[]) => Promise<CheckResult[]>;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function diffFingerprint(diff: DiffEntry[]): string {
  return hashStr(diff.map((d) => `${d.file}:${d.status}:${d.additions}:${d.deletions}:${d.patch.length}`).join('|'));
}

function checksFingerprint(checks: CheckResult[]): string {
  return hashStr(checks.map((c) => `${c.name}:${c.status}:${c.exitCode ?? 'n/a'}`).join('|'));
}

export class WorkflowEngine {
  private sleep: (ms: number) => Promise<void>;

  constructor(private deps: EngineDeps) {
    this.sleep = deps.sleepMs ?? sleepDefault;
  }

  private get store(): StateStore {
    return this.deps.store;
  }

  private audit(task: Task, agent: string, kind: string, detail: string): void {
    this.store.audit({ task: task.id, agent, kind, detail });
  }

  private transition(task: Task, to: TaskState, cause: string): void {
    const from = task.state;
    task.state = to;
    this.store.saveTask(task);
    this.audit(task, 'autoslave', 'transition', `${from} → ${to} (${cause})`);
  }

  private escalate(task: Task, reason: string, detail = ''): TaskState {
    task.reason = detail ? `${reason} — ${detail}` : reason;
    this.store.persistMessage({
      id: newId('msg'),
      type: 'workflow.escalate',
      taskId: task.id,
      from: 'autoslave',
      to: 'user',
      iteration: task.iteration,
      createdAt: new Date().toISOString(),
      payload: { reason, detail },
      delivery: { status: 'sent', at: new Date().toISOString() },
    });
    this.transition(task, 'ESCALATED', reason);
    return task.state;
  }

  /** Persist first, then deliver via the adapter; record the outcome. */
  private async sendMessage(
    task: Task,
    type: MessageType,
    from: string,
    toSessionID: string,
    to: string,
    prompt: string,
    payload: Record<string, unknown>,
  ): Promise<BusMessage> {
    const msg: BusMessage = {
      id: newId('msg'),
      type,
      taskId: task.id,
      from,
      to,
      iteration: task.iteration,
      createdAt: new Date().toISOString(),
      payload,
    };
    this.store.persistMessage(msg);
    this.audit(task, 'autoslave', 'message.persisted', `${type} ${msg.id} → ${to}`);
    try {
      const receipt = await this.deps.adapter.sendTask(toSessionID, prompt);
      this.store.markDelivered(msg.id, 'sent', `inbox=${receipt.id}`);
      this.audit(task, 'autoslave', 'message.sent', `${type} ${msg.id} → ${to} (inbox ${receipt.id}, ${prompt.length} chars)`);
    } catch (e) {
      this.store.markDelivered(msg.id, 'failed', (e as Error).message);
      this.audit(task, 'autoslave', 'message.failed', `${type} ${msg.id} → ${to}: ${(e as Error).message}`);
      throw e;
    }
    return msg;
  }

  private agentOf(task: Task, agentId: string): { sessionId: string; role: string } {
    const rec = this.deps.registry.get(agentId);
    if (!rec) throw new Error(`unknown agent: ${agentId}`);
    return { sessionId: rec.sessionId, role: rec.role };
  }

  /** Consume pending control requests. Returns true when the run must stop. */
  private async handleControl(task: Task, inFlightSession?: string): Promise<'run' | 'stopped'> {
    const action: ControlAction | null = this.store.takeControl(task.id);
    if (action === 'kill') {
      if (inFlightSession) {
        try {
          await this.deps.adapter.abort(inFlightSession);
        } catch {
          /* already finished */
        }
      }
      this.transition(task, 'KILLED', 'user requested kill');
      return 'stopped';
    }
    if (action === 'pause') {
      task.resumeState = task.state;
      this.transition(task, 'PAUSED', 'user requested pause');
      for (;;) {
        await this.sleep(2000);
        const next = this.store.takeControl(task.id);
        if (next === 'kill') {
          this.transition(task, 'KILLED', 'user requested kill while paused');
          return 'stopped';
        }
        if (next === 'resume') {
          this.transition(task, task.resumeState ?? 'CODING', 'user requested resume');
          return 'run';
        }
      }
    }
    return 'run';
  }

  /** One coder turn: run the prompt, then obtain a valid completion report. */
  private async coderTurn(
    task: Task,
    coderSession: string,
    prompt: string,
    messageType: 'task.assign' | 'feedback.apply',
    toLabel: string,
  ): Promise<{ report: CompletionReport; diff: DiffEntry[] } | null> {
    if ((await this.handleControl(task)) === 'stopped') return null;
    await this.sendMessage(task, messageType, 'autoslave', coderSession, toLabel, prompt, {
      chars: prompt.length,
    });
    this.deps.registry.setStatus(task.coderAgentId, 'working');

    const since = Date.now();
    let turn: TurnResult;
    try {
      turn = await this.deps.adapter.waitForTurn(coderSession, since, task.coderTimeoutMs);
    } catch (e) {
      this.deps.registry.setStatus(task.coderAgentId, 'error');
      this.escalate(task, `coder turn failed: ${(e as Error).message}`);
      return null;
    }
    if ((await this.handleControl(task, coderSession)) === 'stopped') return null;
    if (turn.outcome !== 'succeeded') {
      this.deps.registry.setStatus(task.coderAgentId, 'error');
      this.escalate(task, `coder turn outcome=${turn.outcome}`, 'idle without success is not completion');
      return null;
    }
    this.audit(task, 'coder', 'turn.done', `outcome=succeeded model=${turn.model?.id ?? '?'} chars=${turn.assistantText.length}`);
    // Diff for the WORK turn, captured before the report round: session.diff
    // defaults to the newest user message's turn, so fetching after the report
    // request would attribute an empty window.
    const diffWork = await this.deps.adapter.getDiff(coderSession);

    // Completion report: request, validate, one reminder, else escalate (FEATURES F7).
    let reportText = await this.reportRound(task, coderSession, toLabel, buildReportRequest());
    if (!reportText) return null;
    let parsed = parseStructured<CompletionReport>(reportText, validateReport);
    if (parsed.errors.length > 0) {
      this.audit(task, 'autoslave', 'report.invalid', parsed.errors.join('; '));
      reportText = await this.reportRound(task, coderSession, toLabel, buildReportRequest(parsed.errors));
      if (!reportText) return null;
      parsed = parseStructured<CompletionReport>(reportText, validateReport);
      if (parsed.errors.length > 0) {
        this.escalate(task, 'invalid completion report (retry exhausted)', parsed.errors.join('; '));
        return null;
      }
    }
    const report = parsed.value as CompletionReport;
    if (report.status === 'blocked' && report.blockers.length > 0) {
      this.audit(task, 'coder', 'report.blocked', report.blockers.join('; '));
    }
    this.deps.registry.setStatus(task.coderAgentId, 'idle');
    if (turn.model) {
      const rec = this.deps.registry.get(task.coderAgentId);
      if (rec && !rec.model) {
        this.deps.registry.setModel(task.coderAgentId, `${turn.model.providerID}/${turn.model.id}`);
      }
    }
    const diff = await this.deps.adapter.getDiff(coderSession);
    const merged = new Map(diffWork.map((d) => [d.file, d]));
    for (const d of diff) merged.set(d.file, d);
    const fullDiff = [...merged.values()];
    this.store.persistMessage({
      id: newId('msg'),
      type: 'task.result',
      taskId: task.id,
      from: toLabel,
      to: 'autoslave',
      iteration: task.iteration,
      createdAt: new Date().toISOString(),
      payload: { report, diffFiles: fullDiff.map((d) => d.file), outcome: turn.outcome },
      delivery: { status: 'sent', at: new Date().toISOString() },
    });
    this.audit(task, 'coder', 'message.received', `task.result: ${report.status} files=[${report.filesChanged.join(',')}] diffEntries=${fullDiff.length}`);
    task.lastReport = report;
    this.store.saveTask(task);
    return { report, diff: fullDiff };
  }

  /** Helper: one report-request round (send + wait). Null when the run stopped. */
  private readReviewFiles(task: Task): Array<{ file: string; content: string }> {
    const out: Array<{ file: string; content: string }> = [];
    for (const rel of (task.reviewFiles ?? []).slice(0, 3)) {
      try {
        // Confine to the workdir: reject absolute paths and parent traversal.
        const full = path.resolve(task.workdir, rel);
        if (full !== task.workdir && !full.startsWith(task.workdir + path.sep)) continue;
        out.push({ file: rel, content: fs.readFileSync(full, 'utf8') });
      } catch {
        out.push({ file: rel, content: '(unreadable — file may not exist)' });
      }
    }
    return out;
  }

  /** Helper: one report-request round (send + wait). Null when the run stopped. */  private async reportRound(task: Task, coderSession: string, toLabel: string, prompt: string): Promise<string | null> {
    if ((await this.handleControl(task)) === 'stopped') return null;
    await this.sendMessage(task, 'task.progress', 'autoslave', coderSession, toLabel, prompt, { kind: 'report-request' });
    const since = Date.now();
    try {
      const turn = await this.deps.adapter.waitForTurn(coderSession, since, task.coderTimeoutMs);
      if ((await this.handleControl(task, coderSession)) === 'stopped') return null;
      return turn.assistantText;
    } catch (e) {
      this.escalate(task, `completion-report turn failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** One reviewer turn: send packet, parse + validate verdict (retry once). */
  private async reviewerTurn(
    task: Task,
    reviewerSession: string,
    toLabel: string,
    diff: DiffEntry[],
    checks: CheckResult[],
  ): Promise<Verdict | null> {
    if ((await this.handleControl(task)) === 'stopped') return null;
    const diffBefore = (await this.deps.adapter.getDiff(reviewerSession)).length;
    const extraFiles = this.readReviewFiles(task);
    const prompt = buildReviewRequest({
      objective: task.reviewObjective ?? task.objective,
      coderScope: task.reviewObjective ? task.objective : undefined,
      planExcerpt: task.planExcerpt,
      iteration: task.iteration,
      maxIterations: task.maxIterations,
      diff,
      report: task.lastReport as CompletionReport,
      previousVerdict: task.lastVerdict,
      extraFiles,
      checks,
    });
    await this.sendMessage(task, 'review.request', 'autoslave', reviewerSession, toLabel, prompt, {
      iteration: task.iteration,
      diffFiles: diff.map((d) => d.file),
      chars: prompt.length,
    });
    this.deps.registry.setStatus(task.reviewerAgentId, 'working');

    const since = Date.now();
    let turn: TurnResult;
    try {
      turn = await this.deps.adapter.waitForTurn(reviewerSession, since, task.reviewerTimeoutMs);
    } catch (e) {
      this.deps.registry.setStatus(task.reviewerAgentId, 'error');
      this.escalate(task, `reviewer turn failed: ${(e as Error).message}`);
      return null;
    }
    if ((await this.handleControl(task, reviewerSession)) === 'stopped') return null;
    if (turn.outcome !== 'succeeded') {
      this.deps.registry.setStatus(task.reviewerAgentId, 'error');
      this.escalate(task, `reviewer turn outcome=${turn.outcome}`, turn.assistantText.slice(0, 300));
      return null;
    }
    this.deps.registry.setStatus(task.reviewerAgentId, 'idle');
    if (turn.model) {
      const rec = this.deps.registry.get(task.reviewerAgentId);
      if (rec && !rec.model) {
        this.deps.registry.setModel(task.reviewerAgentId, `${turn.model.providerID}/${turn.model.id}`);
      }
    }

    // Reviewer-write detection (D7): the reviewer must not modify the project.
    const diffAfter = (await this.deps.adapter.getDiff(reviewerSession)).length;
    if (diffAfter > diffBefore) {
      this.escalate(task, 'reviewer modified project files', `reviewer diff entries ${diffBefore} → ${diffAfter}; reviewer is read-only in the MVP`);
      return null;
    }

    let parsed = parseStructured<Verdict>(turn.assistantText, validateVerdict);
    if (parsed.errors.length > 0) {
      this.audit(task, 'autoslave', 'verdict.invalid', `${parsed.errors.join('; ')} | raw head: ${turn.assistantText.slice(0, 160)}`);
      if ((await this.handleControl(task)) === 'stopped') return null;
      await this.sendMessage(task, 'task.progress', 'autoslave', reviewerSession, toLabel, buildVerdictRetry(parsed.errors), {
        kind: 'verdict-retry',
      });
      const since2 = Date.now();
      try {
        const retry = await this.deps.adapter.waitForTurn(reviewerSession, since2, task.reviewerTimeoutMs);
        if ((await this.handleControl(task, reviewerSession)) === 'stopped') return null;
        parsed = parseStructured<Verdict>(retry.assistantText, validateVerdict);
      } catch (e) {
        this.escalate(task, `verdict-retry turn failed: ${(e as Error).message}`);
        return null;
      }
      if (parsed.errors.length > 0) {
        this.escalate(task, 'malformed verdict (retry exhausted)', parsed.errors.join('; '));
        return null;
      }
    }
    const verdict = parsed.value as Verdict;
    this.store.persistMessage({
      id: newId('msg'),
      type: 'review.verdict',
      taskId: task.id,
      from: toLabel,
      to: 'autoslave',
      iteration: task.iteration,
      createdAt: new Date().toISOString(),
      payload: verdict as unknown as Record<string, unknown>,
      delivery: { status: 'sent', at: new Date().toISOString() },
    });
    this.audit(task, 'reviewer', 'message.received', `review.verdict: ${verdict.status} — ${verdict.summary.slice(0, 200)}`);
    task.lastVerdict = verdict;
    this.store.saveTask(task);
    return verdict;
  }

  /**
   * Run deterministic checks after a coder result. Results are stored on the
   * task, audit-logged, and returned for the review packet. Checks run to
   * completion once started (each is time-bounded); control requests apply at
   * the next checkpoint.
   */
  private async runVerification(task: Task): Promise<CheckResult[]> {
    const checks = task.checks ?? [];
    if (checks.length === 0) {
      this.audit(task, 'autoslave', 'checks.skipped', 'no verification checks configured (reviewer judgement only)');
      task.lastChecks = [];
      this.store.saveTask(task);
      return [];
    }
    const runFn = this.deps.runChecksFn ?? runChecks;
    const results = await runFn(task.workdir, checks);
    task.lastChecks = results;
    this.store.saveTask(task);
    this.audit(task, 'autoslave', 'checks.done', auditSummary(results));
    const failed = results.filter((r) => r.status !== 'pass');
    if (failed.length > 0) {
      this.audit(
        task,
        'autoslave',
        'checks.failed',
        failed.map((r) => `${r.name}=${r.status}: ${r.excerpt.slice(0, 500)}`).join(' | '),
      );
    }
    return results;
  }

  /** Unified loop-health: true when nothing changed since the last iteration. */
  private trackProgress(task: Task, key: string): 'progress' | 'stalled' {
    if (task.lastProgressKey === key) {
      task.stallCount = (task.stallCount ?? 0) + 1;
    } else {
      task.stallCount = 0;
      task.lastProgressKey = key;
    }
    this.store.saveTask(task);
    return (task.stallCount ?? 0) >= 1 ? 'stalled' : 'progress';
  }

  /** Shared cap check after a non-approving outcome. Null = may continue. */
  private capReached(task: Task): string | null {
    if (task.iteration >= task.maxIterations) {
      return `iteration limit reached (${task.iteration}/${task.maxIterations})`;
    }
    return null;
  }

  /**
   * Run the full loop for a task in state CREATED. Returns the terminal state.
   * The caller creates the task via `createTask`.
   */
  async run(taskId: string): Promise<TaskState> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state !== 'CREATED') throw new Error(`task ${taskId} is ${task.state}, only CREATED can run`);
    const coder = this.agentOf(task, task.coderAgentId);
    const reviewer = this.agentOf(task, task.reviewerAgentId);
    const coderLabel = `coder:${task.coderAgentId}`;
    const reviewerLabel = `reviewer:${task.reviewerAgentId}`;
    this.audit(task, 'autoslave', 'run.start', `objective="${task.objective}" coder=${coder.sessionId} reviewer=${reviewer.sessionId}`);

    // CODING (first pass).
    this.transition(task, 'CODING', 'task created');
    let first = await this.coderTurn(task, coder.sessionId, buildTaskAssign(task.objective, task.planExcerpt, task.workdir), 'task.assign', coderLabel);
    if (!first) return task.state;
    let diff = first.diff;

    for (;;) {
      // Verification runs after every coder result so the reviewer sees facts.
      const checks = await this.runVerification(task);
      // REVIEWING.
      this.transition(task, 'REVIEWING', `iteration ${task.iteration}: requesting review`);
      const verdict = await this.reviewerTurn(task, reviewer.sessionId, reviewerLabel, diff, checks);
      if (!verdict) return task.state;

      if (verdict.status === 'approve') {
        const failedRequired = checks.filter((c) => c.required && c.status !== 'pass');
        if (failedRequired.length === 0) {
          this.transition(
            task,
            'APPROVED',
            `reviewer approved at iteration ${task.iteration}; checks: ${checks.length > 0 ? auditSummary(checks) : 'none configured'}`,
          );
          return task.state;
        }
        // Gate rule (FEATURES §3.5): required checks veto an approval.
        const names = failedRequired.map((c) => `${c.name}=${c.status}`).join(', ');
        this.audit(task, 'autoslave', 'approval.blocked', `reviewer approved but required checks failed: ${names}`);
        if (this.trackProgress(task, `B:${checksFingerprint(checks)}:${diffFingerprint(diff)}`) === 'stalled') {
          this.escalate(task, 'checks failing repeatedly', `same failures with no change: ${names}`);
          return task.state;
        }
        const cap = this.capReached(task);
        if (cap) {
          this.escalate(task, cap, `blocked by failing checks: ${names}`);
          return task.state;
        }
        task.iteration += 1;
        this.transition(task, 'FIXING', `approval blocked by checks (${names}), iteration ${task.iteration}/${task.maxIterations}`);
        const fixed = await this.coderTurn(
          task,
          coder.sessionId,
          buildChecksFeedback(task.objective, failedRequired),
          'feedback.apply',
          coderLabel,
        );
        if (!fixed) return task.state;
        diff = fixed.diff;
        continue;
      }

      // Reject: loop-health + iteration cap, then FIXING.
      const issueIds = [...verdict.issues.map((i) => i.id)].sort().join(',');
      const failures = checks.filter((c) => c.status !== 'pass');
      if (this.trackProgress(task, `R:${issueIds}:${diffFingerprint(diff)}:${checksFingerprint(checks)}`) === 'stalled') {
        this.escalate(task, 'review loop stalled', 'same issues with no diff change across iterations');
        return task.state;
      }
      const cap = this.capReached(task);
      if (cap) {
        this.escalate(task, cap, `last verdict=reject (${verdict.issues.length} issues)`);
        return task.state;
      }
      task.iteration += 1;
      this.transition(task, 'FIXING', `verdict=reject (${verdict.issues.length} issues), iteration ${task.iteration}/${task.maxIterations}`);
      const fixed = await this.coderTurn(
        task,
        coder.sessionId,
        buildFeedbackApply(task.objective, task.planExcerpt, verdict, failures),
        'feedback.apply',
        coderLabel,
      );
      if (!fixed) return task.state;
      diff = fixed.diff;
    }
  }

  /** Create a task in state CREATED (does not run it). */
  createTask(args: {
    objective: string;
    planExcerpt: string;
    planPath?: string;
    coderAgentId: string;
    reviewerAgentId: string;
    workdir: string;
    reviewFiles?: string[];
    reviewObjective?: string;
    checks?: CheckDef[];
    maxIterations?: number;
    coderTimeoutMs?: number;
    reviewerTimeoutMs?: number;
  }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: newId('task'),
      state: 'CREATED',
      iteration: 1,
      maxIterations: args.maxIterations ?? 5,
      coderTimeoutMs: args.coderTimeoutMs ?? 600000,
      reviewerTimeoutMs: args.reviewerTimeoutMs ?? 300000,
      createdAt: now,
      updatedAt: now,
      objective: args.objective,
      planExcerpt: args.planExcerpt,
      planPath: args.planPath,
      coderAgentId: args.coderAgentId,
      reviewerAgentId: args.reviewerAgentId,
      workdir: args.workdir,
      reviewFiles: args.reviewFiles ?? [],
      reviewObjective: args.reviewObjective,
      checks: args.checks ?? [],
    };
    this.store.saveTask(task);
    this.audit(task, 'autoslave', 'task.created', `objective="${task.objective}" maxIterations=${task.maxIterations}`);
    return task;
  }
}
