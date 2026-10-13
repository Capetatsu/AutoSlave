# AutoSlave — Phase 4 Evidence (Isolation, Permissions, Recovery)

Date: 2026-10-14. Pinned OpenCode: v2.0.28. No new dependencies.

## What was built

- `src/git/worktrees.ts` — isolated worktrees/branches in temp (never inside a
  checkout), guarded removal (dirty/unmanaged/main always refused), `commitWork`
  with inline identity, controlled `integrate` (refuses wrong-branch checkout,
  dirty trees, missing branches; aborts conflicts with everything preserved;
  idempotent via merge-base). Rationale recorded: detached-worktree merges cannot
  advance the target ref, so integration runs in the main checkout under guards.
- `src/policy/policy.ts` — static role policy (`policy.json` or built-in
  defaults; reviewer read-only), no-wildcard glob engine, closed-default
  evaluation (unknown role → deny; unmatched exec → escalate), post-turn
  write-scope enforcement, and `answerPermission` whose signature admits NO
  model input — self-granting is structurally impossible.
- Adapter: `replyPermission`, `listPermissions`, `permissions` on session create.
  Reviewer sessions created with a deny-write ruleset (second layer only).
- `src/verify/checks.ts` — own-timeout process-TREE kill (taskkill /T/F on
  Windows), VERIFIED death (tasklist/ESRCH; EPERM never counts), abortable runs
  (`ChecksAbortedError`), `killed` reported only when confirmed.
- Engine: opId idempotency (reuse-if-completed else redeliver-same-message, via
  history reconcile), per-turn permission sweeps answered from policy,
  post-turn scope enforcement, `integrateApproved` (commit → merge → record;
  conflict/dirty/missing → escalate, preserve), 30-min default time budget
  (spans restarts), token cost audit, `resume()` (reconcile sessions/history/
  worktree → abort orphans → re-drive; terminal/PAUSED handled honestly).
- Store: `findByOpId`. CLI: `--worktree/--target-branch/--time-budget`, `recover`,
  policy source line, home-outside-workdir guard (kept).

## Decisions (extends D1–D8)

- **D9 worktrees**: writers isolated by branch+worktree; reviewer reads via packets
  from its own session dir. Integration in main checkout under clean+branch guards.
- **D10 policy**: enforcement = static config + instruction + deterministic post-turn
  detection + audit. OpenCode rulesets are backstop only (see Q14 delta below).
- **D11 recovery**: opId + history reconcile; re-drive current step; pause does not
  survive restart (audited); never success-blind.

## Failure taxonomy (each with a defined response)

| Failure | Response | Where |
|---|---|---|
| check/command timeout | tree-kill verified; result `timeout`; loop continues to cap | checks.ts, engine |
| agent error / turn failed | escalate immediately | engine |
| malformed output | retry once, then escalate | engine (unchanged) |
| permission denied (rule) | reply reject + audit; escalate-decision → task escalates, request left pending | policy, engine sweep |
| reviewer wrote | policy.denied audit + escalate, diff preserved | engine |
| merge conflict | abort merge, escalate with file list, both branches intact | worktrees, engine |
| dirty/wrong-branch checkout | refuse merge, escalate | integrate |
| vanished session / dead server | reconcile fails → escalate, zero prompts sent | resume |
| time budget exceeded | escalate (spans restarts via startedAt) | engine |

## Phase 0 deltas (new live evidence)

- **Q14**: deny AND ask rulesets accepted (200) but produce ZERO `permission.*`
  events and empty request lists; an ask-mode write was opaquely suppressed
  (`executed:false`, claimed success). The reply endpoint exists but nothing
  arrives to answer. Enforcement claim adjusted to D10; probes saved in spike/.
- **Q17**: shared-service restart still untestable live (would kill live
  sessions incl. this harness). Client-side crash recovery (the AutoSlave failure
  mode) proven live instead — see T4.
- **Q20**: server already localhost+password; confirmed, no change needed.

## Verification

- `build` + `typecheck` clean. `test:unit` **109/109**. `test:contract` **4/4**,
  `test:phase2` **1/1**, `test:phase3` **1/1** (no regressions).
- `test:phase4` live **4/4**: T1 concurrent writers isolated, no cross-touch;
  T2 worktree loop APPROVED iter 2 (reject,approve) + merge commit `d6eb186` on
  main containing the fix; T3 bogus session + dead server → ESCALATED, zero sends;
  T4 SIGKILL mid-turn → `recover.start`, `message.redelivered` (same id),
  APPROVED iter 1, opIds unique.
- Required areas: (1) T1 live + worktree units; (2) policy units + sweep tests +
  live reviewer ran deny-ruleset and produced verdicts; (3) conflict/idempotent
  units + T2 live merge; (4) kill-verified units (Windows taskkill/tree);
  (5) 13 resume/opId/integration/budget mocked tests + T4 live crash;
  (6) T3 live + mocked; (7) phase2/phase3 live reruns green.
- Artifacts: `phase4-t2-audit.jsonl`, `phase4-t4-audit.jsonl`.

## Honest limitations

- OpenCode permission events never observed: the reply path is shape-tested +
  sweep-wired, but no live request has ever arrived to answer.
- Reviewer relocation (session.move) not used; separation is by session dir +
  policy + detection. OS sandboxing deferred per plan (detection is strongest
  practical mechanism on this installation).
- `resume` re-drives whole steps (a crashed report round re-sends the work
  prompt); wasteful but safe and audited.
- Reviewer independence unchanged (free-tier models; Anthropic key invalid).
- Cleanup policy: temp worktrees removed with `--force` only after their branch
  is merged or the task ends; orphan shells pruned; user checkouts/branches
  never deleted by any path (guards tested).
