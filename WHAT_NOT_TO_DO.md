# AutoSlave — WHAT NOT TO DO

> **Purpose of this document:** strict guardrails against scope creep and bad engineering. Consult it whenever a new feature, shortcut or dependency is proposed. **If a proposal violates a rule here, reject or postpone it.**
>
> **Related:** `CONTEXT.md` (why), `MAIN_PLAN.md` (order of work), `FEATURES.md` (what is in scope).

---

## 1. How to use this document

For every proposed feature, change or dependency:

1. Run the **Proposal Gate** (§5). Any "no" on a required item means reject or postpone.
2. Check the **Prohibitions** (§2) and **Technical anti-patterns** (§3) for a match.
3. Check the **Deferral list** (§4): if the item is deferred, state which phase unlocks it.
4. If you believe an exception is warranted, follow §6. Exceptions are recorded, not assumed.

The default answer to "should we also build X?" is **not yet**.

---

## 2. Prohibitions

Each rule has: the rule, why it exists, what to do instead.

### P1. Do NOT build a new IDE
- **Why:** The project is a coordination layer. An IDE is a different product with an enormous surface area, and it would duplicate what OpenCode already does.
- **Instead:** Let OpenCode be the coding environment. Expose coordination through the CLI.

### P2. Do NOT replace OpenCode or reimplement its coding functionality
- **Why:** Tool execution, file editing, model calls and context management are OpenCode's job. Reimplementing them splits effort and makes AutoSlave a competing agent.
- **Instead:** Drive OpenCode through its programmatic interface. If OpenCode lacks something, record it as a limitation or contribute upstream; do not build around it inside AutoSlave.

### P3. Do NOT create another coding agent
- **Why:** AutoSlave must never write code or call a model to "do the work". The moment it does, it stops being a coordinator and its verdicts lose independence.
- **Instead:** All code is written by OpenCode agents. AutoSlave only routes, sequences, validates and records.

### P4. Do NOT build a custom TUI or any graphical UI initially
- **Why:** The terminal tabs are already the visible representation. A custom interface consumes time that should go to proving the communication loop.
- **Instead:** A thin CLI and a readable audit log. Revisit UI only after Phase 6 gates pass, and only against demonstrated need.

### P5. Do NOT spend time on branding, visual polish, dashboards or visual features before orchestration works
- **Why:** None of it affects whether agents communicate reliably.
- **Instead:** Plain text output. Make `autoslave status` and `autoslave log` clear and complete; nothing more.

### P6. Do NOT scrape terminal text, screenshots or pixels when OpenCode provides a programmatic interface
- **Why:** Scraping is brittle, version-dependent, hard to test, and cannot reliably distinguish agent output from UI chrome. The whole premise is that tabs are only the visible face of sessions.
- **Instead:** Use the server API, events and message history. If Phase 0 shows no adequate programmatic interface for a needed capability, **stop and reassess**; do not silently fall back to scraping.

### P7. Do NOT build a giant autonomous "AI software company" before the basic loop is proven
- **Why:** Planners, task graphs, many roles and one-command autonomy all depend on a communication mechanism that is currently unproven. Building them first risks a large structure on a foundation that may not hold.
- **Instead:** Complete Phase 2 (two real sessions, Coder ↔ Reviewer, no copy-paste), with evidence. Then proceed in phase order.

### P8. Do NOT treat multiple copies of the same model as independent verification
- **Why:** Identical models share the same failure modes, blind spots and biases. Five identical reviewers agreeing is one opinion repeated.
- **Instead:** Prefer different models/providers for author and judge, and always combine review with deterministic checks. Surface "same model on both sides" as a warning in `autoslave status`.

### P9. Do NOT equate agent consensus with correctness
- **Why:** Agreement indicates similarity, not truth. Agents can confidently agree on wrong answers.
- **Instead:** Approval requires independent review **and** passing deterministic checks (tests, build, lint, type check). Checks can veto an approval.

### P10. Do NOT let an LLM approve its own permissions
- **Why:** A model granting itself capabilities defeats the purpose of permissions, and prompt injection could exploit it.
- **Instead:** Permissions are static, explicit, auditable rules enforced by AutoSlave (and mirrored in OpenCode's own configuration as a second layer). Permission requests are answered from rules: allow, deny or escalate to the human.

### P11. Do NOT allow uncontrolled simultaneous writes to a shared working tree
- **Why:** Concurrent edits cause lost work, corrupt state and unreproducible failures, and make diffs unattributable.
- **Instead:** MVP: single writer at a time. Phase 4: separate Git worktrees/branches per writing agent, with controlled merging and conflict handling.

### P12. Do NOT build multi-provider or plugin infrastructure before OpenCode-to-OpenCode communication works
- **Why:** Premature generalization produces abstractions shaped by guesses. It is the classic way to avoid finishing the hard part.
- **Instead:** The first implementation is OpenCode-specific. Keep OpenCode details inside the adapter so replacement stays possible, but do not design a second adapter or plugin API.

### P13. Do NOT confuse opening multiple tabs with agent collaboration
- **Why:** Tabs provide parallelism. Collaboration requires information flowing between agents and a defined notion of "next" and "done".
- **Instead:** Judge every demo by this test: *did one agent's output reach another agent, and change what it did, without a human relaying it?*

### P14. Do NOT use free-form prose as the sole mechanism for machine workflow decisions when structured output is available
- **Why:** Prose is inconsistent. Interpreting "mostly fine, perhaps tweak the expiry logic" invites silent mistakes in routing.
- **Instead:** Require schema-validated output (verdicts, completion reports, tester and debugger results). Validate in AutoSlave as well. On invalid output, retry once, then escalate. Never guess from prose.

---

## 3. Technical anti-patterns

| # | Anti-pattern | Why it is wrong | Do this instead |
|---|---|---|---|
| T1 | **Terminal scraping** (regexing a terminal buffer, OCR, screenshots) | Brittle, unverifiable, version-coupled | Programmatic interface only (see P6) |
| T2 | **Polling when an event mechanism exists** (looping `getStatus` every second) | Wasteful, adds latency, hides ordering | Subscribe to events; reconcile with message history on reconnect or ambiguity. Polling is acceptable only as a bounded fallback where Phase 0 proves events are unavailable or lossy |
| T3 | **Subscribing after sending** a prompt | Early events can be lost **[VERIFY P0]** | Subscribe first, then send |
| T4 | **Trusting events as the only truth** | Streams can drop frames across reconnects **[VERIFY P0]** | Treat message history as the source of truth; events as hints |
| T5 | **Forwarding unlimited conversation histories** between agents | Cost, noise, bias, leaked secrets, unreproducible behavior | Build bounded context packets (objective, plan excerpt, diff, results, previous verdict) |
| T6 | **Unbounded review loops** | Oscillation or non-convergence burns cost and time forever | Iteration cap, per-agent timeouts, task budgets, early escalation when issues repeat with no diff change |
| T7 | **Treating "idle" as proof of success** | An idle agent may be blocked on a permission prompt, errored, aborted, or have given up | Completion = idle signal **plus** history confirmation **plus** a valid completion report; then verify with the reviewer and checks |
| T8 | **Letting models set their own permissions** | See P10 | Static policy enforced by AutoSlave |
| T9 | **Multiple agents editing one working tree** | See P11 | One writer in MVP; worktrees later |
| T10 | **Believing the author's report instead of the diff** | A completion report is a claim | Reviewer and checks inspect the real changes |
| T11 | **Mutable-only state with no audit log** | Cannot explain or reproduce decisions; cannot debug loops | Append-only audit log of every message, transition and decision, with cause |
| T12 | **Sending messages without persisting first** | A crash loses or duplicates work | Persist with an ID, then deliver; idempotent redelivery |
| T13 | **Hard-coding OpenCode types throughout the codebase** | Makes replacement impossible and spreads breakage on API change | Confine OpenCode specifics to the adapter |
| T14 | **Assuming OpenCode behavior from docs or SDKs without testing** | Versions differ; community SDKs lag | Validate against the installed version in Phase 0 and pin it |
| T15 | **Silent fallbacks** (quietly switching to a weaker mechanism) | Hides that the foundation is failing | Fail loudly; record in the audit log; escalate |
| T16 | **Parsing prose to decide transitions** | See P14 | Structured outputs; retry then escalate |
| T17 | **Secrets and credentials in packets or logs** | Leaks to other agents or disk | Redact; keep policy-based path denylists; never forward environment dumps |
| T18 | **Exposing the OpenCode server without auth or beyond localhost** | Arbitrary local code execution risk | Bind to localhost; enable the server password **[VERIFY P0]** |
| T19 | **Building the graph/DSL before one loop works** | Generality with no proof | Hard-code Coder ↔ Reviewer in the MVP |
| T20 | **A reviewer that can write** | Judges become authors; independence and safety lost | Reviewer is read-only (by convention in MVP, by enforced policy in Phase 4) |

---

## 4. Deferral list

Things that are legitimate eventually but **must wait**. Each has an unlock condition.

| Item | Unlock condition |
|---|---|
| Tester / debugger / planner agents | Phase 2 evidence complete |
| Deterministic verification runner | Phase 2 evidence complete (it is Phase 3) |
| Git worktree isolation, controlled merging | Phase 3 complete |
| Static permission policy engine | Phase 3 complete (it is Phase 4) |
| Crash recovery beyond clean-restart resume | Phase 3 complete |
| Task graph, configurable agent graphs | Phase 4 complete |
| One-command autonomous workflow | Phase 5 complete |
| Second agent runtime or provider abstraction | Not before Phase 6, and only with a concrete, proven need |
| Plugin system | Not before Phase 6, and only against a concrete need |
| Custom TUI / web UI / dashboards | Not before Phase 6, and only if the CLI and logs demonstrably fail the user |
| Remote or multi-machine operation | Explicit decision after Phase 6 |
| Branding, theming, marketing site | Out of scope for the engineering plan |

---

## 5. Proposal Gate (checklist)

Answer every item for each proposal. **All "must" items must pass.**

**Scope**
- [ ] (must) Does it directly support the current phase's objective in `MAIN_PLAN.md`? If not, which later phase owns it?
- [ ] (must) Is it **not** on the Deferral list, or has its unlock condition been met?
- [ ] (must) Does it help the Coder ↔ Reviewer loop work? If the loop is not yet proven, a "no" here means postpone.
- [ ] Is there a smaller version that proves the same thing?

**Identity**
- [ ] (must) Does it avoid making AutoSlave an IDE, a coding agent, an OpenCode replacement, or a UI project?
- [ ] (must) Does it keep OpenCode as the worker and AutoSlave as the coordinator?

**Interface and correctness**
- [ ] (must) Does it use OpenCode's programmatic interface rather than scraping?
- [ ] (must) Does every OpenCode behavior it depends on have Phase 0 evidence, or is it marked **[VERIFY P0]** and blocked until verified?
- [ ] (must) Do machine decisions use structured output with validation and retry-then-escalate?
- [ ] (must) Is completion defined by more than "idle"?
- [ ] Are deterministic checks used as a source of truth where applicable?

**Independence**
- [ ] (must) Does it avoid presenting same-model agreement as verification?
- [ ] Is author/judge model diversity possible or at least visible?

**Safety**
- [ ] (must) Are permissions determined by static rules, not by a model?
- [ ] (must) Does it avoid simultaneous writes to one working tree?
- [ ] (must) Is every loop bounded (iterations, time, budget)?
- [ ] (must) Are messages persisted before delivery and recorded in the audit log?
- [ ] Is there a defined behavior for timeout, crash and failure?

**Context hygiene**
- [ ] (must) Does it avoid forwarding unlimited transcripts, using bounded context packets instead?
- [ ] Are secrets kept out of packets and logs?

**Architecture**
- [ ] (must) Is OpenCode-specific code confined to the adapter?
- [ ] (must) Does it avoid adding multi-provider abstraction or plugin infrastructure?
- [ ] Is the simplest thing that satisfies the phase's success criteria being built?

**Outcome:** all (must) items pass → approve. Any (must) fails → reject or postpone, naming the rule and, if postponing, the unlocking phase.

---

## 6. Handling exceptions

An exception is allowed only if:

1. The rule it breaks is named.
2. The reason is written down, with evidence that the rule's purpose is not served in this case (for example, Phase 0 shows no programmatic route for a capability).
3. The exception is time-bound and narrow, with a plan to remove it.
4. The decision is recorded using the decision record template in `MAIN_PLAN.md` §10.
5. The human owner approves it.

Never grant an exception because a feature "would be cool", "is quick to add", or "will be needed later". Those are the reasons the rules exist.

---

## 7. Quick reference card

> - Coordinator, not IDE, not agent, not TUI.
> - Programmatic interface, never scraping.
> - Subscribe before send; history is truth; idle is not success.
> - Structured outputs; retry once; escalate.
> - Context packets, not transcripts.
> - Tests and review together; consensus is not correctness.
> - Different models for author and judge.
> - Static permissions, never model-granted.
> - One writer per tree; worktrees later.
> - Every loop bounded; every message persisted and logged.
> - Prove the two-session loop first. Everything else waits.
