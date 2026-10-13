# AutoSlave — Phase 0 Findings (Technical Validation Spike)

Pinned OpenCode version: **v2.0.28** (`opencode --version`). Server: local background
service at `http://127.0.0.1:49374` (port from `opencode service status`; password from
`~/.config/opencode/service.json`, HTTP Basic `opencode:<password>`).
Spec saved: `spike/findings/openapi-2.0.28.json` (118 paths, fetched from `/openapi.json`).

Spike scripts (throwaway, no architecture): `spike/autoslave-spike.mjs` (parts 1),
`spike/autoslave-spike2.mjs`, `spike/autoslave-spike3.mjs`, `spike/inspect-*.mjs`.
Raw captures: `events-coder-subA.ndjson`, `messages-coder-raw.json`,
`diff-with-changes.json`, `verdict-sample.txt`, `spike-summary.json`,
`spike2-summary.json`, `spike3-summary.json`.
Method: hand-rolled `fetch` client + SSE parser. No SDK, no terminal scraping.

All prompts used free-tier models (`opencode/cat-jam-free`, later `mimo-v2.6-flash-free`);
token spend per prompt was a few thousand input tokens, cost $0.

## Answers Q0–Q24

| # | Question | Verdict | Evidence |
|---|---|---|---|
| Q0 | Version / install | ✅ answered | `opencode v2.0.28`, npm `@opencode/cli`; Node v25.6.1 |
| Q1 | `serve` / server, port, auth | ✅ works | Background service on `127.0.0.1:49374`; Basic auth via `service.json` password. Every probe used it successfully |
| Q2 | OpenAPI spec served, matches version | ✅ yes | `GET /openapi.json` → 200, 276 KB, 118 paths; saved version-stamped |
| Q3 | `attach` — API sessions visible in TUI tabs? | ✅ mostly | API-created session appears in `opencode session list` **iff cwd matches the session's directory** (`spike/work` ✓, repo root ✗). Same mechanism TUI tabs use (per-directory). Human eyeball check of a TUI tab still pending |
| Q4 | TUI exposing a port (no server needed)? | ✅ not needed | One shared background service; TUI and API use it. `opencode --server <url>` flag exists. Mesh uses the service directly — no separate `serve` required |
| Q5 | Session discovery + tab→session mapping | ✅ yes | `GET /api/session` lists all (19 pre-existing + spike sessions). Mapping = working directory (`location.directory`, `subpath`) |
| Q6 | Sync prompt send + reply | ✅ yes | `POST /api/session/{id}/prompt {text}` → 200 with inbox receipt `{id, sessionID, delivery}` in 7–637 ms |
| Q7 | Async (returns while work continues) | ✅ yes | POST returns in ms; execution lifecycle (`execution.started` … `execution.succeeded`) arrives after via SSE. Two prompts accepted 67 ms apart, both executed |
| Q8 | Event stream, types, session IDs | ✅ yes | `GET /api/event` SSE, frames `{event:"message", data:{..., type:"session.*"}}`. Lifecycle: `inbox.enqueued → execution.started → instructions.updated → inbox.delivered → step.started → reasoning/text.* → step.streamed → step.ended → usage.updated → execution.succeeded`. 15 frames for a trivial prompt. `data.data.sessionID` carries the session; frames also carry `location` |
| Q9 | Subscribe-before-send / loss | ✅ loss confirmed | Late subscriber (+2 s) got only the 11 post-connect frames, missed the first 4. **Subscribe first, then send — mandatory** |
| Q10 | Drops across reconnects / resume | ⚠️ partial | Kill + reconnect re-establishes the stream; terminal events for both sessions were still observable after reconnect and history reconciled. No replay support observed — design assumes **no replay**: events are hints, message history is truth |
| Q11 | `idle` semantics (blocked/error/abort?) | ✅ mostly | `idle` message carries `outcome: succeeded \| failed \| interrupted`. Abort verified: `POST interrupt` → `{"interrupted":true}`, `idle.outcome=interrupted`. Blocked-on-permission untested — defaults auto-allow in-dir writes (see Q14), so the state was never hit. Error outcome untested live |
| Q12 | Full history incl. tools/edits | ✅ yes | `GET /api/session/{id}/message`: `{user(text), assistant(agent, model{id,providerID}, content[reasoning\|text\|tool], snapshot{start,end}), idle(outcome)}`. Complete enough to be source of truth |
| Q13 | Diff/state access | ✅ API chosen (+ caveat) | `GET /api/session/{id}/diff` → `{data:[{file, patch (unified), additions, deletions, status}]}`. Verified with a real created file. **Caveat (contract test): returns 0 entries when the session directory is not inside a git repo** (agent-created file proven on disk, diff empty). Contract tests `git init` the temp workdir. Git (`git diff`) available as fallback |
| Q14 | Permissions visible/answerable; config | ⚠️ partial | Default policy auto-allows in-dir file writes — **zero `permission.*` events** during a real file-creation turn. Reply endpoint exists (`POST .../permission/{id}/reply {decision}`). Ask-mode config + live Q&A deferred to Phase 4 (needs deliberate `permissions` ruleset on session create) |
| Q15 | Structured output (`json_schema`) | ✅ works by instruction, 1/1 | **No `json_schema`/`outputFormat` facility in the v2 prompt API** (absent from spec). Instead: prompt demands raw JSON, AutoSlave strips fences, parses, schema-validates. Reviewer returned schema-valid `reject` (1 issue, 3 `next_actions`) first try. 20-run matrix deferred to Phase 2 with the real reviewer model |
| Q16 | Abort + post-abort state | ✅ yes | `POST .../interrupt` → `{"interrupted":true}` mid-story; history ends `idle:interrupted`. Session accepted new prompts afterwards (steps C→D ran on one session; part 3 reused it again) |
| Q17 | Server restart persistence | ❌ untested | Deliberately not tested: restarting the shared service would disturb live sessions, including the harness session running this spike. Design assumes persistence + reconcile-on-start; verify in Phase 4 |
| Q18 | Working directories per session | ✅ yes | Sessions created with `location:{directory}` (`spike/work`); 19 pre-existing sessions span many directories on one server. Engine for future worktrees: `subpath` + per-turn git `snapshot` hashes observed |
| Q19 | Different models per session/prompt | ✅ yes | `POST .../model {model:{id,providerID}}` → 204; subsequent turns report `model:{id:"mimo-v2.6-flash-free",providerID:"opencode"}`. Anthropic key present in env (`opencode auth list`) → paid-provider reviewer possible in Phase 2 |
| Q20 | Server auth model | ✅ yes | Basic auth, user `opencode`, password in `service.json`; localhost bind. Mesh reads both programmatically (URL via `opencode service status`) |
| Q21 | Concurrent sessions, no interference | ✅ yes | Two sessions prompted 67 ms apart executed concurrently; both answered correctly (CONC-A/CONC-B); terminal events distinguished by `sessionID` |
| Q22 | TUI control endpoints | ✅ absent in v2 | No `/api/tui/*` in served spec (v1 SDK had them). Verdict: **ignore** — mesh never touches the TUI |
| Q23 | Official SDK fit | ❌ incompatible | `@opencode-ai/sdk@1.19.0` (latest) uses v1 paths (`/session/…`, base `http://localhost:4096`), no `/api` prefix → session/event calls 404 against 2.0.28. **Use a hand-rolled fetch client against the served spec** (revisit if SDK ships v2 support) |
| Q24 | API stability / pin | ✅ pinned | Pin **2.0.28**. Stability across releases unknown; adapter must tolerate unknown events/fields (preserve raw, never drop) |

## Incidents / surprises

1. **`POST .../wait` returned 204 in 290 ms while the turn was still running** (called
   immediately after prompt). Called after `execution.started` it returned ~at completion
   (1615 ms). Cause unclear (experimental endpoint; may key off inbox drain, not turn end).
   → wait is auxiliary only; completion = terminal SSE event + history reconcile.
2. **Spike script parsed v1 message shape (`parts`)** and reported empty history; raw dump
   showed v2 shape (`content[]`) with the correct "SPIKE-OK" reply. Fixed; lesson: trust raw
   captures over first-pass parsers.
3. **Reviewer explored the filesystem** (read spike scripts/findings, ran shell) despite
   "reply with ONLY JSON" — it still delivered valid JSON, but burned many steps and saw
   out-of-scope files. → Reviewer prompts must forbid tools and carry bounded packets only;
   working-dir confinement is convention-only in v2 (supports Phase 4 policy/worktree need).
4. `prompt` default `delivery` observed as `"steer"` on an idle session.
5. `opencode`/`autoslave` shims resolve via `shell:true` spawn on Windows (`opencode.cmd`,
   `autoslave.ps1`); bare `execFile` without shell fails with ENOENT. Adapter must spawn
   through shell or use absolute paths on Windows.
6. npm registry name `autoslave` is taken (v1.1.1); package stays `private:true`, no conflict.
   Publish later needs a scoped name.

## Phase 0 success criteria (MAIN_PLAN §3) — status

- [x] Q3, Q5, Q6–Q8, Q11, Q12, Q15, Q16 answered with recorded evidence (Q11/Q14/Q10 partial, reasons noted).
- [x] Script drives a real session end to end with no terminal scraping.
- [x] Second session returns schema-valid verdict (1/1; matrix deferred).
- [x] Decision record complete (`spike/findings/decision-record.md`).
