/**
 * Context packet builders: bounded, single-purpose prompts for coder and reviewer.
 * Never forwards raw transcripts. Caps keep packets small and auditable.
 */
import type { CompletionReport, Verdict } from './types.js';
import type { CheckResult } from '../verify/checks.js';

export const LIMITS = {
  planExcerpt: 4000,
  diffChars: 12000,
  reportSummary: 1000,
  nextActions: 10,
  issues: 10,
} as const;

export interface DiffEntryLike {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function diffText(diff: DiffEntryLike[]): string {
  if (diff.length === 0) return '(empty — no changes recorded for this turn)';
  const parts = diff.map((d) => `--- ${d.file} [${d.status} +${d.additions}/-${d.deletions}]\n${d.patch}`);
  return cap(parts.join('\n'), LIMITS.diffChars);
}

function checksPacketSection(checks: CheckResult[] | undefined): string {
  if (!checks || checks.length === 0) {
    return 'DETERMINISTIC CHECKS: none configured for this task (reviewer judgement only).';
  }
  const lines = ['DETERMINISTIC CHECKS (facts — a failing REQUIRED check blocks approval even if you approve):'];
  for (const r of checks) {
    lines.push(`- [${r.required ? 'required' : 'optional'}] ${r.name}: ${r.status} (exit ${r.exitCode ?? 'n/a'}, ${r.durationMs}ms)`);
    if (r.status !== 'pass') lines.push(`  excerpt: ${cap(r.excerpt, 1500)}`);
  }
  return lines.join('\n');
}

const REPORT_SCHEMA = `{"status":"complete|partial|blocked","summary":"...","filesChanged":["..."],"commandsRun":["..."],"knownGaps":["..."],"blockers":[]}`;
const VERDICT_SCHEMA = `{"status":"approve","summary":"..."} OR {"status":"reject","summary":"...","issues":[{"id":"I1","severity":"high|medium|low","file":"...","description":"..."}],"next_actions":["concrete step 1","concrete step 2"]}`;

/** First assignment to the coder. */
export function buildTaskAssign(objective: string, planExcerpt: string, workdir: string): string {
  return [
    `You are the coder in an AutoSlave review loop. Implement the task below in: ${workdir}`,
    `Only modify files inside that directory. Do not touch anything outside it.`,
    ``,
    `OBJECTIVE: ${objective}`,
    ``,
    `PLAN (excerpt):`,
    cap(planExcerpt, LIMITS.planExcerpt),
    ``,
    `When you finish working, stop and wait for further instructions. You will then be asked for a structured completion report.`,
  ].join('\n');
}

/** Follow-up fix instructions when the reviewer approved but required checks failed. */
export function buildChecksFeedback(
  objective: string,
  failures: CheckResult[],
): string {
  return [
    `Your work was reviewed, but REQUIRED deterministic checks failed, so it cannot be approved yet. Fix the failures below in the project, then stop and wait.`,
    ``,
    `OBJECTIVE: ${objective}`,
    ``,
    ...checkFailureLines(failures),
  ].join('\n');
}

function checkFailureLines(failures: CheckResult[]): string[] {
  const lines = [`FAILING CHECKS (fix every required one):`];
  for (const f of failures.slice(0, LIMITS.nextActions)) {
    lines.push(`- [${f.required ? 'required' : 'optional'}] ${f.name} (\`${f.command}\`): ${f.status} (exit ${f.exitCode ?? 'n/a'}, ${f.durationMs}ms)`);
    lines.push(`  output excerpt: ${cap(f.excerpt, 2000)}`);
  }
  return lines;
}

/** Follow-up fix instructions built from a reject verdict and/or check failures. */
export function buildFeedbackApply(
  objective: string,
  planExcerpt: string,
  verdict: Extract<Verdict, { status: 'reject' }>,
  checkFailures: CheckResult[] = [],
): string {
  const lines = [
    `The reviewer REJECTED your work. Apply the following actions in the project, then stop and wait.`,
    ``,
    `OBJECTIVE: ${objective}`,
    ``,
    `REVIEWER SUMMARY: ${verdict.summary}`,
    ``,
    `ISSUES:`,
    ...verdict.issues.slice(0, LIMITS.issues).map((it) => `- [${it.id}/${it.severity}] ${it.file}: ${it.description}`),
    ``,
    `NEXT ACTIONS (do each of these):`,
    ...verdict.next_actions.slice(0, LIMITS.nextActions).map((a, i) => `${i + 1}. ${a}`),
    ``,
    ...(checkFailures.length > 0 ? [...checkFailureLines(checkFailures), ``] : []),
    `PLAN (excerpt, for reference):`,
    cap(planExcerpt, LIMITS.planExcerpt),
  ];
  return lines.join('\n');
}

/** Request for the coder's structured completion report (with optional retry note). */
export function buildReportRequest(retryErrors?: string[]): string {
  const base = [
    `Reply with ONLY a raw JSON object (no code fences, no prose) matching exactly this shape:`,
    REPORT_SCHEMA,
    `Rules: status is complete only if you finished everything with no known gaps; otherwise partial or blocked. filesChanged lists paths you actually modified. Be honest — the reviewer checks the real diff.`,
  ];
  if (retryErrors && retryErrors.length > 0) {
    base.push(``, `Your previous reply was invalid for these reasons:`, ...retryErrors.map((e) => `- ${e}`), `Reply again with ONLY the corrected JSON object.`);
  }
  return base.join('\n');
}

/** Review request packet for the reviewer. Bounded; no transcript. */
export function buildReviewRequest(args: {
  objective: string;
  planExcerpt: string;
  iteration: number;
  maxIterations: number;
  diff: DiffEntryLike[];
  report: CompletionReport;
  previousVerdict?: Verdict;
  /** Current content of plan-relevant files with no (or unrelated) diff. */
  extraFiles?: Array<{ file: string; content: string }>;
  /** The coder's scoped assignment (when the review objective is broader). */
  coderScope?: string;
  /** Latest deterministic check results (facts for the reviewer). */
  checks?: CheckResult[];
}): string {
  const lines = [
    `You are an independent code reviewer in an AutoSlave review loop (iteration ${args.iteration}/${args.maxIterations}).`,
    `RULES: Do not call any tools. Do not modify any files. Base your verdict ONLY on the packet below — do not explore the filesystem.`,
    ``,
    `OBJECTIVE (judge the whole project state against this, not just the coder's assignment): ${args.objective}`,
    ``,
    `PLAN (excerpt):`,
    cap(args.planExcerpt, LIMITS.planExcerpt),
    ``,
    `ACTUAL DIFF (source of truth — the coder's report is only a claim):`,
    diffText(args.diff),
    ``,
    checksPacketSection(args.checks),
    ``,
    `CODER REPORT: ${cap(JSON.stringify(args.report), LIMITS.reportSummary + 500)}`,
  ];
  if (args.coderScope) {
    lines.push(
      ``,
      `The coder's assignment was scoped to: ${args.coderScope}`,
      `Do NOT limit your verdict to that scope. Verify EVERY plan item against the project state (diff plus listed files). Anything in the plan not yet satisfied is a defect: reject with concrete next_actions.`,
    );
  }
  if (args.extraFiles && args.extraFiles.length > 0) {
    lines.push(``, `OTHER PLAN-RELEVANT FILES (current content — verify these against the plan even though they have no diff):`);
    for (const f of args.extraFiles.slice(0, 3)) {
      lines.push(``, `--- ${f.file} ---`, cap(f.content, 3000));
    }
  }
  if (args.previousVerdict && args.previousVerdict.status === 'reject') {
    lines.push(
      ``,
      `PREVIOUS VERDICT (re-check whether these were fixed): ${cap(JSON.stringify(args.previousVerdict), 2000)}`,
    );
  }
  lines.push(
    ``,
    `Reply with ONLY a raw JSON object (no code fences, no prose) matching exactly one of:`,
    VERDICT_SCHEMA,
    `Rules: approve only if the diff fully satisfies the objective and plan. reject must list at least one issue AND at least one concrete next_action. Cite real files from the diff. Never invent passing checks.`,
  );
  return lines.join('\n');
}

/** Retry prompt after an invalid verdict. */
export function buildVerdictRetry(errors: string[]): string {
  return [
    `Your previous reply was not a valid verdict for these reasons:`,
    ...errors.map((e) => `- ${e}`),
    `Reply again with ONLY the corrected raw JSON object (no code fences, no prose).`,
  ].join('\n');
}
