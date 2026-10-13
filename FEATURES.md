# AutoSlave — FEATURES

> **Purpose of this document:** define what the product can do, in terms of user behavior and system behavior. It is a capability definition, not a roadmap. For sequencing see `MAIN_PLAN.md`; for vocabulary see `CONTEXT.md`; for limits see `WHAT_NOT_TO_DO.md`.
>
> **Verification note:** every statement about how OpenCode behaves (endpoints, events, permissions, structured output, attach) is an assumption to be validated in Phase 0 **[VERIFY P0]**. Feature descriptions below say what the *AutoSlave* does; how OpenCode is driven is decided by Phase 0 evidence.

---

## 1. Tiers

| Tier | Meaning | Where it lands |
|---|---|---|
| **MVP** | Required for the first proof: two real OpenCode sessions, coder and reviewer, looping through AutoSlave | Phases 0–2 |
| **Post-MVP** | Planned once the loop is proven | Phases 3–4 |
| **Future** | The long-term vision | Phases 5–6 |

## 2. Feature index

| # | Feature | Tier |
|---|---|---|
| 1 | Agent registry | MVP |
| 2 | Session registration and discovery | MVP |
| 3 | Role assignment | MVP |
| 4 | Message routing (AutoSlave as the only channel) | MVP |
| 5 | Task assignment | MVP |
| 6 | Progress observation | MVP |
| 7 | Completion detection | MVP |
| 8 | Coder completion report | MVP |
| 9 | Context packets | MVP |
| 10 | Structured reviewer verdicts | MVP |
| 11 | Automatic feedback routing | MVP |
| 12 | Workflow state machine | MVP |
| 13 | Iteration limits and escalation | MVP |
| 14 | Audit log | MVP |
| 15 | CLI commands and status reporting | MVP |
| 16 | Pause / resume / kill | MVP (basic), Post-MVP (full) |
| 17 | Deterministic validation | Post-MVP |
| 18 | Tester integration | Post-MVP |
| 19 | Debugger integration | Post-MVP / Future |
| 20 | Git worktree isolation | Post-MVP |
| 21 | Controlled merging | Post-MVP |
| 22 | Static role-based permissions | Post-MVP |
| 23 | Crash recovery | Post-MVP |
| 24 | Model/provider diversity | MVP (supported), Post-MVP (managed) |
| 25 | Task graphs and dependencies | Future |
| 26 | Configurable agent-to-agent connections | Future |
| 27 | Planning | Future |
| 28 | One-command autonomous execution | Future |

---

## 3. Communication model (applies to every feature)

### 3.1 Agents never talk directly

All communication passes through AutoSlave. This is the central mechanism of the product. It gives AutoSlave the ability to persist, validate, bound, route and log every exchange, and it means no agent needs to know about any other agent's session.

### 3.2 Message types

| Type | From → To | Meaning |
|---|---|---|
| `task.assign` | autoslave → agent | Do this work, with this context |
| `task.progress` | agent/adapter → autoslave | Informational progress (optional, non-authoritative) |
| `task.result` | agent → autoslave | Work reached a stopping point; includes the completion report |
| `review.request` | autoslave → reviewer | Judge this work against this objective, with this packet |
| `review.verdict` | reviewer → autoslave | Structured approve/reject judgement |
| `feedback.apply` | autoslave → agent | Act on these specific next actions |
| `workflow.escalate` | autoslave → user | AutoSlave stops and asks the human, with the reason |

### 3.3 Message envelope (illustrative)

```json
{
  "id": "msg_0192",
  "type": "review.request",
  "taskId": "task_01",
  "from": "autoslave",
  "to": "agent_reviewer",
  "iteration": 2,
  "createdAt": "2026-10-05T10:14:03Z",
  "payload": { "...": "type-specific, schema-validated" }
}
```

Every message has an ID, is persisted before delivery, and is schema-validated. Redelivery after a crash is safe because IDs make it idempotent.

### 3.3.1 Structured over prose

Wherever AutoSlave must make a decision, the agent's output is requested and validated as structured data (for example JSON conforming to a schema). Free text may accompany it for humans. It is never the sole input to a workflow decision. Phase 0 (decision D4) found no schema-constrained facility in the installed v2 API, so AutoSlave requests raw JSON by instruction and validates it mesh-side.

### 3.4 Context packets, not raw transcripts

A **context packet** is a bounded bundle assembled for one purpose and one recipient.

```json
{
  "objective": "Implement authentication according to plan.md",
  "planExcerpt": "§3.2 Sessions expire after 30 minutes of inactivity...",
  "iteration": 2,
  "diff": "<changes since the last review>",
  "coderReport": { "...": "see Feature 8" },
  "checks": [{ "name": "unit", "status": "fail", "excerpt": "expiry test failed ..." }],
  "previousVerdict": { "issues": ["I1"], "next_actions": ["..."] }
}
```

Raw transcripts are **not** forwarded automatically because they:

- are large, expensive, and bury the signal in noise;
- carry the author's reasoning and framing, which biases the reviewer and reduces independence;
- may contain secrets, tool output and irrelevant detours;
- make behavior harder to reproduce and audit than a defined packet.

A transcript excerpt may be included deliberately, as a named, bounded field, when a specific decision needs it.

### 3.5 Deterministic checks decide completion together with review

| Reviewer verdict | Required checks | AutoSlave decision |
|---|---|---|
| approve | all pass | **APPROVED** |
| approve | any fail | Not approved; failing output goes to the coder |
| reject | pass | Continue; reviewer's `next_actions` go to the coder |
| reject | fail | Continue; both go to the coder |

Test, build, lint and type-check results are the objective signal. The reviewer is the independent-judgement signal. Neither alone defines "done". (Before Phase 3, the MVP has only the reviewer signal and says so in its logs.)

---

## 4. MVP features

### Feature 1 — Agent registry
**What it is:** AutoSlave's authoritative list of agents: `{ id, role, sessionId, serverUrl, model, workdir, status }`.

| Actor | Behavior |
|---|---|
| User | Runs `autoslave agent list` to see who exists and their status |
| AutoSlave | Persists agents; tracks status (`idle`, `working`, `blocked`, `error`, `unreachable`) |
| OpenCode | Holds the actual sessions the entries point to |
| Result | A trustworthy picture of the team |

### Feature 2 — Session registration and discovery
**What it is:** getting OpenCode sessions into the registry.

- **Discovery:** AutoSlave asks the OpenCode server which sessions exist **[VERIFY P0: listing, and mapping a visible tab to a session]**.
- **Registration:** the user explicitly registers a session by ID or URL: `autoslave agent add --session <id> --role coder`.
- **Creation (alternative):** AutoSlave creates a session and the user attaches a tab **[VERIFY P0: attach behavior]**.

Result: a registered agent that AutoSlave can prompt and observe.

### Feature 3 — Role assignment
**What it is:** binding a role to an agent. Roles in MVP: `coder`, `reviewer`. Others (`tester`, `debugger`, `planner`, `architect`, `researcher`) arrive later.

| Actor | Behavior |
|---|---|
| User | `autoslave agent role agent_2 reviewer` |
| AutoSlave | Records the role; attaches the role's standing instructions (a short role prompt) and, later, its permission set |
| OpenCode | Receives the role instructions as part of the first task or as configured **[VERIFY P0]** |
| Result | The agent behaves as the role expects; the workflow knows whom to ask for what |

### Feature 4 — Message routing
**What it is:** AutoSlave as the only channel between agents (see §3).

| Actor | Behavior |
|---|---|
| AutoSlave | Persists, validates, then delivers messages through the adapter; acknowledges delivery; retries safely |
| Agents | Receive messages as OpenCode prompts; emit results the adapter converts to messages |
| Result | Information moves between agents without the user |

### Feature 5 — Task assignment
**What it is:** giving work to an agent.

| Actor | Behavior |
|---|---|
| User | `autoslave run --task "Implement authentication" --plan plan.md --coder agent_1 --reviewer agent_2` |
| AutoSlave | Creates the task; builds a `task.assign` message with objective, plan reference and role instructions; sends it to the coder |
| OpenCode | Coder session starts working on the prompt (asynchronously, so AutoSlave can observe) |
| Result | Coder is working; workflow state is `CODING` |

### Feature 6 — Progress observation
**What it is:** AutoSlave watching an agent through OpenCode's programmatic interface: events, status, message history. Never terminal scraping.

- AutoSlave subscribes to the event stream **before** sending a prompt **[VERIFY P0: event loss]**.
- Events are normalized to internal types (`agent.started`, `agent.progress`, `agent.idle`, `agent.error`, `agent.permission_requested`).
- Events are a low-latency hint. Message history is the source of truth for what happened **[VERIFY P0]**.
- Progress is informational. It does not decide workflow transitions.

Result: live status in `autoslave status`, and a reliable trigger for completion detection.

### Feature 7 — Completion detection
**What it is:** deciding that an agent reached a *meaningful stopping point*.

An agent becoming idle is **not** proof of success. It may be blocked on a permission request, have failed, have been aborted, or have given up. AutoSlave considers an agent complete only when all hold:

1. The adapter reports it stopped (idle/finished signal) **[VERIFY P0: exact semantics]**.
2. History confirms no pending tool call or unanswered permission request.
3. A schema-valid **completion report** was produced.

If idle without a valid report: one reminder prompt requesting the report, then escalation. Result: a `task.result` message, or a classified failure.

### Feature 8 — Coder completion report
**What it is:** the coder's structured account when it stops.

```json
{
  "status": "complete",
  "summary": "Implemented login, logout and session storage.",
  "filesChanged": ["src/auth/login.ts", "src/auth/session.ts", "test/auth.test.ts"],
  "commandsRun": ["npm test"],
  "knownGaps": ["Session expiry not implemented"],
  "blockers": []
}
```

`status` is one of `complete`, `partial`, `blocked`. The report is a claim, not proof: the reviewer and checks verify it independently against the real diff.

### Feature 9 — Context packets
Defined in §3.4. AutoSlave builds one per `task.assign`, `review.request`, and `feedback.apply`. The packet builder is a single, testable component with size limits and a documented set of fields per message type.

### Feature 10 — Structured reviewer verdicts
**What it is:** the reviewer's machine-readable judgement.

```json
{
  "status": "reject",
  "summary": "Login works, but session expiry from plan.md §3.2 is missing.",
  "issues": [
    { "id": "I1", "severity": "high", "file": "src/auth/session.ts",
      "description": "No expiry check; plan requires 30-minute inactivity timeout." }
  ],
  "next_actions": [
    "Add an expiry check to validateSession() in src/auth/session.ts",
    "Add a unit test covering an expired session"
  ]
}
```
or
```json
{ "status": "approve", "summary": "All plan items implemented; no issues found." }
```

Rules:

- Requested as raw JSON by instruction (Phase 0 decision D4: installed v2 API has no
  `json_schema` facility), validated again by AutoSlave.
- Invalid or missing: retry once; then `workflow.escalate`. Never infer from prose.
- A reject must contain at least one `next_action`. A verdict with no actionable content is treated as invalid.
- Reviewer instructions require citing plan items and files, and inspecting the real diff rather than trusting the coder's report.

### Feature 11 — Automatic feedback routing
**What it is:** carrying a reject verdict back to the coder with no human involvement.

| Actor | Behavior |
|---|---|
| Reviewer | Returns a reject verdict |
| AutoSlave | Validates it, logs it, builds a `feedback.apply` packet (issues and next actions, plus the relevant plan excerpt) and sends it to the coder |
| Coder (OpenCode) | Receives it as a prompt, edits the project, stops |
| Result | New `task.result` → new `review.request` → reviewer reassesses |

### Feature 12 — Workflow state machine
**What it is:** AutoSlave's authority on who acts next.

```
CREATED ─► CODING ─► REVIEWING ─┬─► APPROVED
                 ▲              │
                 │              └─► FIXING ─► REVIEWING (iteration+1)
  any state ─► ESCALATED   any state ─► PAUSED ─► (resume) ─► previous state
  any state ─► KILLED
```

The engine, not any model, decides transitions. Transitions are recorded with their cause.

### Feature 13 — Iteration limits and escalation
- Configurable maximum review iterations (default small, for example 5), plus per-agent timeouts.
- Loop-health checks: if the reviewer repeats the same issues across iterations with no change in the diff, escalate early.
- `workflow.escalate` carries: reason, current state, last verdict, last report, and suggested human options (continue N more iterations, take over, abort).

### Feature 14 — Audit log
**What it is:** an append-only record, separate from mutable state.

```
seq  ts                task    agent     kind               detail
17   10:14:03          t01     autoslave      transition         CODING → REVIEWING (coder idle + valid report)
18   10:14:04          t01     autoslave      message.sent       review.request → reviewer (packet 4.1 KB)
19   10:15:40          t01     reviewer  message.received   review.verdict: reject (2 issues)
20   10:15:40          t01     autoslave      transition         REVIEWING → FIXING (verdict=reject, iteration 1/5)
```

It records every message, transition, adapter call, retry, timeout and escalation, with its cause ("why"). Used for debugging, trust, and replay.

### Feature 15 — CLI commands and status reporting
The CLI is a thin control surface for the daemon. No TUI.

| Command | Behavior |
|---|---|
| `autoslave start` / `autoslave stop` | Start or stop the daemon |
| `autoslave agent add / list / role / remove` | Manage the registry |
| `autoslave run --task ... --plan ...` | Create and start a review-loop workflow |
| `autoslave send <agent> "..."` | Send an ad-hoc task (diagnostic) |
| `autoslave status [--task t01]` | Show workflow state, iteration, each agent's status, last event |
| `autoslave log [--follow]` | Read or tail the audit log |
| `autoslave pause / resume / kill` | Control a workflow or agent |

Example `autoslave status` output:

```
task t01  "Implement authentication"   state: FIXING   iteration 2/5
  coder    agent_1  (model A)  working   since 10:15:41
  reviewer agent_2  (model B)  idle      last verdict: reject (2 issues)
```

### Feature 16 — Pause, resume, kill
- **MVP:** `pause` stops starting new steps; the in-flight agent step finishes or is aborted per choice. `resume` continues from persisted state. `kill` aborts the in-flight prompt through the adapter **[VERIFY P0: abort behavior]** and marks the task `KILLED`.
- **Post-MVP:** automatic timeouts, per-task budgets, and safe resume after crashes (Feature 23).

### Feature 24 — Model/provider diversity (supported in MVP)
Each agent records its model/provider **[VERIFY P0: per-session model selection]**. AutoSlave warns when author and judge use the same model, and the status output makes this visible. Managed policy (for example "reviewer must differ from coder") is Post-MVP.

---

## 5. Post-MVP features

### Feature 17 — Deterministic validation
**User:** configures checks once (`autoslave.config`: test, build, lint, typecheck commands; which are required).
**AutoSlave:** runs them in the target working directory after each coder result, records exit code, duration and a trimmed excerpt; attaches results to the review packet; enforces the decision table in §3.5.
**OpenCode:** is not involved in running these (AutoSlave runs them directly), unless a tester agent is used.
**Receives:** the reviewer sees check results as facts; the coder sees failing excerpts in `feedback.apply`.
**Result:** approval requires objective success, not agreement.

### Feature 18 — Tester integration
**User:** assigns a `tester` role to a session.
**AutoSlave:** after a coder result, sends the tester a packet (plan, diff, how to run tests); expects a structured result `{ status, testsAdded, testsRun, failures[] }`.
**OpenCode:** the tester session writes or runs tests within its permitted commands.
**Receives:** failures go to the coder, before the reviewer is bothered.
**Result:** reviewer sees only code that has already passed deterministic gates.

### Feature 19 — Debugger integration
**User:** assigns a `debugger` role.
**AutoSlave:** when checks fail repeatedly (configurable), sends the debugger the failing output and relevant diff; expects `{ diagnosis, suspectedFiles, proposedFix[] }`.
**Receives:** the coder gets the proposed steps through `feedback.apply`.
**Result:** a diagnosis-then-fix cycle without the coder searching blindly.

### Feature 20 — Git worktree isolation
**Behavior:** each writing agent gets its own branch and worktree. Reviewers read the author's worktree. Prevents agents overwriting each other's uncommitted changes and gives each change set a clean diff.
**Verification needed:** how a session's working directory is set and whether sessions on one server can use different directories **[VERIFY P0]**.

### Feature 21 — Controlled merging
**Behavior:** approved branches are merged by AutoSlave in a defined order, with conflict detection. On conflict AutoSlave escalates or routes a "resolve conflict" task to the owning agent. No silent overwrite. The merge is logged and reversible.

### Feature 22 — Static role-based permissions
**User:** edits a version-controlled policy file:

```yaml
roles:
  coder:    { read: ["**"], write: ["src/**","test/**"], exec: ["npm run *","git status"] }
  reviewer: { read: ["**"], write: [],                  exec: ["npm test","npm run lint","npm run typecheck"] }
  tester:   { read: ["**"], write: ["test/**"],         exec: ["npm test"] }
```

**AutoSlave:** answers OpenCode permission requests from these rules: allow, deny, or escalate to the human. It never accepts a model's statement as approval. Denials are logged with the matching rule.
**OpenCode:** raises permission requests for the relevant actions; its own permission settings are configured to match as a second layer **[VERIFY P0: event shape, response endpoint, config granularity]**.
**Result:** reviewers cannot write; coders cannot leave their boundaries; every decision is auditable.

### Feature 23 — Crash recovery
**Behavior:** AutoSlave persists workflow, agent and message state. After a daemon restart it reloads state, re-attaches to sessions, reconciles each against OpenCode message history, and resumes, or escalates if state is ambiguous. Message IDs prevent duplicate delivery. A vanished session or server marks the agent `unreachable` and pauses the workflow. **[VERIFY P0: server restart behavior]**

---

## 6. Future features

### Feature 25 — Task graphs and dependencies
An objective decomposes into tasks with dependencies (`t3 depends on t1, t2`). AutoSlave computes the ready set, dispatches ready tasks, and tracks per-task review loops.

### Feature 26 — Configurable agent-to-agent connections
The user declares relationships:

```yaml
agents: { planner: a1, coder: a2, tester: a3, debugger: a4, reviewer: a5 }
edges:
  - { from: planner,  to: coder,    on: plan.ready }
  - { from: coder,    to: tester,   on: task.result }
  - { from: tester,   to: debugger, on: checks.failed }
  - { from: debugger, to: coder,    on: diagnosis.ready }
  - { from: tester,   to: reviewer, on: checks.passed }
  - { from: reviewer, to: coder,    on: verdict.reject }
```

Graph view of the same configuration:

```
Planner ─► Coder ─► Tester ──pass──► Reviewer ──approve──► DONE
             ▲         │                │
             │       fail             reject
             │         ▼                │
             └──── Debugger ◄───────────┘ (optional route)
             └────────────────────────────┘
```

AutoSlave also supports simple monitor relationships ("Window 2 monitors Window 1"). Graphs are validated at load (no unbounded cycles, every role bound to an agent).

### Feature 27 — Planning
A planner/architect session produces a plan and task decomposition as structured output; AutoSlave parses it into a task graph. The human can review the plan before execution.

### Feature 28 — One-command autonomous execution
`autoslave run "Build this feature according to plan.md"` provisions or attaches sessions, runs planner → coder → tester → reviewer with debugger on failure, merges approved work, and reports. Every non-approved path ends in a clear escalation. This is the destination and does not change MVP design.

---

## 7. Worked example — reject then approve (MVP)

| Step | User | AutoSlave | OpenCode | Other agent receives | Result |
|---|---|---|---|---|---|
| 1 | `autoslave run --task "Implement auth" --plan plan.md` | Creates task t01, state CODING, sends `task.assign` | Coder session starts working | — | Coder working |
| 2 | — | Observes events; sees idle; checks history; gets valid report | Coder stops | — | `task.result` recorded |
| 3 | — | Builds packet (objective, plan §3, diff, report); sends `review.request` | Reviewer session starts | Packet | Reviewer analysing |
| 4 | — | Validates verdict (`reject`, 1 issue) | Reviewer returns schema-valid JSON | — | State FIXING |
| 5 | — | Builds `feedback.apply` from `next_actions` | Coder receives prompt, edits files, stops | Coder gets exact actions | New `task.result` |
| 6 | — | Sends second `review.request` with updated diff and previous verdict | Reviewer re-checks | Packet v2 | Verdict `approve` |
| 7 | Reads `autoslave status` | State APPROVED; audit log closed out | — | — | Done; zero copy-paste |

## 8. Worked example — failing test overrides approval (Post-MVP)

1. Coder reports complete. AutoSlave runs checks: unit tests fail.
2. Reviewer (given the failure in the packet) may approve the code structure.
3. AutoSlave blocks approval per §3.5, routes the failing output to the coder as `feedback.apply`.
4. Coder fixes; checks pass; reviewer approves; state APPROVED.
