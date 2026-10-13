# AutoSlave — MAIN PLAN

> **Purpose of this document:** explain *how* the project is built and *in what order*. It is the implementation roadmap, from the smallest possible proof to the eventual one-command workflow.
>
> **Read first:** `CONTEXT.md` (vocabulary and rationale). **Related:** `FEATURES.md` (what each capability does), `WHAT_NOT_TO_DO.md` (guardrails to consult at every phase).

---

## 1. Planning principles

1. **Smallest proof first.** The first thing built is a throwaway script that drives one OpenCode session from outside. Architecture comes after evidence.
2. **Evidence, not assumptions.** Every claim about OpenCode's behavior is either validated against the *installed version* and recorded, or marked **[VERIFY P0]**.
3. **Each phase has a gate.** A phase is complete only when its evidence exists. Work on the next phase does not start before that.
4. **Aggressive scope control.** Each phase lists what must *not* be built yet. If something is not listed under "must build", it waits.
5. **Architecture only as needed.** Components are introduced in the phase that first needs them, in their smallest useful form.
6. **Destination ≠ start.** The one-command autonomous workflow (Phase 6) is the destination. It must not shape Phases 0–2.

### 1.1 Why the MVP is the anti-scope-creep mechanism

The MVP is **two real OpenCode sessions, one coder and one independent reviewer, looping through AutoSlave with no manual copy-paste.** It is deliberately the smallest thing that still demonstrates the central thesis: *independent agents can be turned into a collaborating team by an external layer.*

It works as a scope-control device because:

- It forces the hardest, riskiest problem (reliable programmatic control and observation of OpenCode) to be solved first.
- It gives every proposed feature a simple test: *does this help the Coder ↔ Reviewer loop work, or is it for later?*
- It is demonstrable in one sitting; there is no ambiguity about whether it works.
- Everything else (testers, debuggers, planners, graphs, worktrees, UIs) is only valuable **if** the loop is real. Building them before proving it risks building on a mechanism that may not work.

**Rule:** nothing past Phase 2 starts until the Phase 2 evidence exists.

### 1.2 Status labels

| Label | Meaning |
|---|---|
| **[VERIFY P0]** | An assumption about OpenCode that must be validated in Phase 0 before any design depends on it. |
| **MVP** | Phases 0–2. |
| **Post-MVP** | Phases 3–4. |
| **Future** | Phases 5–6. |

---

## 2. Roadmap at a glance

| Phase | Name | Tier | One-line outcome |
|---|---|---|---|
| 0 | Technical validation spike | MVP | Evidence of exactly how installed OpenCode can be controlled externally |
| 1 | Adapter + Agent Registry | MVP | A typed, tested way to register, prompt, observe and abort sessions |
| 2 | Coder ↔ Reviewer loop | MVP | Two real sessions loop to approval with no manual copy-paste |
| 3 | Deterministic verification | Post-MVP | Tests/build/lint/typecheck gate approval |
| 4 | Isolation and safety | Post-MVP | Worktrees, static permissions, pause/kill/timeout, crash recovery |
| 5 | Task graph + configurable agent graphs | Future | Multi-task workflows with user-defined agent connections |
| 6 | One-command autonomous workflow | Future | `autoslave run "..."` runs the whole team |

---

## 3. Phase 0 — Technical validation spike

### Objective
Establish, with evidence, exactly how the user's **installed OpenCode version** can be controlled externally: discovering sessions, sending prompts, receiving events, detecting completion, handling permissions, producing structured output, aborting, and surviving restarts.

### Why it exists
The whole project depends on reliable programmatic access to OpenCode. Public documentation and community SDKs suggest a local HTTP server with an OpenAPI spec, an event stream, an official JS/TS SDK, `json_schema` structured output, and permission-response endpoints. These are **leads, not facts for your version.** If they do not hold, the design changes before any code is written.

### Dependencies
A working OpenCode installation with at least one configured provider/model. A second provider/model is needed later for reviewer independence (Q15).

### What must be investigated
Each item is a question with a defined test and a defined evidence artifact. Record the OpenCode version first (Q0).

| # | Question | How to test | Evidence to record |
|---|---|---|---|
| Q0 | Exact OpenCode version; where is it documented? | `opencode --version`; note install method | Version string in findings note |
| Q1 | Does `opencode serve` start a local server? Port, host binding, default auth? **[VERIFY P0]** | Start it; call its health/doc endpoints | Command, port, response samples |
| Q2 | Is an OpenAPI spec served, and does it match the installed version? **[VERIFY P0]** | Fetch the spec; save it | Saved spec file, version-stamped |
| Q3 | Does `opencode attach <url>` connect a normal TUI tab to a running server? Do sessions created via API appear in that tab? **[VERIFY P0]** | Run server + attach tab; create a session over the API; observe | Notes plus screenshot or terminal capture (for the human record only; AutoSlave never depends on it) |
| Q4 | Can a normally started `opencode` TUI also expose a port (so no server is needed)? **[VERIFY P0]** | Start TUI with port option if one exists; probe | Yes/no with command |
| Q5 | **Session discovery:** can all sessions be listed, and can the one a given tab is displaying be identified? **[VERIFY P0]** | List sessions via API; create one in a tab; compare | Listing output; mapping method (or "not possible") |
| Q6 | **Send prompt (sync):** can an external client send a prompt to an existing session and get the assistant reply? **[VERIFY P0]** | Call the prompt endpoint; compare with tab | Request/response samples |
| Q7 | **Send prompt (async):** does an async prompt return immediately while work continues? **[VERIFY P0]** | Call async prompt; time the return | Timing log |
| Q8 | **Events:** is there an event stream (session-scoped and/or global)? Which event types appear for a prompt's lifecycle? Do they carry session IDs? **[VERIFY P0]** | Subscribe; send a prompt; record all events | Raw event capture file |
| Q9 | **Subscribe-before-send:** are events lost if the subscription opens after the prompt? **[VERIFY P0]** | Send first, subscribe second; compare | Comparison note |
| Q10 | **Event reliability:** are events dropped across reconnects? Is there resume support? **[VERIFY P0]** | Kill/reopen the stream mid-prompt | Gap analysis |
| Q11 | **`session.idle`:** is there an idle/finished signal, and when exactly does it fire? Does it fire when the agent is blocked on a permission prompt, errors, or is aborted? **[VERIFY P0]** | Trigger each condition; record events | Table: condition → events observed |
| Q12 | **Message history:** can full history (including tool calls, file edits) be fetched for a session? Is it complete enough to be the source of truth? **[VERIFY P0]** | Fetch after a prompt; compare with events | Comparison note |
| Q13 | **Diff/state access:** can AutoSlave obtain changed files and diffs (via OpenCode, or via Git directly)? **[VERIFY P0]** | Try the API; fall back to `git diff` | Chosen method |
| Q14 | **Permissions:** are permission requests visible as events? Can a client answer them? Which tool actions trigger them? Can OpenCode config pre-set allow/ask/deny per tool or per agent? **[VERIFY P0]** | Configure ask mode; trigger an edit and a shell command; respond via API | Event samples; response samples; config used |
| Q15 | **Structured output:** does a `json_schema` response format work? Failure behavior and retry count? Works with the intended reviewer model? **[VERIFY P0]** | Request a verdict schema from the reviewer session, 20+ runs | Success rate; failure samples |
| Q16 | **Abort:** can a running prompt be aborted? State of the session after abort? Behavior mid-tool-call? **[VERIFY P0]** | Start a long task; abort | Behavior note |
| Q17 | **Server restart:** are sessions and history persisted? Do session IDs remain valid? What happens to in-flight work and to event streams? **[VERIFY P0]** | Restart the server mid-task | Behavior note |
| Q18 | **Working directories:** how does a session's working directory get set? Can two sessions on one server work in different directories (for Phase 4 worktrees)? **[VERIFY P0]** | Create sessions with different directories | Behavior note |
| Q19 | **Model selection per session/prompt:** can coder and reviewer use different providers/models? **[VERIFY P0]** | Set per session/prompt | Confirmed model in message metadata |
| Q20 | **Authentication:** how is the server secured (for example a password and Basic auth)? **[VERIFY P0]** | Enable and test | Config and test result |
| Q21 | **Concurrency:** can one server host several active sessions at once without interference? **[VERIFY P0]** | Run two simultaneous prompts | Observation |
| Q22 | **TUI control endpoints:** can AutoSlave show a notice or fill the prompt in a visible tab? Is that useful or a distraction? **[VERIFY P0]** | Try the endpoints | Verdict: use / ignore |
| Q23 | **SDK fit:** does the official JS/TS SDK match the installed version's API? Is it generated from the served spec? Are there gaps? **[VERIFY P0]** | Install SDK; run Q6–Q16 through it | Compatibility list |
| Q24 | **Version stability:** how fast does the API change? What version should be pinned? | Compare spec between releases if available | Pinned version decision |

### What must be built
- A **throwaway** script (no architecture) that: creates a session, subscribes to events *before* sending, sends an async prompt, waits for the completion signal, fetches message history, and requests a `json_schema` verdict from a second session.
- A `spike/findings/` folder with: the saved OpenAPI spec, raw event captures, request/response samples, and a **findings note** answering Q0–Q24.
- A **decision record** (see §10) fixing: topology (server + attach vs alternatives), completion-detection method, diff source, structured-output method, language/SDK choice, pinned OpenCode version.

### Success criteria
- Q3, Q5, Q6–Q8, Q11, Q12, Q15 and Q16 are answered with recorded evidence, and results are favourable enough to build on.
- A script drives a real session end to end with no terminal scraping.
- A second session returns a schema-valid verdict at an acceptable success rate.
- Decision record complete.

### Failure conditions
- No external way to send prompts into a *visible, attached* session → the topology must change (for example AutoSlave owns the sessions via the server and tabs only attach).
- No reliable completion signal → completion detection must be redesigned around message history plus a required structured completion report.
- Structured output unreliable on the intended reviewer model → pick another reviewer model or add a validate-and-retry layer in AutoSlave.
- If the programmatic route is fundamentally insufficient, the project premise is in question. Stop and reassess; do **not** fall back to terminal scraping silently.

### Explicitly NOT built yet
Daemon, registry, message bus, workflow engine, state store, CLI, any permission policy engine, any UI, any abstraction layer.

### Evidence that Phase 0 is complete
The `spike/findings/` folder plus the signed-off decision record, reviewed by the human owner.

---

## 4. Phase 1 — OpenCode adapter and agent registry

### Objective
Turn the spike into a small, typed, tested **adapter** and a minimal **Agent Registry**, so later phases never touch OpenCode directly.

### Why it exists
Isolates all OpenCode-specific behavior in one module (keeping OpenCode replaceable), and gives AutoSlave a stable vocabulary: agents, roles, status.

### Dependencies
Phase 0 decision record.

### What must be built
- **Adapter operations** (agent-neutral names; implementation per Phase 0 findings): `listSessions`, `createSession`/`attachSession`, `sendTask` (async), `subscribe` (events), `getHistory`, `getDiff`/`changedFiles`, `abort`, `status`.
- **Event normalization:** map OpenCode events to a small internal event set (for example `agent.started`, `agent.progress`, `agent.idle`, `agent.error`, `agent.permission_requested`). Unknown events are preserved raw, not dropped.
- **Reconciliation:** after an event-signalled stop, confirm against message history (events are a hint, history is truth, subject to Q10/Q12).
- **Minimal Agent Registry:** `{ id, role, sessionId, serverUrl, model, workdir, status }`, persisted to a simple local store.
- **Minimal CLI** (or script) to register, list, and send a one-off task to an agent.
- **Raw log:** every adapter call and event written to an append-only file.
- **Adapter contract tests** run against a real OpenCode server pinned to the validated version.

### Success criteria
- From the CLI: register two sessions, assign roles, send a task to one, watch it run to completion, read back its final message and changed files.
- Adapter survives an event-stream reconnect without losing the completion signal (via reconciliation).
- No part of the code outside the adapter references OpenCode endpoints.

### Failure conditions
- Completion is mis-detected in repeated runs (idle treated as success when work was blocked or failed).
- Adapter logic leaks OpenCode types into the registry or later components.

### Explicitly NOT built yet
Message bus, workflow engine, task graph, reviewer logic, permission policy, worktrees, multi-provider abstraction, plugin system, any UI.

### Evidence that Phase 1 is complete
Passing contract tests against the pinned OpenCode version, a recorded demo run (log file) of register → task → observe → read result, and a code check that only the adapter module imports OpenCode-specific code.

---

## 5. Phase 2 — The MVP: Coder ↔ Reviewer loop

### Objective
Prove the central thesis: **two real OpenCode sessions, one coder and one independent reviewer, collaborate through AutoSlave to reach an approved result, with no manual copy-paste.**

### Why it exists
This is the product's reason for being, and the first moment AutoSlave does something a pile of tabs cannot.

### Dependencies
Phase 1 complete. Phase 0 answers for Q11, Q12, Q13, Q15, Q19.

### What must be built
- **Daemon** (long-running local process) with the CLI as a thin client.
- **Task** object: objective, plan reference, state, iteration count.
- **Message bus (minimal):** persisted-before-delivery typed messages: `task.assign`, `task.result`, `review.request`, `review.verdict`, `feedback.apply`, `workflow.escalate` (`task.progress` optional). Each has an ID for idempotent re-delivery.
- **Workflow engine (minimal state machine):**
  ```
  CREATED → CODING → REVIEWING → (approve) → APPROVED
                          │
                          └─(reject)→ FIXING → REVIEWING → …
  any state → ESCALATED (iteration cap, timeout, malformed output, error)
  any state → PAUSED/KILLED (user)
  ```
- **Coder completion report** (structured): what was done, files changed, commands run, known gaps.
- **Context packet builder:** objective, relevant plan excerpt, diff since last review, coder report, previous verdict. No raw transcript by default.
- **Structured verdict** via instruction-following raw JSON (no `json_schema` facility in
  v2 API — Phase 0 decision D4), validated in AutoSlave with retry-then-escalate:
  ```json
  {
    "status": "reject",
    "summary": "...",
    "issues": [{ "id": "I1", "severity": "high", "file": "src/auth/session.ts", "description": "..." }],
    "next_actions": ["..."]
  }
  ```
  or `{ "status": "approve", "summary": "..." }`. Invalid output: retry once, then escalate. Never guess from prose.
- **Automatic feedback routing:** a `reject` verdict becomes a `feedback.apply` message to the coder.
- **Iteration limit** (configurable default, for example 5) and a **per-agent timeout**.
- **State store** (a single local SQLite file or equivalent) and **append-only audit log** recording every message, transition and decision.
- **CLI:** `autoslave start`, `autoslave agent add`, `autoslave agent role`, `autoslave run --task ... --plan ...`, `autoslave status`, `autoslave pause`, `autoslave resume`, `autoslave kill`, `autoslave log`.
- **Single-writer rule:** only the coder writes; the reviewer works read-only by convention in the MVP (enforced properly in Phase 4).

### Success criteria
A demonstration, repeatable, on a real small task with a real `plan.md`:

1. User registers two sessions and runs the task.
2. Coder works; autoslave observes through the adapter.
3. AutoSlave builds the context packet and the reviewer returns a schema-valid verdict.
4. On reject, the coder receives the `next_actions` automatically and fixes the project.
5. The reviewer reassesses the updated result.
6. The loop ends in `APPROVED`, or `ESCALATED` at the iteration limit.
7. **Zero manual copy-paste.** The audit log reconstructs every step.
8. Coder and reviewer use different models/providers where available (Q19).

Also: at least one run in which the reviewer rejects, the coder fixes, and the reviewer then approves. A demo with only a first-pass approval does not prove the loop.

### Failure conditions
- The reviewer rubber-stamps or hallucinates issues without inspecting the real diff (check by seeding a known defect and confirming it is caught).
- The loop oscillates or never converges (the cap must catch this, and the log must show why).
- Any step requires the human to relay information.
- A malformed verdict stalls the workflow rather than escalating.

### Explicitly NOT built yet
Tester/debugger agents, task graph, configurable graphs, planner, worktrees, permission policy engine, dashboards, any UI, multi-provider abstraction, plugin API, crash recovery beyond "resume from the persisted state if the daemon restarts cleanly".

### Evidence that Phase 2 is complete
A recorded end-to-end run (audit log plus the final repository diff) containing at least one reject→fix→approve cycle; a seeded-defect run where the reviewer catches the defect; a note confirming no manual intervention.

---

## 6. Phase 3 — Deterministic verification

### Objective
Make objective checks (tests, build, lint, type check) a first-class signal so that approval means more than "another model agreed".

### Why it exists
Agents can share failure modes. Deterministic tools are independent of any model and are the project's source of truth. Consensus is not correctness.

### Dependencies
Phase 2.

### What must be built
- **Verification runner:** runs configured commands (for example test, build, lint, typecheck) in the target working directory; captures exit code, duration, and trimmed output.
- **Verification config:** per-project list of checks and which are *required for approval*.
- **Gate rule:** a workflow cannot enter `APPROVED` unless required checks pass, even if the reviewer approves. Failing results are attached to the next `feedback.apply`.
- **Optional tester agent role:** an OpenCode session that writes or runs tests; its structured result joins the packet. (AutoSlave-run commands are enough for the first version; an agent tester is optional.)
- **Result summarization** into the context packet (failure excerpts, not full logs).

### Success criteria
- A seeded failing test blocks approval even when the reviewer approves.
- Failing output reaches the coder automatically and the loop continues.
- The audit log shows which signal (reviewer or check) caused each decision.

### Failure conditions
- Flaky checks cause endless loops (needs retry policy and the iteration cap).
- Check output floods the context packet.

### Explicitly NOT built yet
Debugger agent, parallel test orchestration, coverage analytics, CI integration, UI.

### Evidence that Phase 3 is complete
Recorded runs: (a) tests fail, reviewer approves, autoslave blocks; (b) tests pass, reviewer rejects, autoslave continues; (c) both pass, autoslave approves.

---

## 7. Phase 4 — Isolation and safety

### Objective
Make AutoSlave safe to leave running: no uncontrolled writes, no self-granted permissions, no permanent stalls, and recoverable state.

### Why it exists
Once more than one agent can act, shared working trees, permissive tools and stuck processes become the main risk.

### Dependencies
Phases 2–3; Phase 0 answers for Q14, Q16, Q17, Q18.

### What must be built
- **Git worktree isolation:** each writing agent works in its own branch/worktree; reviewers read the author's worktree; approved changes are applied through a **controlled merge** step.
- **Static permission policy:** a user-owned config mapping roles to capabilities (read, write, execute allowlist, paths). AutoSlave **answers permission requests from rules** (allow / deny / escalate-to-human); no model output counts as approval. OpenCode's own permission settings are configured to match, as a second layer.
- **Server hardening:** bind to localhost, enable the server password.
- **Controls:** pause, resume, kill (agent and workflow), per-agent timeouts, per-task budgets (iterations, time, and cost where measurable).
- **Crash recovery:** on daemon restart, reload state, reconcile each agent against its OpenCode session and message history, and resume or escalate. Handle a vanished session or server.
- **Failure taxonomy:** timeout, agent error, malformed output, permission denied, merge conflict. Each has a defined workflow response.

### Success criteria
- Two writing agents work simultaneously without touching each other's files.
- A reviewer attempting to write is denied by policy, and the denial is logged.
- Killing the daemon mid-loop and restarting resumes the workflow correctly.
- A deliberately hung agent times out and the workflow pauses or escalates rather than blocking forever.

### Failure conditions
- Permission decisions depend on anything model-generated.
- Recovery duplicates a message (for example sends the same feedback twice).
- Merges silently overwrite changes.

### Explicitly NOT built yet
Complex policy languages, remote or multi-machine operation, containers or OS sandboxing (unless Phase 0 Q14 shows OpenCode's permissions are too weak, in which case add OS-level isolation as a targeted measure), UI.

### Evidence that Phase 4 is complete
Scripted tests for each success criterion, with their logs.

---

## 8. Phase 5 — Task graph and configurable agent relationships

### Objective
Handle objectives larger than one task, and let the user define which agents connect to which.

### Why it exists
Real work has subtasks and dependencies, and different projects need different team shapes (Planner → Coder, Coder → Tester, Tester → Debugger, Debugger → Coder, Coder → Reviewer, Reviewer → Coder).

### Dependencies
Phases 2–4.

### What must be built
- **Task graph:** tasks, dependencies, states, ready-set computation.
- **Agent graph config:** declarative edges (`from`, `to`, `on` event or condition, `payload` selection). Examples: "reviewer monitors coder"; "debugger activates only when tests fail".
- **Workflow definitions** built from the graph, validated at load (no cycles without a cap, no orphaned roles).
- **Debugger role** integration (diagnosis and proposed fix steps routed to the coder).
- **Planner role** producing a plan and decomposition that AutoSlave parses from structured output.

### Success criteria
- A multi-task objective completes with dependencies respected.
- Changing the agent graph config changes behavior without code changes.
- A conditional edge (debugger only on failure) fires correctly.

### Failure conditions
- Graph config becomes a programming language.
- Planner output cannot be reliably parsed into tasks.

### Explicitly NOT built yet
Visual graph editors, dynamic agent spawning at scale, plugin ecosystem, cross-provider framework.

### Evidence that Phase 5 is complete
Two different graph configs run on the same objective with different, correct behaviors; logs show conditional routing.

---

## 9. Phase 6 — One-command autonomous workflow

### Objective
`autoslave run "Build this feature according to plan.md"` takes a requirement through planning, implementation, testing, review, debugging and approval.

### Why it exists
It is the vision: the user supplies the objective; OpenCode remains the worker; AutoSlave is the manager.

### Dependencies
Phases 0–5, all gates passed.

### What must be built
- Session provisioning (create or attach the needed sessions with roles) from a default graph.
- Default workflow template wiring Phase 2–5 pieces together.
- Final integration review on merged work and a completion report to the user.
- Escalation UX in the CLI (clear stop reasons).

### Success criteria
A small real feature goes from one command to an approved, merged result with an audit trail, and every non-approved path ends in a clear escalation rather than silent failure.

### Failure conditions
Success depends on hidden human intervention; or the workflow is unbounded.

### Explicitly NOT built yet
Anything that is not wiring of proven parts: new capabilities appear in earlier phases first.

### Evidence that Phase 6 is complete
A recorded one-command run with full audit log and a human review of the result.

---

## 10. Decision record template (produced in Phase 0, extended later)

```
Decision:              <e.g. Topology>
Options considered:    <A, B, C>
Evidence:              <link to findings / captures>
Chosen:                <option>
Why:                   <1–3 sentences>
Reversal conditions:   <what new evidence would reopen this>
Pinned OpenCode ver.:  <version>
Date / owner:          <...>
```

Decisions to record in Phase 0: topology (single server + attach, or alternative); completion detection method; diff source; structured-output method; reviewer model; implementation language and SDK usage; pinned OpenCode version.

---

## 11. Architecture, only as needed per phase

| Component | Introduced in | Minimal form at introduction |
|---|---|---|
| OpenCode adapter | Phase 1 | Thin typed module; the only OpenCode-aware code |
| Agent registry | Phase 1 | Small persisted list of agents |
| Audit/raw log | Phase 1 | Append-only file |
| Daemon + CLI | Phase 2 | One process; CLI as thin client |
| Message bus | Phase 2 | Persisted typed messages with IDs |
| Workflow engine | Phase 2 | Hard-coded Coder ↔ Reviewer state machine |
| State store | Phase 2 | Single local database file |
| Verification runner | Phase 3 | Command runner with exit-code semantics |
| Worktree manager, policy engine, recovery | Phase 4 | Focused modules behind clear interfaces |
| Task graph, agent graph config | Phase 5 | Declarative config + validator |

---

## 12. Recommended implementation order

1. **Phase 0 spike** (script, not architecture). Record the decision record.
2. **Choose language/SDK from evidence.** TypeScript is the likely choice because OpenCode ships an official, OpenAPI-generated JS/TS SDK (per public docs), which should minimize friction. **Verify in Phase 0 (Q23)** that the SDK matches the installed version; if it lags, generating a client from the served OpenAPI spec is the fallback. Do not assume.
3. **Adapter** with contract tests against the pinned server.
4. **Registry + raw log.**
5. **Daemon skeleton + minimal CLI** (start, status, register).
6. **Message bus + state store + audit log.**
7. **Workflow engine** for the review loop, first with a *fake* reviewer returning scripted verdicts to prove routing, then with a real reviewer session.
8. **Context packet builder + completion report schema.**
9. **Structured verdict end to end**, with retry-then-escalate.
10. **MVP demonstration** (with a seeded defect).
11. Only then: verification runner (Phase 3), then Phase 4, and so on.

Suggested first-pass repository layout (illustrative; adjust per Phase 0):

```
spike/              # Phase 0 scripts and findings
src/adapter/        # OpenCode-specific code only
src/registry/
src/bus/
src/workflow/
src/store/
src/cli/
docs/               # CONTEXT.md, MAIN_PLAN.md, FEATURES.md, WHAT_NOT_TO_DO.md
```

---

## 13. Phase gate checklist (use before starting any phase)

- [ ] Previous phase's evidence exists and is stored.
- [ ] All **[VERIFY P0]** items this phase relies on are answered.
- [ ] The phase's "must not build yet" list has been read.
- [ ] `WHAT_NOT_TO_DO.md` checklist passes for every planned work item.
- [ ] A clear, demonstrable success criterion is written down before coding begins.
