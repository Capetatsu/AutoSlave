# AutoSlave — Decision Record (Phase 0, 2026-10-14)

Template per MAIN_PLAN §10. Owner: coding agent (opencode session), approver: repo owner.

## D1. Topology

- Options considered: (A) mesh-owned `opencode serve` + user attaches tabs; (B) shared
  background service, mesh creates sessions, user opens tabs in the session directory;
  (C) mesh drives arbitrary existing TUI tabs.
- Evidence: `phase0-findings.md` Q1–Q5 (service discovery, per-directory CLI listing,
  API list contains all sessions).
- Chosen: **(B)**. Mesh talks to the shared background service (URL via
  `opencode service status`, password via `service.json`); it creates sessions with an
  explicit `location.directory`; the user observes by opening a tab in that directory.
- Why: No extra server to run; sessions are first-class API objects visible to normal
  tabs by directory. (C) is impossible — no API maps a visible tab to a session.
- Reversal conditions: service auth model changes, or per-directory listing disappears.
- Pinned OpenCode ver.: 2.0.28.

## D2. Completion detection

- Options: (A) `session.idle` event alone; (B) experimental `wait` endpoint;
  (C) terminal SSE event + history reconcile + structured completion report.
- Evidence: Q8–Q12; `wait` early-204 incident; `idle{outcome}` in history.
- Chosen: **(C)**, with `wait` as a bounded auxiliary signal only.
- Why: Idle alone conflates success/blocked/abort (T7); `wait` returned early once.
  History (`idle.outcome` + assistant content + required report) is truth; events are hints.
- Reversal: `wait` semantics documented/fixed upstream AND proven over 50+ runs.

## D3. Diff source

- Options: (A) `GET /api/session/{id}/diff`; (B) `git diff`.
- Evidence: Q13, `diff-with-changes.json` (`{file, patch, additions, deletions, status}`).
- Chosen: **(A) primary, (B) fallback/audit**. Session diff attributes changes per turn;
  git diff covers anything outside the session's view. Caveat: (A) returns nothing when
  the session directory is outside a git repo — sessions must work in repos (guaranteed
  by Phase 4 worktrees; enforced by adapter/CLI later).
- Reversal: diff endpoint missing turn attribution needed for review packets.

## D4. Structured output (verdicts, reports)

- Options: (A) `json_schema` response format; (B) instruction-following raw JSON +
  mesh-side strip/parse/validate + retry-once-then-escalate.
- Evidence: Q15; spec has no `json_schema`/`outputFormat` in v2 prompt API.
- Chosen: **(B)**. Verdict schema stays as specified in FEATURES/MVP; the transport is
  "reply with ONLY raw JSON" + strict validation in AutoSlave.
- Why: Only mechanism the installed version supports; validated 1/1 with a real reviewer.
- Reversal: server or SDK gains schema-constrained decoding; 20-run matrix (Phase 2)
  shows instruction-following below threshold on the chosen reviewer model.
- Doc impact: MAIN_PLAN Phase 2 "via `json_schema` output" and FEATURES F10 wording
  corrected to (B) with this record as authority.

## D5. Reviewer model

- Options: (A) same free model both sides; (B) different models/providers.
- Evidence: Q19 (per-session switch verified), `opencode auth list` (Anthropic key in env).
- Chosen: **(B) for Phase 2**: coder on default free model, reviewer switched to a
  different model (Anthropic preferred; free-tier alternative if unavailable). Same-model
  pairing surfaces a warning in status (P8).
- Reversal: chosen reviewer model fails the 20-run verdict matrix.

## D6. Language / SDK / client

- Options: (A) official `@opencode-ai/sdk`; (B) generate client from served spec;
  (C) minimal hand-rolled fetch client typed against the served spec.
- Evidence: Q23 (SDK 1.19.0 → v1 paths → 404s on 2.0.28); Q2 (spec served, versioned).
- Chosen: **TypeScript + (C)** for Phase 1 adapter. Small surface (8 ops), zero new
  runtime deps; spec file vendored as the contract. Revisit (A) if a v2-compatible SDK
  ships; (B) if the op surface grows past ~20 ops.
- Reversal: SDK publishes v2 support matching pinned server.

## D7. Single-writer + reviewer confinement (MVP)

- Options: (A) convention ("reviewer: do not write, do not use tools"); (B) enforcement.
- Evidence: Q14 (defaults auto-allow; no permission events), reviewer filesystem
  exploration incident.
- Chosen: **(A) in MVP, enforced policy in Phase 4**. MVP reviewer prompts forbid tools;
  packets are bounded; coder is the only agent assigned write tasks. Attempted reviewer
  writes are detectable via session diff + file watcher and escalate.
- Reversal: any MVP run shows reviewer modifying the tree → escalate to Phase 4 controls
  early for that path.

## D8. Product / CLI naming

- Options: `mesh` vs `autoslave` (owner directive: project is **AutoSlave**, CLI `autoslave`).
- Evidence: `autoslave --version` works via npm `autoslave.ps1` shim (PowerShell) and
  `node bin/autoslave.js --version`; npm name `autoslave` taken → package `private:true`.
- Chosen: product **AutoSlave**, executable **autoslave**, package `autoslave@0.1.0`
  (private). Four governing docs renamed (127 lines, headings + CLI + prose).
- Reversal: none (owner directive).
