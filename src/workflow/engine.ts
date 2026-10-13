/**
 * WorkflowEngine — Coder ↔ Reviewer state machine with deterministic gates,
 * worktree isolation, static policy enforcement, budgets, and crash recovery.
 *
 * CREATED → CODING → REVIEWING → (approve+checks) → APPROVED (+integrate)
 *                              → (reject) → FIXING → REVIEWING → …
 * any state → ESCALATED | PAUSED | KILLED
 *
 * Rules enforced here, never by a model:
 * - completion = terminal turn + history reconcile (adapter) + valid report;
 * - verdicts parsed + schema-validated; retry once, then escalate;
 * - required checks veto approval; failures auto-route with excerpts;
 * - reviewer writes detected via session diff + role write-scope → escalate;
 * - permission requests answered from static policy only (never model text);
 * - integration is idempotent (merge-base) and never overwrites blindly;
 * - every message carries an opId: redelivery after a crash never duplicates;
 * - time budgets bound every run; costs are audited from session tokens.
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
import type {
  BusMessage,
  CompletionReport,
  MessageType,
  Task,
  TaskState,
  Verdict,
} from './types.js';
import { parseStructured, validateReport, validateVerdict } from './types.js';
import { auditSummary, runChecks, ChecksAbortedError } from '../verify/checks.js';
import type { CheckDef, CheckResult } from '../verify/checks.js';
import { answerPermission, defaultPolicy, evaluate } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';
import { branchExists, commitWork, integrate } from '../git/worktrees.js';

/** Minimal adapter surface the engine needs (OpenCodeAdapter satisfies this). */
export interface EngineAdapter {
  sendTask(sessionID: string, text: string): Promise<{ id: string }>;
  waitForTurn(sessionID: string, since: number, timeoutMs: number): Promise<TurnResult>;
  getDiff(sessionID: string): Promise<DiffEntry[]>;
  abort(sessionID: string): Promise<boolean>;
  getHistory(sessionID: string, limit?: number, order?: 'asc' | 'desc'): Promise<Array<{ id: string; type: string; time?: { created: number } }>>;
  getSession(sessionID: string): Promise<{ tokens?: { input: number; output: number } }>;
  listPermissions(sessionID: string): Promise<Array<{ id: string; action: string; resources: string[] }>>;
  replyPermission(sessionID: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void>;
}

export interface EngineDeps {
  adapter: EngineAdapter;
  registry: AgentRegistry;
  store: StateStore;
  sleepMs?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to the real verification runner. */
  runChecksFn?: (workdir: string, checks: CheckDef[], signal?: AbortSignal) => Promise<CheckResult[]>;
  /** Static policy. Defaults to built-in defaults (reviewer read-only). */
  policy?: Policy;
}

export const DEFAULT_TIME_BUDGET_MS = 1800000; // 30 minutes per task

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
  private policy: Policy;

  constructor(private deps: EngineDeps) {
    this.sleep = deps.sleepMs ?? sleepDefault;
    this.policy = deps.policy ?? defaultPolicy();
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

  /** Enter a state, auditing honestly when already there (resume paths). */
  private enterState(task: Task, to: TaskState, cause: string): void {
    if (task.state === to) {
      this.audit(task, 'autoslave', 'transition', `${to} (already there: ${cause})`);
      this.store.saveTask(task);
      return;
    }
    this.transition(task, to, cause);
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
    void this.auditCost(task);
    return task.state;
  }

  /** Best-effort cost accounting from session token usage (audited, never gated). */
  private async auditCost(task: Task): Promise<void> {
    try {
      const coder = this.deps.registry.get(task.coderAgentId);
      const reviewer = this.deps.registry.get(task.reviewerAgentId);
      let input = 0;
      let output = 0;
      for (const sid of [coder?.sessionId, reviewer?.sessionId]) {
        if (!sid) continue;
        const info = await this.deps.adapter.getSession(sid);
        input += info.tokens?.input ?? 0;
        output += info.tokens?.output ?? 0;
      }
      this.audit(task, 'autoslave', 'cost', `tokens input=${input} output=${output}`);
    } catch {
      /* cost is informational only */
    }
  }

  /**
   * Persist first, then deliver. opId makes redelivery idempotent: an already
   * delivered op whose turn completed is reused, never resent; a delivered op
   * with no completed turn is resent on the SAME message (receipt updated).
   */
  private async sendMessage(
    task: Task,
    type: MessageType,
    from: string,
    toSessionID: string,
    to: string,
    prompt: string,
    payload: Record<string, unknown>,
    opId: string,
  ): Promise<BusMessage> {
    const existing = this.store.findByOpId(task.id, opId);
    if (existing?.delivery?.status === 'sent') {
      if (await this.turnCompletedAfter(toSessionID, existing.createdAt)) {
        this.audit(task, 'autoslave', 'message.reused', `${type} ${existing.id} op=${opId} (turn already completed; not resent)`);
        return existing;
      }
      const receipt = await this.deps.adapter.sendTask(toSessionID, prompt);
      this.store.markDelivered(existing.id, 'sent', `inbox=${receipt.id} (redelivered after no-result delivery)`);
      this.audit(task, 'autoslave', 'message.redelivered', `${type} ${existing.id} op=${opId} → ${to} (inbox ${receipt.id})`);
      return existing;
    }
    const msg: BusMessage = {
      id: newId('msg'),
      opId,
      type,
      taskId: task.id,
      from,
      to,
      iteration: task.iteration,
      createdAt: new Date().toISOString(),
      payload,
    };
    this.store.persistMessage(msg);
    this.audit(task, 'autoslave', 'message.persisted', `${type} ${msg.id} op=${opId} → ${to}`);
    try {
      const receipt = await this.deps.adapter.sendTask(toSessionID, prompt);
      this.store.markDelivered(msg.id, 'sent', `inbox=${receipt.id}`);
      this.audit(task, 'autoslave', 'message.sent', `${type} ${msg.id} op=${opId} → ${to} (inbox ${receipt.id}, ${prompt.length} chars)`);
    } catch (e) {
      this.store.markDelivered(msg.id, 'failed', (e as Error).message);
      this.audit(task, 'autoslave', 'message.failed', `${type} ${msg.id} op=${opId} → ${to}: ${(e as Error).message}`);
      throw e;
    }
    return msg;
  }

  /** True when message history shows a terminal idle after the given time. */
  private async turnCompletedAfter(sessionID: string, afterIso: string): Promise<boolean> {
    try {
      const after = Date.parse(afterIso);
      const msgs = await this.deps.adapter.getHistory(sessionID, 10, 'desc');
      return msgs.some((m) => m.type === 'idle' && (m.time?.created ?? 0) > after);
    } catch {
      return false;
    }
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

  /**
   * Answer any pending OpenCode permission requests from static policy.
   * Reviewer write attempts are denied; escalations stop the task. A model's
   * own text is never consulted. Best-effort: an unreachable endpoint is
   * audit-noted, never fatal (live probes show the list is usually empty).
   */
  private async sweepPermissions(task: Task, agentId: string, sessionID: string): Promise<boolean> {
    const rec = this.deps.registry.get(agentId);
    const role = rec?.role ?? 'reviewer';
    let pending: Array<{ id: string; action: string; resources: string[] }>;
    try {
      pending = await this.deps.adapter.listPermissions(sessionID);
    } catch (e) {
      this.audit(task, 'autoslave', 'permission.sweep-skipped', `list endpoint unavailable: ${(e as Error).message}`);
      return true;
    }
    for (const req of pending) {
      const answer = answerPermission(this.policy, role, { action: req.action, resources: req.resources });
      if (answer.decision === 'escalate') {
        this.audit(task, 'autoslave', 'permission.escalated', `${role} ${req.action} [${req.resources.join(', ')}] requires a human decision`);
        this.escalate(task, 'permission requires human decision', `${role} requested ${req.action} on ${req.resources.join(', ')}`);
        return false;
      }
      try {
        await this.deps.adapter.replyPermission(sessionID, req.id, answer.reply as 'always' | 'reject');
        this.audit(task, 'autoslave', `permission.${answer.decision}`, `${role} ${req.action} [${req.resources.join(', ')}] → ${answer.reply} (static policy)`);
      } catch (e) {
        this.audit(task, 'autoslave', 'permission.reply-failed', `${req.id}: ${(e as Error).message}`);
        this.escalate(task, 'permission reply failed', (e as Error).message);
        return false;
      }
    }
    return true;
  }

  /**
   * Post-turn write-scope enforcement: every file changed this turn must sit
   * inside the role's static write scope. Deterministic, model-independent.
   */
  private enforceWriteScope(task: Task, role: string, files: string[], turnLabel: string): boolean {
    const rel = files.map((f) => (path.isAbsolute(f) ? path.relative(task.workdir, f) : f));
    const outside = rel.filter((f) => f.startsWith('..') || path.isAbsolute(f));
    const violations = [
      ...outside.map((f) => `${f} (outside workdir)`),
      ...this.policyFilesViolations(role, rel.filter((f) => !f.startsWith('..') && !path.isAbsolute(f))),
    ];
    if (violations.length > 0) {
      this.audit(task, 'autoslave', 'policy.denied', `${role} ${turnLabel} wrote outside scope: ${violations.join('; ')}`);
      this.escalate(task, `${role} wrote outside permitted scope`, violations.join('; '));
      return false;
    }
    return true;
  }

  private policyFilesViolations(role: string, files: string[]): string[] {
    const out: string[] = [];
    for (const f of files) {
      if (evaluate(this.policy, role, { kind: 'write', target: f }) !== 'allow') out.push(f);
    }
    return out;
  }

  /** One coder turn: run the prompt, then obtain a valid completion report. */
  private async coderTurn(
    task: Task,
    coderSession: string,
    prompt: string,
    messageType: 'task.assign' | 'feedback.apply',
    toLabel: string,
  ): Promise<{ report: CompletionReport; diff: DiffEntry[] } | null> {
    const opBase = `i${task.iteration}:${messageType === 'task.assign' ? 'assign' : 'feedback'}`;
    if ((await this.handleControl(task)) === 'stopped') return null;
    await this.sendMessage(task, messageType, 'autoslave', coderSession, toLabel, prompt, {
      chars: prompt.length,
    }, opBase);
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
    if (!(await this.sweepPermissions(task, task.coderAgentId, coderSession))) return null;
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
    let reportText = await this.reportRound(task, coderSession, toLabel, buildReportRequest(), `${opBase}:report`);
    if (!reportText) return null;
    let parsed = parseStructured<CompletionReport>(reportText, validateReport);
    if (parsed.errors.length > 0) {
      this.audit(task, 'autoslave', 'report.invalid', parsed.errors.join('; '));
      reportText = await this.reportRound(task, coderSession, toLabel, buildReportRequest(parsed.errors), `${opBase}:report-retry`);
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
    if (!this.enforceWriteScope(task, this.agentOf(task, task.coderAgentId).role, fullDiff.map((d) => d.file), 'coder turn')) {
      return null;
    }
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

  /** Helper: one report-request round (send + wait). Null when the run stopped. */
  private async reportRound(task: Task, coderSession: string, toLabel: string, prompt: string, opId: string): Promise<string | null> {
    if ((await this.handleControl(task)) === 'stopped') return null;
    await this.sendMessage(task, 'task.progress', 'autoslave', coderSession, toLabel, prompt, { kind: 'report-request' }, opId);
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
    const opBase = `i${task.iteration}:review`;
    await this.sendMessage(task, 'review.request', 'autoslave', reviewerSession, toLabel, prompt, {
      iteration: task.iteration,
      diffFiles: diff.map((d) => d.file),
      chars: prompt.length,
    }, opBase);
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
    if (!(await this.sweepPermissions(task, task.reviewerAgentId, reviewerSession))) return null;
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

    // Reviewer-write detection (D7, now policy-backed): the reviewer role is
    // read-only, so any growth in its session diff is a policy violation.
    const diffAfterEntries = await this.deps.adapter.getDiff(reviewerSession);
    if (diffAfterEntries.length > diffBefore) {
      const newFiles = diffAfterEntries.map((d) => d.file);
      this.audit(task, 'autoslave', 'policy.denied', `reviewer wrote outside read-only scope: ${newFiles.join(', ')}`);
      this.escalate(task, 'reviewer modified project files', `reviewer diff entries ${diffBefore} → ${diffAfterEntries.length}; reviewer is read-only`);
      return null;
    }

    let parsed = parseStructured<Verdict>(turn.assistantText, validateVerdict);
    if (parsed.errors.length > 0) {
      this.audit(task, 'autoslave', 'verdict.invalid', `${parsed.errors.join('; ')} | raw head: ${turn.assistantText.slice(0, 160)}`);
      if ((await this.handleControl(task)) === 'stopped') return null;
      await this.sendMessage(task, 'task.progress', 'autoslave', reviewerSession, toLabel, buildVerdictRetry(parsed.errors), {
        kind: 'verdict-retry',
      }, `${opBase}-retry`);
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
   * task, audit-logged, and returned for the review packet. A kill request
   * during checks aborts the tree and ends the run as KILLED (never silently).
   */
  private async runVerification(task: Task): Promise<CheckResult[] | null> {
    const checks = task.checks ?? [];
    if (checks.length === 0) {
      this.audit(task, 'autoslave', 'checks.skipped', 'no verification checks configured (reviewer judgement only)');
      task.lastChecks = [];
      this.store.saveTask(task);
      return [];
    }
    const runFn = this.deps.runChecksFn ?? runChecks;
    const ctl = new AbortController();
    let done = false;
    const stopPoll = (): void => {
      done = true;
    };
    const poll = (async (): Promise<void> => {
      while (!done) {
        await this.sleep(1000);
        if (done) return;
        // Peek only: kill aborts the tree now; pause waits for the checkpoint.
        if (this.store.peekControl(task.id) === 'kill') ctl.abort();
      }
    })();
    try {
      const results = await runFn(task.workdir, checks, ctl.signal);
      stopPoll();
      await poll.catch(() => {});
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
    } catch (e) {
      stopPoll();
      await poll.catch(() => {});
      if (e instanceof ChecksAbortedError || (e as Error).name === 'ChecksAbortedError') {
        this.store.takeControl(task.id); // consume the kill request
        this.transition(task, 'KILLED', 'user requested kill during verification');
        return null;
      }
      throw e;
    }
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

  /** Wall-clock budget, measured from run start (spans restarts). */
  private budgetExceeded(task: Task): string | null {
    const budget = task.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    if (budget <= 0) return null;
    const start = Date.parse(task.startedAt ?? task.createdAt);
    const elapsed = Date.now() - start;
    if (elapsed > budget) return `time budget exceeded (${Math.round(elapsed / 1000)}s > ${Math.round(budget / 1000)}s)`;
    return null;
  }

  /**
   * Controlled integration of approved work: commit the coder branch, merge
   * into the target through a throwaway worktree. Idempotent (merge-base):
   * an already-integrated task is never merged twice. Any conflict, dirty
   * state, or missing branch escalates with everything preserved.
   */
  private async integrateApproved(task: Task): Promise<boolean> {
    const wt = task.worktree;
    if (!wt) return true;
    if (task.integration) {
      this.audit(task, 'autoslave', 'integration.skipped-duplicate', `already integrated at ${task.integration.sha}`);
      return true;
    }
    this.audit(task, 'autoslave', 'integration.start', `${wt.branch} → ${wt.targetBranch}`);
    let sha: string;
    try {
      sha = commitWork(wt.path, `autoslave: ${task.id} iteration ${task.iteration} — ${task.objective.slice(0, 80)}`);
      const res = integrate(wt.repoRoot, wt.branch, wt.targetBranch);
      if (!res.ok) {
        if (res.conflict) {
          this.escalate(task, 'merge conflict', `files preserved on ${wt.branch}: ${(res.conflictFiles ?? []).join(', ')}`);
        } else {
          this.escalate(task, 'integration failed', res.detail ?? 'unknown merge error');
        }
        return false;
      }
      task.integration = { sourceBranch: wt.branch, targetBranch: wt.targetBranch, sha: res.sha ?? sha, at: new Date().toISOString(), already: res.already };
      this.store.saveTask(task);
      this.audit(task, 'autoslave', 'integration.merged', `${wt.branch} → ${wt.targetBranch} at ${task.integration.sha}${res.already ? ' (already contained)' : ''}`);
      return true;
    } catch (e) {
      this.escalate(task, 'integration failed', (e as Error).message);
      return false;
    }
  }

  /**
   * Run the full loop for a task in state CREATED. Returns the terminal state.
   * The caller creates the task via `createTask`.
   */
  async run(taskId: string): Promise<TaskState> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state !== 'CREATED') {
      throw new Error(`task ${taskId} is ${task.state}: only CREATED can run (use recover to resume an interrupted task)`);
    }
    task.startedAt = new Date().toISOString();
    this.store.saveTask(task);
    const coder = this.agentOf(task, task.coderAgentId);
    const reviewer = this.agentOf(task, task.reviewerAgentId);
    const coderLabel = `coder:${task.coderAgentId}`;
    const reviewerLabel = `reviewer:${task.reviewerAgentId}`;
    this.audit(task, 'autoslave', 'run.start', `objective="${task.objective}" coder=${coder.sessionId} reviewer=${reviewer.sessionId}`);

    // CODING (first pass).
    this.transition(task, 'CODING', 'task created');
    const first = await this.coderTurn(task, coder.sessionId, buildTaskAssign(task.objective, task.planExcerpt, task.workdir), 'task.assign', coderLabel);
    if (!first) return this.finishTerminal(task);
    return this.reviewLoop(task, coder, reviewer, coderLabel, reviewerLabel, first.diff);
  }

  private finishTerminal(task: Task): TaskState {
    void this.auditCost(task);
    return task.state;
  }

  /** The REVIEWING → FIXING loop, shared by run() and resume(). */
  private async reviewLoop(
    task: Task,
    coder: { sessionId: string },
    reviewer: { sessionId: string },
    coderLabel: string,
    reviewerLabel: string,
    diff: DiffEntry[],
  ): Promise<TaskState> {
    for (;;) {
      const over = this.budgetExceeded(task);
      if (over) {
        this.escalate(task, over);
        return this.finishTerminal(task);
      }
      // Verification runs after every coder result so the reviewer sees facts.
      const checks = await this.runVerification(task);
      if (checks === null) return this.finishTerminal(task); // KILLED during checks
      // REVIEWING.
      this.transition(task, 'REVIEWING', `iteration ${task.iteration}: requesting review`);
      const verdict = await this.reviewerTurn(task, reviewer.sessionId, reviewerLabel, diff, checks);
      if (!verdict) return this.finishTerminal(task);

      if (verdict.status === 'approve') {
        const failedRequired = checks.filter((c) => c.required && c.status !== 'pass');
        if (failedRequired.length === 0) {
          if (!(await this.integrateApproved(task))) return this.finishTerminal(task);
          this.transition(
            task,
            'APPROVED',
            `reviewer approved at iteration ${task.iteration}; checks: ${checks.length > 0 ? auditSummary(checks) : 'none configured'}`,
          );
          return this.finishTerminal(task);
        }
        // Gate rule (FEATURES §3.5): required checks veto an approval.
        const names = failedRequired.map((c) => `${c.name}=${c.status}`).join(', ');
        this.audit(task, 'autoslave', 'approval.blocked', `reviewer approved but required checks failed: ${names}`);
        if (this.trackProgress(task, `B:${checksFingerprint(checks)}:${diffFingerprint(diff)}`) === 'stalled') {
          this.escalate(task, 'checks failing repeatedly', `same failures with no change: ${names}`);
          return this.finishTerminal(task);
        }
        const cap = this.capReached(task);
        if (cap) {
          this.escalate(task, cap, `blocked by failing checks: ${names}`);
          return this.finishTerminal(task);
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
        if (!fixed) return this.finishTerminal(task);
        diff = fixed.diff;
        continue;
      }

      // Reject: loop-health + iteration cap, then FIXING.
      const issueIds = [...verdict.issues.map((i) => i.id)].sort().join(',');
      const failures = checks.filter((c) => c.status !== 'pass');
      if (this.trackProgress(task, `R:${issueIds}:${diffFingerprint(diff)}:${checksFingerprint(checks)}`) === 'stalled') {
        this.escalate(task, 'review loop stalled', 'same issues with no diff change across iterations');
        return this.finishTerminal(task);
      }
      const cap = this.capReached(task);
      if (cap) {
        this.escalate(task, cap, `last verdict=reject (${verdict.issues.length} issues)`);
        return this.finishTerminal(task);
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
      if (!fixed) return this.finishTerminal(task);
      diff = fixed.diff;
    }
  }

  /**
   * Recover an interrupted task after an unexpected exit. Reloads persisted
   * state, reconciles sessions/history/worktree, aborts orphaned turns, and
   * re-drives the current step — never duplicating delivered operations
   * (opId + history reconcile) and never marking anything successful blindly.
   */
  async resume(taskId: string): Promise<TaskState> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (['APPROVED', 'ESCALATED', 'KILLED'].includes(task.state)) {
      this.audit(task, 'autoslave', 'recover.noop', `task already terminal (${task.state})`);
      return task.state;
    }
    this.audit(task, 'autoslave', 'recover.start', `reconciling from state ${task.state} iteration ${task.iteration}`);

    // Reconcile agents against real sessions. Vanished session or dead server
    // escalates honestly — never success, never silent.
    let coderSession: string;
    let reviewerSession: string;
    try {
      coderSession = this.agentOf(task, task.coderAgentId).sessionId;
      reviewerSession = this.agentOf(task, task.reviewerAgentId).sessionId;
      await this.deps.adapter.getSession(coderSession);
      await this.deps.adapter.getSession(reviewerSession);
    } catch (e) {
      this.escalate(task, 'cannot reconcile sessions', (e as Error).message);
      return this.finishTerminal(task);
    }
    // Reconcile the worktree when the task uses one.
    if (task.worktree) {
      if (!branchExists(task.worktree.repoRoot, task.worktree.branch)) {
        this.escalate(task, 'cannot reconcile worktree', `branch gone: ${task.worktree.branch}`);
        return this.finishTerminal(task);
      }
      if (!fs.existsSync(task.worktree.path)) {
        this.escalate(task, 'cannot reconcile worktree', `path gone: ${task.worktree.path}`);
        return this.finishTerminal(task);
      }
    }
    // Stop orphaned in-flight work before re-driving (best effort).
    for (const sid of [coderSession, reviewerSession]) {
      try {
        await this.deps.adapter.abort(sid);
      } catch {
        /* already idle or gone */
      }
    }
    // Wall-clock budget spans restarts: enforce before doing more work.
    const over = this.budgetExceeded(task);
    if (over) {
      this.escalate(task, over);
      return this.finishTerminal(task);
    }
    if (task.state === 'PAUSED') {
      // A pause does not survive a restart: say so, and re-drive explicitly.
      this.audit(task, 'autoslave', 'recover.paused', `pre-crash PAUSED (resume target was ${task.resumeState ?? 'unknown'}); re-driving current step instead`);
    }

    const coderLabel = `coder:${task.coderAgentId}`;
    const reviewerLabel = `reviewer:${task.reviewerAgentId}`;
    const coder = { sessionId: coderSession };
    const reviewer = { sessionId: reviewerSession };

    if (task.state === 'REVIEWING') {
      // Recompute review inputs deterministically, then re-review. The review
      // request is a fresh message (new opId per attempt is unnecessary: the
      // opId dedupe reuses the message only when its turn completed).
      const diff = await this.deps.adapter.getDiff(coderSession);
      return this.reviewLoop(task, coder, reviewer, coderLabel, reviewerLabel, diff);
    }
    // CODING / FIXING / PAUSED: re-drive the coder step. FIXING needs the last
    // verdict to rebuild feedback; without it we cannot continue honestly.
    let prompt: string;
    let messageType: 'task.assign' | 'feedback.apply';
    if (task.state === 'FIXING') {
      if (!task.lastVerdict || task.lastVerdict.status !== 'reject') {
        this.escalate(task, 'cannot reconstruct fix step', 'FIXING without a persisted reject verdict');
        return this.finishTerminal(task);
      }
      prompt = buildFeedbackApply(task.objective, task.planExcerpt, task.lastVerdict, (task.lastChecks ?? []).filter((c) => c.status !== 'pass'));
      messageType = 'feedback.apply';
      this.enterState(task, 'FIXING', 'recovered: re-driving fix step');
    } else {
      prompt = buildTaskAssign(task.objective, task.planExcerpt, task.workdir);
      messageType = 'task.assign';
      this.enterState(task, 'CODING', 'recovered: re-driving coding step');
    }
    const redriven = await this.coderTurn(task, coderSession, prompt, messageType, coderLabel);
    if (!redriven) return this.finishTerminal(task);
    return this.reviewLoop(task, coder, reviewer, coderLabel, reviewerLabel, redriven.diff);
  }

  /** Create a task in state CREATED (does not run it). */
  createTask(args: {
    id?: string;
    objective: string;
    planExcerpt: string;
    planPath?: string;
    coderAgentId: string;
    reviewerAgentId: string;
    workdir: string;
    reviewFiles?: string[];
    reviewObjective?: string;
    checks?: CheckDef[];
    worktree?: Task['worktree'];
    timeBudgetMs?: number;
    maxIterations?: number;
    coderTimeoutMs?: number;
    reviewerTimeoutMs?: number;
  }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: args.id ?? newId('task'),
      state: 'CREATED',
      iteration: 1,
      maxIterations: args.maxIterations ?? 5,
      coderTimeoutMs: args.coderTimeoutMs ?? 600000,
      reviewerTimeoutMs: args.reviewerTimeoutMs ?? 300000,
      timeBudgetMs: args.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
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
      worktree: args.worktree,
    };
    this.store.saveTask(task);
    this.audit(task, 'autoslave', 'task.created', `objective="${task.objective}" maxIterations=${task.maxIterations}${task.worktree ? ` worktree=${task.worktree.branch}` : ''}`);
    return task;
  }
}
