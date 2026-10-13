# AutoSlave — Phase 3 Evidence (Deterministic Verification)

Date: 2026-10-14. Pinned OpenCode: v2.0.28. No new dependencies (child_process only).

## What was built

- `src/verify/checks.ts` — `CheckDef`/`CheckResult`, `autoslave.checks.json`
  loader + validation (`required` defaults true, timeout default 120s), CLI
  `--check`/`--optional-check` parsing, config+CLI merge (CLI wins), sequential
  runner (exit code, duration, 32 KB capped output, 4 KB excerpts, timeout kill),
  secret redaction (T17), packet/audit summarizers.
- Engine gate (FEATURES §3.5): checks run after every coder result; results join
  the review packet as facts; approve + any failing REQUIRED check → `approval.blocked`,
  feedback with excerpts auto-routed, loop continues; optional failures don't block;
  repeated identical failures → stall escalation; iteration cap still bounds everything.
- Packets: checks section in `review.request`; `FAILING CHECKS` in `feedback.apply`
  (reject) and in a dedicated checks-feedback prompt (approve-but-blocked).
- CLI: `--check/--optional-check`, config auto-load from coder workdir, `status`
  shows per-check results.

## Verification

- `npm run build` + `typecheck`: clean. `test:unit`: **63/63** (19 verify-runner +
  6 gate scenarios mocked). `test:contract`: **4/4**. `test:phase2`: **1/1**
  (no-checks path intact). `test:phase3` (live): **PASS**.
- Required scenarios (mocked, deterministic): (a) fail+approve → blocked, excerpt
  routed, then APPROVED; (b) pass+reject → continues, checks in packet;
  (c) pass+approve → APPROVED first round. Plus: optional-fail approves, repeated
  failures stall-escalate, no-checks reviewer-only mode.
- Live run (disposable temp git repo, zero manual relay): `checks.done unit=fail`,
  reviewer read the packet facts and rejected citing the failing test, coder fixed,
  `checks.done unit=pass`, reviewer approved citing exit 0, `APPROVED` iter 2.
  Artifacts: `phase3-audit.jsonl`, `phase3-final.diff`. Final project tests were
  re-run locally here and pass; live path was (b)→(c), (a) stands mocked.

## Findings (both changed how tests are written)

1. **Node refuses nested `run()`**: a `node --test` grandchild under `node --test`
   exits 0 running zero tests (`NODE_TEST_CONTEXT` guard, verified). Production is
   unaffected (daemon never runs under a test runner), but harness-driven checks
   must not invoke the test binary directly. Fixture uses `run-tests.cjs`, which
   deletes the var (restoring exactly the production condition) and shells a real
   `node --test` — genuine results and exit codes, no fabrication.
2. **Bare `node --test` discovery can vacuously pass** (exit 0, zero tests) if files
   are momentarily undiscoverable (observed once at fixture setup). Checks should
   name explicit files; runner mechanics (caps/timeouts/exits) are unit-covered.

## Limitations (honest)

- Reviewer independence unchanged from Phase 2 (Anthropic key invalid; different
  free-tier model, same provider).
- Checks run sequentially to completion once started; pause/kill apply at the next
  checkpoint. `spawn` timeout kill on Windows may leave orphans (documented).
- Secret redaction covers common patterns only; check output is persisted — keep
  secrets out of check commands.
- No flaky-check retry beyond loop iterations + cap; no parallel checks, tester
  agent, coverage, or CI (all correctly out of scope).
