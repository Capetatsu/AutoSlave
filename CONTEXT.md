# AutoSlave — CONTEXT

> **Purpose of this document:** explain *what* the project is and *why* it exists, for a reader who has never heard of it. Read this first. It defines the vocabulary used by every other document.
>
> **Companion documents:** `MAIN_PLAN.md` (how and in what order) · `FEATURES.md` (what the product can do) · `WHAT_NOT_TO_DO.md` (what must not be built or done).

---

## 1. One-paragraph summary

AutoSlave is a **local orchestration layer that connects independent OpenCode agent sessions into a coordinated multi-agent engineering team**. It lets those sessions exchange context, review each other's work, assign follow-up actions, react to failures, and iterate toward a shared goal, without the human manually carrying messages between terminal tabs. OpenCode remains the coding environment and agent runtime. AutoSlave is the **manager above it**.

The central claim of the project, which every other decision must serve:

> Multiple OpenCode agents that normally have no awareness of each other can be turned into a collaborative engineering team by an external coordination layer.

---

## 2. The problem

### 2.1 What working with several OpenCode sessions looks like today

A developer opens several terminal tabs, each running an OpenCode session. Each session:

- has its **own conversation context** and knows nothing about the others;
- may use a **different model or provider**;
- works on the same project but is **unaware** of what the other sessions are doing;
- only acts when **a human types something** into it.

So the human becomes the communication layer. A typical manual cycle:

1. Ask tab 1 to implement a feature.
2. Wait. Read what tab 1 says it did.
3. Copy that summary (and maybe a diff) into tab 2, which is acting as a reviewer.
4. Read the reviewer's feedback.
5. Copy the feedback back into tab 1.
6. Repeat until satisfied.

### 2.2 What is wrong with that

- **The human is the message bus.** Every hop is manual copy-paste.
- **The human is the workflow engine.** Only the human decides who should act next.
- **Context is lost or distorted** in each copy. Important details get dropped, irrelevant ones get pasted.
- **Nothing is recorded.** There is no durable account of what was asked, what came back, and why a decision was made.
- **It does not scale.** Two tabs are tolerable; four tabs with different roles are exhausting.
- **Review quality is unmanaged.** Nobody ensures the reviewer saw the actual diff, the plan, or the test output.

Multiple tabs give more *parallelism*. They give no *collaboration*.

---

## 3. The core idea

Introduce a program that sits **above** OpenCode and does the routing, judging-of-state, and sequencing that the human does today:

- It knows which OpenCode sessions exist and what **role** each plays.
- It sends **tasks** to the right session.
- It **observes** sessions through OpenCode's own programmatic interface (never by reading the terminal).
- It decides, from workflow state, **which agent should act next**.
- It builds the **context** the next agent needs and delivers it.
- It carries **structured results** (for example, an approve/reject verdict) from one agent to another.
- It **records** everything.

The terminal tabs remain exactly what they are: the visible face of OpenCode sessions. The user can still watch and intervene in them. But the tabs no longer need a human courier between them.

### 3.1 What this project is NOT

This boundary is stated in one place here and enforced in `WHAT_NOT_TO_DO.md`.

| It is **not** | Meaning |
|---|---|
| A new IDE | No editor, no file tree, no code views. |
| A replacement for OpenCode | OpenCode does all the coding, tool use and model interaction. |
| A new coding agent | AutoSlave never writes code itself and never calls a model to "do the work". |
| A custom TUI (initially) | The CLI is a thin control surface. No custom interface in the early project. |
| A terminal scraper | AutoSlave must not depend on reading terminal text or pixels. |
| An "AI software company" (initially) | The one-command autonomous workflow is the destination, not the starting point. |

---

## 4. The central concept, with a concrete example

### 4.1 Cast

- **Window 1 = Coder.** An OpenCode session told: "Implement the authentication system according to `plan.md`."
- **Window 2 = Reviewer / monitor.** A separate OpenCode session, ideally on a different model or provider, whose job is to judge Window 1's work.
- **AutoSlave.** A local daemon that sits between them.

### 4.2 What happens

1. The user gives AutoSlave an objective and a plan (`plan.md`).
2. AutoSlave sends the task to Window 1 and **observes Window 1 programmatically** through OpenCode's interface (events, status, message history), not by reading the screen.
3. Window 1 reaches a meaningful stopping point and reports what it did.
4. AutoSlave builds a **context packet** for Window 2: the objective, the relevant part of the plan, the diff, the coder's report, and any test results.
5. Window 2 **independently analyses** the work against the plan: is it correct, complete, safe? It inspects the actual code and may run permitted checks.
6. Window 2 returns a **structured verdict**.
   - Approve: `{ "status": "approve", ... }`
   - Reject: `{ "status": "reject", "issues": [...], "next_actions": [...] }`
7. On **reject**, AutoSlave automatically delivers the precise `next_actions` to Window 1. Window 1 changes the project and reports again.
8. AutoSlave sends the updated result to Window 2 for reassessment.
9. The loop ends on **approval**, or stops and **escalates to the human** when an iteration limit is reached.

At no point does the user copy and paste between windows.

### 4.3 Why the verdict must be structured

If the reviewer replies in free prose ("looks mostly fine, maybe check the expiry logic?"), AutoSlave must guess what to do. A structured verdict lets AutoSlave make a reliable decision: approve means stop; reject means route `next_actions` to the coder. AutoSlave decides from fields, not from interpreting tone.

---

## 5. Why opening multiple tabs is not collaboration

Collaboration requires **communication plus coordination**:

| Property | Multiple tabs | AutoSlave |
|---|---|---|
| Agents know others exist | No | Yes |
| Work product flows between agents | Only by human copy-paste | Automatic, via AutoSlave |
| Someone decides who acts next | The human | The workflow engine |
| Feedback reaches the author | Only if the human relays it | Automatic |
| Completion has a definition | The human's judgement | Approval plus deterministic checks |
| History of decisions | None | Append-only audit log |

Concurrency alone is not the goal. Five agents running at once with nobody connecting them is five isolated sessions, only faster at producing disagreement.

### 5.1 What makes this different from "just running multiple agents in parallel"

- **Parallel agents** split work and never talk. **AutoSlave** makes agents *depend on each other's output*: the reviewer's input is the coder's result; the coder's next step is the reviewer's verdict.
- **Parallel agents** have no shared notion of "done". **AutoSlave** defines done as independent review **and** deterministic checks.
- **Parallel agents** can clobber each other's files. **AutoSlave** treats shared-state safety as a design concern (isolation, one writer at a time).
- **Parallel agents** are unauditable. **AutoSlave** logs every message and decision with its cause.

---

## 6. Product philosophy

1. **OpenCode stays the worker.** AutoSlave adds coordination, not coding capability.
2. **Communication plus orchestration is the product.** Not window count, not UI.
3. **Programmatic interfaces only.** If OpenCode offers an official or stable interface, use it. Never scrape.
4. **Structured over prose.** Machine decisions come from structured fields wherever possible.
5. **Facts beat opinions.** Tests, builds, linters and type checks are sources of truth. Agent agreement is not.
6. **Independence is engineered.** Two copies of the same model are not two reviewers. Prefer different models or providers for author and judge.
7. **Policy beats trust.** Permissions are static, explicit rules enforced outside the model.
8. **Bounded by default.** Loops have limits, agents have timeouts, tasks have budgets.
9. **Everything is recorded.** If it is not in the log, it did not happen.
10. **Prove small before building big.** The first proof is two real sessions and one loop.
11. **OpenCode is replaceable at the adapter.** Orchestration concepts must not depend on OpenCode specifics, but the first implementation should not over-generalize.

---

## 7. Long-term vision

Eventually a single command starts an entire engineering process:

```
autoslave run "Build this feature according to plan.md"
```

A **planner/architect** turns the requirement into a plan and task graph. A **coder** implements. A **tester** runs deterministic checks. A **reviewer** independently judges. Failures go to a **debugger**, fixes go back to the coder, and the cycle repeats until deterministic checks and independent review agree the work is complete. Users can define **agent graphs**: which agents connect to which, and what flows along each connection.

This is the **destination, not the starting point**. The first milestone is far smaller (see `MAIN_PLAN.md`), and the vision must not distort it.

### 7.1 Status labels used in all documents

| Label | Meaning |
|---|---|
| **MVP** | Required for the first proof: Coder ↔ Reviewer loop with two real sessions. |
| **Post-MVP** | Planned after the loop is proven (tester, debugger, isolation, permissions, recovery). |
| **Future** | The long-term vision (task graphs, configurable graphs, planning, one-command autonomy). |

---

## 8. Terminology and mental model

These terms are used consistently across all four documents.

| Term | Definition |
|---|---|
| **OpenCode session** | One running OpenCode conversation with its own context, model and working directory. The unit AutoSlave talks to. A terminal tab is merely a view onto it. |
| **Agent** | An OpenCode session *as seen by AutoSlave*: a session plus an identity, a role, a working directory and a health status. |
| **Role** | The job an agent is assigned: coder, reviewer, tester, debugger, planner, architect, researcher. Roles carry responsibilities and (later) permissions. |
| **AutoSlave** | The whole system: the daemon, its components, and the CLI that controls it. |
| **Daemon** | The long-running local process at the centre of AutoSlave. It holds state, talks to OpenCode, runs workflows. |
| **CLI** | The thin command-line control surface for the daemon (start, register, assign, send, status, pause, resume, kill). Not a TUI. |
| **Adapter** | The only code that knows OpenCode's interface. Translates agent-neutral operations (send task, subscribe, fetch history, abort) into OpenCode calls. Makes OpenCode replaceable later. |
| **Agent Registry** | AutoSlave's record of which agents exist, their roles, and their status. |
| **Message bus** | The component that carries typed messages between agents and the workflow engine. Messages are persisted before delivery. |
| **Task** | A unit of work with an objective, status and an assigned agent. In the MVP there is one task. Later, tasks form a graph. |
| **Task graph** | Tasks with dependencies (Future). |
| **Workflow** | The state machine that decides who acts next for a task (for example CODING → REVIEWING → FIXING → REVIEWING → APPROVED). |
| **Orchestration** | The act of assigning work, routing information, and sequencing agents. AutoSlave's job. |
| **Review loop** | The repeating cycle Coder → Reviewer → Coder → Reviewer until approval or the iteration limit. |
| **Verdict** | The reviewer's structured judgement: `approve` or `reject` with issues and next actions. |
| **Context packet** | The bounded bundle of information AutoSlave sends to an agent: objective, plan excerpt, diff, results, prior verdict. Not a raw transcript. |
| **Structured output** | Machine-parseable agent output validated against a schema (for example a JSON Schema verdict). |
| **Deterministic verification** | Objective checks with reproducible results: unit tests, build, linter, type checker. A source of truth independent of any model. |
| **Agent graph** | A user-defined map of which agents are connected and what information flows along each connection (Future). |
| **State store** | Durable storage of task, agent and workflow state, enabling recovery. |
| **Audit log** | Append-only record of what happened and why. Distinct from mutable state. |
| **Escalation** | Handing control back to the human when AutoSlave cannot or should not proceed (iteration limit, repeated failure, policy block). |

### 8.1 Mental model in one picture

```
            you (objective, plan, final say)
                         │  CLI
                         ▼
    ┌──────────────── AUTOSLAVE (daemon) ────────────────┐
   │ Registry · Message bus · Workflow engine · State    │
   │ Audit log · (later) Policy engine, Task graph       │
   │                    ┌──────────┐                     │
   │                    │ Adapter  │  ← only OpenCode-   │
   │                    └────┬─────┘    specific code    │
   └─────────────────────────┼───────────────────────────┘
                             │ programmatic interface
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        OpenCode        OpenCode        OpenCode
        session         session         session
        (coder)         (reviewer)      (tester, later)
          ▲ tabs are only the visible face of these ▲
```

---

## 9. What is verified and what is not

The idea depends on OpenCode being controllable from outside. Public documentation and community SDKs indicate that OpenCode runs a local HTTP server with an event stream and that a JS/TS SDK exists, including support for structured JSON output and permission responses. **That is a lead, not a verified fact for your installed version.**

Everything about OpenCode's endpoints, events, session attachment, structured output and permission behavior is therefore treated as **"verify in Phase 0"** throughout these documents. Phase 0 is defined in `MAIN_PLAN.md`. Until it produces evidence, no design depends on an unverified capability.

---

## 10. How to read the four documents

| If you want to know… | Read |
|---|---|
| What this is and why it exists | `CONTEXT.md` (this file) |
| What to build, in what order, and how to know a phase is done | `MAIN_PLAN.md` |
| What the product can do, in detail, from the user's and the system's view | `FEATURES.md` |
| Whether a proposed feature or shortcut is allowed | `WHAT_NOT_TO_DO.md` |
