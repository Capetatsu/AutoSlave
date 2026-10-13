# AutoSlave — Phase 2 Evidence (Coder ↔ Reviewer Loop)

Date: 2026-10-14. Pinned OpenCode: v2.0.28. Basis: decisions D1–D8, Phase 1 adapter.

## What was built

- `src/workflow/types.ts` — states, `BusMessage`, `Task`, `CompletionReport` /
  `Verdict` schemas + strict validators, fence-tolerant JSON extraction.
- `src/workflow/packets.ts` — bounded builders: `task.assign`, `feedback.apply`,
  report request (+retry), `review.request` (objective, plan excerpt, diff, report,
  previous verdict, extra files, coder-scope note), verdict retry. Caps enforced.
- `src/workflow/engine.ts` — state machine
  `CREATED→CODING→REVIEWING→FIXING→REVIEWING→APPROVED` (+`ESCALATED/PAUSED/KILLED`):
  persist-before-delivery messaging, completion-gated turns, report retry-once,
  verdict retry-once, reject-without-`next_actions` invalid, iteration cap (default 5),
  stall detection (same issues + unchanged diff → escalate), reviewer-write detection
  via reviewer session diff, control-file pause/resume/kill, full audit trail.
- `src/store/store.ts` — `workflows.json` (tasks, messages, audit seq, atomic writes),
  `audit.log` (append-only JSONL), `control-<task>.json` (pause/resume/kill).
- CLI: `run --task --plan --coder --reviewer [--max-iterations --coder-timeout
  --reviewer-timeout --reviewer-model --review-file --review-objective]`,
  `status [--task]`, `log [--task --lines --follow]`, `pause/resume/kill <task>`.
  `run` refuses when AutoSlave home is inside the coder workdir (diff integrity).

## Verification

- `npm run build` + `typecheck`: clean. `npm run test:unit`: **42/42 pass**
  (23 Phase 1 + 19 workflow: approve-first-pass, reject→fix→approve, verdict
  retry→approve, double-invalid→escalate, actionless-reject→escalate, iteration cap,
  stall, coder-failure, bad-report, reviewer-write, kill, pause/resume, packets,
  validators, store persistence, review-file confinement).
- `npm run test:contract`: **4/4 pass** (no Phase 1 regression).
- `npm run test:phase2` (live, seeded defect): **PASS** — `APPROVED` at iteration 2,
  verdicts `reject -> approve`, message trail exactly
  `task.assign,task.progress,task.result,review.request,review.verdict,feedback.apply,
  task.progress,task.result,review.request,review.verdict`, audit contains
  `CREATED→CODING→REVIEWING→FIXING→REVIEWING→APPROVED`. Artifacts:
  `spike/findings/phase2-audit.log`, `phase2-final.diff`, `phase2-evidence-run.txt`.
- Demo narrative (zero manual copy-paste): coder documented `mathutil.js`; reviewer
  (different model) rejected — caught seeded `age > 18` off-by-one in `validator.js`
  plus a trailing-newline nit, with 2 concrete `next_actions`; engine routed them to
  the coder; coder fixed; reviewer approved citing every plan item.

## Incidents fixed (all evidence-driven)

1. **False D7 trip**: adapter `raw.log` lived inside the session workdir; session diffs
   attribute ANY file changed during a turn → reviewer "modified" our own log.
   Fix: state/logs outside the workdir (test + CLI default) + `run` refuses
   home-inside-workdir. Real reviewer writes still escalate (mocked test).
2. **Diff attribution window**: `session.diff` defaults to the newest user turn, so
   fetching after the report round returned empty. Fix: capture work-turn diff first,
   union with report-turn diff.
3. **Anthropic key invalid** (401 `invalid x-api-key`, verified live): reviewer uses
   `opencode/mimo-v2.6-flash-free` vs coder default `cat-jam-free` — different model,
   same provider. Weaker independence than D5 preferred; recorded honestly. P8
   same-model warning is implemented in `status`.
4. **Reviewer scoped itself to the coder's assignment** and approved despite the live
   seeded bug. Fix: `reviewObjective` (judge whole tree vs full plan) + `coderScope`
   note + `reviewFiles` (bounded current content of plan-relevant files), all verified
   in the passing run. Not scope creep: same Phase 2 packet builder, no new agents.
5. **CLI `run` swallowed its first flag** as `sub` (found by smoke test, zero-token
   paths). All `run` flags now read from full argv.

## Deferred / unverified

Daemon hardening, crash recovery, deterministic checks (Phase 3), permission policy
and worktrees (Phase 4) — untouched per plan. Reviewer turn on very long packets
untested beyond ~2.5 KB. 20-run verdict matrix still open (1 reject + 2 approves
observed live, all schema-valid first try).
