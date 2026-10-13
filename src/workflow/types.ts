/**
 * Phase 2 workflow types: task states, persisted messages, coder reports,
 * reviewer verdicts, and strict validators. No OpenCode imports here.
 */

export type TaskState =
  | 'CREATED'
  | 'CODING'
  | 'REVIEWING'
  | 'FIXING'
  | 'APPROVED'
  | 'ESCALATED'
  | 'PAUSED'
  | 'KILLED';

export type MessageType =
  | 'task.assign'
  | 'task.progress'
  | 'task.result'
  | 'review.request'
  | 'review.verdict'
  | 'feedback.apply'
  | 'workflow.escalate';

export interface BusMessage {
  id: string;
  /** Deterministic operation key (`i<iteration>:<step>`) for crash-safe redelivery. */
  opId?: string;
  type: MessageType;
  taskId: string;
  from: string;
  to: string;
  iteration: number;
  createdAt: string;
  /** Type-specific payload. Bounded — never a raw transcript. */
  payload: Record<string, unknown>;
  /** Delivery outcome, recorded after the send attempt. */
  delivery?: { status: 'sent' | 'failed'; detail?: string; at?: string };
}

import type { CheckDef, CheckResult } from '../verify/checks.js';

export interface Task {
  id: string;
  objective: string;
  planPath?: string;
  planExcerpt: string;
  coderAgentId: string;
  reviewerAgentId: string;
  workdir: string;
  state: TaskState;
  /** State to restore when resuming from PAUSED. */
  resumeState?: TaskState;
  iteration: number;
  maxIterations: number;
  coderTimeoutMs: number;
  reviewerTimeoutMs: number;
  lastReport?: CompletionReport;
  lastVerdict?: Verdict;
  /** Configured deterministic checks (empty = reviewer judgement only). */
  checks?: CheckDef[];
  /** Results of the latest verification run (after the latest coder result). */
  lastChecks?: CheckResult[];
  /** Unified loop-health key (verdict + diff + checks fingerprints). */
  lastProgressKey?: string;
  /** Repeat count of identical progress keys across iterations — loop health. */
  stallCount?: number;
  /** Repo-relative paths (under workdir) whose current content joins each review packet. */
  reviewFiles?: string[];
  /** Broader objective the reviewer judges against (defaults to the coder's objective). */
  reviewObjective?: string;
  /** Isolated worktree for the writing agent (absent = in-place mode). */
  worktree?: {
    repoRoot: string;
    branch: string;
    path: string;
    targetBranch: string;
    baseSha: string;
  };
  /** Controlled-integration record (set once approved work is merged). */
  integration?: {
    sourceBranch: string;
    targetBranch: string;
    sha: string;
    at: string;
    already?: boolean;
  };
  /** Wall-clock budget in ms (default 30 min; 0/negative = unlimited). */
  timeBudgetMs?: number;
  /** Run start (budget measured from here, spans restarts). */
  startedAt?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Coder completion report (FEATURES F8). A claim, not proof. */
export interface CompletionReport {
  status: 'complete' | 'partial' | 'blocked';
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  knownGaps: string[];
  blockers: string[];
}

export interface ReviewIssue {
  id: string;
  severity: string;
  file: string;
  description: string;
}

export type Verdict =
  | { status: 'approve'; summary: string }
  | { status: 'reject'; summary: string; issues: ReviewIssue[]; next_actions: string[] };

/** Strip fences/prose, return the first balanced {...} JSON candidate. */
export function extractJsonCandidate(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = (fence ? fence[1] : text).trim();
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

/** Validate a parsed value as a CompletionReport. Returns errors (empty = valid). */
export function validateReport(v: unknown): { report?: CompletionReport; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(v)) return { errors: ['report must be a JSON object'] };
  if (v.status !== 'complete' && v.status !== 'partial' && v.status !== 'blocked') {
    errors.push(`status must be complete|partial|blocked, got ${JSON.stringify(v.status)}`);
  }
  if (typeof v.summary !== 'string' || v.summary.length === 0) errors.push('summary must be a non-empty string');
  for (const f of ['filesChanged', 'commandsRun', 'knownGaps', 'blockers'] as const) {
    if (strArray(v[f]) === null) errors.push(`${f} must be an array of strings`);
  }
  if (errors.length > 0) return { errors };
  return {
    report: {
      status: v.status as CompletionReport['status'],
      summary: v.summary as string,
      filesChanged: v.filesChanged as string[],
      commandsRun: v.commandsRun as string[],
      knownGaps: v.knownGaps as string[],
      blockers: v.blockers as string[],
    },
    errors,
  };
}

/** Validate a parsed value as a Verdict. Reject without ≥1 next_action is invalid. */
export function validateVerdict(v: unknown): { verdict?: Verdict; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(v)) return { errors: ['verdict must be a JSON object'] };
  if (v.status !== 'approve' && v.status !== 'reject') {
    return { errors: [`status must be approve|reject, got ${JSON.stringify(v.status)}`] };
  }
  if (typeof v.summary !== 'string' || v.summary.length === 0) errors.push('summary must be a non-empty string');
  if (v.status === 'approve') {
    if (errors.length > 0) return { errors };
    return { verdict: { status: 'approve', summary: v.summary as string }, errors };
  }
  if (!Array.isArray(v.issues) || v.issues.length === 0) {
    errors.push('reject verdict must list at least one issue');
  } else {
    v.issues.forEach((it: unknown, i: number) => {
      if (!isRecord(it) || typeof it.id !== 'string' || typeof it.description !== 'string') {
        errors.push(`issues[${i}] must have at least string id and description`);
      }
    });
  }
  const actions = strArray(v.next_actions);
  if (actions === null || actions.length === 0) {
    errors.push('reject verdict must contain at least one next_action');
  }
  if (errors.length > 0) return { errors };
  return {
    verdict: {
      status: 'reject',
      summary: v.summary as string,
      issues: (v.issues as ReviewIssue[]).map((it) => ({
        id: String(it.id),
        severity: typeof it.severity === 'string' ? it.severity : 'medium',
        file: typeof it.file === 'string' ? it.file : '',
        description: String(it.description),
      })),
      next_actions: actions as string[],
    },
    errors,
  };
}

/** Parse + validate in one step (used for both reports and verdicts). */
export function parseStructured<T>(
  text: string,
  validate: (v: unknown) => { report?: T; verdict?: T; errors: string[] },
): { value?: T; errors: string[] } {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return { errors: ['no JSON object found in reply'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const r = validate(parsed);
  if (r.errors.length > 0) return { errors: r.errors };
  return { value: (r.report ?? r.verdict) as T, errors: [] };
}
