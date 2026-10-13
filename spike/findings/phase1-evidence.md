# AutoSlave — Phase 1 Evidence (Adapter + Agent Registry)

Date: 2026-10-14. Pinned OpenCode: v2.0.28. Decision basis: `spike/findings/decision-record.md`.

## What was built

- `src/adapter/types.ts` — v2 API shapes + normalized `AgentEvent` vocabulary.
- `src/adapter/client.ts` — server discovery (`opencode service status` + `service.json`
  Basic auth), typed `request`, shared SSE `subscribe` (no replay).
- `src/adapter/adapter.ts` — `OpenCodeAdapter`: `listSessions`, `getSession`,
  `createSession`, `setModel`, `sendTask` (async inbox receipt), `subscribeSession`
  (**must precede send**), `getHistory` (asc/desc), `getDiff`, `abort`,
  `waitForTurn` (history-first → terminal-event → history-reconcile; terminal event
  without matching `idle` is not accepted).
- `src/registry/registry.ts` — file-persisted `{id, role, sessionId, serverUrl, model,
  workdir, status}`; atomic writes; `AUTOSLAVE_HOME` override.
- `src/cli/index.ts` — minimal direct-mode CLI: `agent add/list/role/remove`,
  `send [--wait]`, `status`. No daemon yet (Phase 2).
- `bin/autoslave.js` delegates to `dist/src/cli/index.js` when built.

## Verification (all against the real pinned server)

- `npm run build` + `npm run typecheck`: clean (strict).
- `npm run test:unit`: **23/23 pass** (event normalization incl. unknown preservation,
  registry persistence/roles/status).
- `npm run test:contract`: **4/4 pass** (see `contract-final.log` in temp; trace saved as
  `spike/findings/adapter-demo-raw.log`):
  1. list sessions;
  2. create → subscribe-before-send → task → `waitForTurn` → `CONTRACT-OK` in history,
     `started`+`idle` events observed;
  3. agent-created file on disk + `session.diff` patch match + `abort` on idle session
     returns `false` without error;
  4. per-session model switch sticks (`mimo-v2.6-flash-free` in message metadata).
- CLI demo (real server, agent_8d8fbd): `agent add/list/role`, `status`
  (`outcome=succeeded model=mimo-v2.6-flash-free last=idle:succeeded`), and
  `send --wait` → `turn outcome=succeeded … text=CLI-OK`. Registry snapshot:
  `spike/findings/cli-demo-registry.json`.
- Confinement: no `/api/` references outside `src/adapter` (only the adapter import,
  a help string, and a comment in `src/cli`).

## Incidents fixed during Phase 1

1. `session.diff` returns 0 entries outside a git repo (agent-created file proven on
   disk). Contract workdir is now `git init`ed; caveat recorded in findings Q13 + D3.
2. Message pagination: `asc` pages from the oldest — `getHistory` gained an `order`
   param; `waitForTurn` reconciles newest-first; CLI `status` reads the true latest.
3. Free-tier model flaked once on exact-token obedience (`MODEL-OK`); contract asserts
   on-topic reply there, exact-token obedience on the default model (3/3).
   Mesh-side tolerant validation (retry/escalate) remains a Phase 2 requirement.
4. Explicit `process.exit(0)` with live sockets trips a Windows libuv assertion; CLI
   now exits naturally on success.

## Phase 1 success criteria (MAIN_PLAN §4) — status

- [x] CLI: register two sessions, assign roles, send task, watch to completion, read
      final message + changed files (contract tests + CLI demo above).
- [x] Reconnect survival via reconciliation (spike part 3: terminal events observed
      after mid-flight kill + history reconcile; `waitForTurn` history-first design).
- [x] Only the adapter references OpenCode endpoints (grep check above).

## Deferred to later phases (per plan)

Daemon, message bus, workflow engine, state store, verdict handling (Phase 2);
`wait`-endpoint auxiliary use; server-restart recovery; ask-mode permission Q&A (Phase 4).
