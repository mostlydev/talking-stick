# Full headless roadmap

Status: proposal for review. Plan owner Claude; independent reviewer Codex; bounded reviewer Grok.
This extends the canonical design in [`docs/supervisor.md`](../supervisor.md) and does not replace
it. Anything already built there (adapters, fences, recovery of owned workers, the locked
`HumanGate`, protected state, eligibility, the attended kit) is reused as-is.

The goal is a room, or several rooms, that run on managed headless workers end to end: started
from a default setup, assigned work, reviewed, recovered after crashes and restarts, and closed,
with a human only where a human decision is actually needed.

## Answers first

| Question | Recommendation |
| --- | --- |
| A separate room manager on a lower model? | No by default. The deterministic supervisor does lifecycle, reconciliation and delivery; one main manager owns intent and priorities. A low-model coordinator is an optional, measured add-on (M9), never an authority. |
| Do rooms need managers? | No. Each room has a task lead and an independent reviewer. The lead coordinates its room; cross-room decisions go to the main manager. |
| Default room setups? | Versioned room templates, resolved bundled → user → project like roles, pinned by version in the room. |
| Default instructions? | The existing layering (bundled → user → project), plus a template layer and a managed-worker layer, with an effective preview and a content hash recorded per generation. |
| Role assignments? | Roles stay responsibility only. Authority is enforced separately: the stick, the control boundary and a narrow operator policy. A template fills logical slots; a slot is not a vendor. |
| Lifecycle? | Room, task and worker lifecycles are independent state machines that reference each other by durable ids. |
| Context? | A durable task packet (task, decisions, evidence, open asks, a context summary). A fresh-context restart is built from it, not from a transcript. |

## Architecture

```
operator ── chat / tt supervisor (human control, gate-locked today)
   │
main manager (optional, one at a time, a managed worker in a control room)
   │  intent, cross-room priorities, escalation; acts only through tt and policy
   │
supervisor daemon (deterministic, no model)
   │  owns processes, reconciliation, fenced delivery, budgets, stall detection
   │
rooms ── task lead + independent reviewer (+ optional specialist)
            managed workers: Claude, Codex, Grok adapters
```

- **Supervisor.** No model, no judgment. It starts, stops and recovers workers, delivers room
  events through the existing fence, enforces queue bounds, budgets and deadlines, and raises
  escalations. It also recovers the main manager like any other worker.
- **Main manager.** Holds the operator's intent and cross-room priorities. It creates tasks,
  assigns them to slots, answers leads and escalates to the operator. It can't approve tool
  requests, can't enable the gate, can't change policy, and can't overrule a reviewer's veto.
  Without a manager, the operator plays this part through chat, so the manager is never a hard
  dependency.
- **Task lead.** Owns one task's execution in one room: it plans, holds the stick for writes and
  asks the reviewer. It's the same role agents play today.
- **Reviewer.** Independent. Its veto blocks a merge exactly as today: all members' exact-head
  AGREEs plus every CI job passing.
- **Optional coordinator** (M9 only). An event-driven low-model worker that may summarize, route a
  question to the right member, and nudge a stalled one, under a written narrow policy. It escalates
  any ambiguity. It must not grant authority, infer human approval, overrule review, or hold the
  only copy of a task. It reads and writes the task store through the same API as everyone else.

## Identities

Every record names the identity it means. Four identities exist and must not be conflated:

| Identity | Example | Lifetime | Used for |
| --- | --- | --- | --- |
| Logical role (slot) | `api/reviewer` | as long as the room's template keeps the slot | assignments, review requirements, escalation routing |
| Worker | `worker_id` in the supervisor | until `remove` | process ownership, budgets, config |
| Generation | `worker_id#7` | one process | delivery tokens, fences, approvals, uncertainty |
| Native session | Codex thread id, Claude session id, Grok session id | as long as the harness keeps it | resume; never proof of who acted |

An assignment binds a task to a slot, and a slot to a worker. Replacing a worker (a crash, a fresh
context, a different model) changes the slot's binding and keeps the assignment. Approvals,
inputs and fences stay bound to their generation, as they are now.

## Room templates

A template is a versioned, declarative room setup. It is configuration, validated before use.

```toml
# bundled: standard@1
template = "standard"
version = 1

[[slot]]
name = "lead"
roles = ["implementer"]
harness = { any = ["claude", "codex"] }
effort = "high"

[[slot]]
name = "reviewer"
roles = ["reviewer"]
harness = { differ_from = "lead" }   # independent by default
effort = "high"

[review]
policy = "always"                     # "always" | "risk"
merge = "all_agree_and_ci"

[budget]
task_wall_clock = "8h"
stall_after = "45m"
```

Three bundled templates:

- `standard`: lead and reviewer, review always required.
- `solo`: a lead only, with risk-based review. A change is low risk only when deterministic rules
  say so: no protected path touched, a diff under a size bound, no dependency, CI, release or
  credential file touched, and no new executable. Anything else, or anything the rules can't
  classify, brings in a reviewer (a slot started on demand) before merge.
- `specialist`: `standard` plus one optional slot started per task (for example docs or security),
  whose AGREE is required only for tasks that name it.

Rules:

- Harness, model and effort are per-slot constraints, checked against each adapter's declared
  capabilities (supported harness, accepted model names or "any", effort levels it can pass).
  There are no fixed role-to-vendor mappings. A slot whose constraints no configured worker
  meets makes the room invalid with an exact reason, never a silent substitution.
- Templates resolve bundled → user → project by name, as role definitions do. `room.toml` gains a
  `template = "standard@1"` key, pinning the version. A newer version is never adopted
  implicitly; changing it is an explicit, previewed operator action.
- Grok's unproven capabilities (credential path, resume) show up as capability flags, so a
  template that requires them is invalid now, while one that only allows them still validates.

## Instructions

The layers, lowest first: bundled skill floor, bundled defaults, user, project, template,
managed-worker. The managed-worker layer is generated by the supervisor and says only what
differs for a headless worker: how input arrives, that it never waits on a TTY, and its slot.

- `tt instructions show --worker <id>` (and `--template <name>@<v> --slot <slot>` before a worker
  exists) prints the effective text, with each line attributed to its layer.
- Each generation records the sha256 of its effective instructions in the supervisor DB. A change
  applies at the next turn as it does for roles today, and the hash shows which text a given turn
  saw.
- Instructions describe responsibility. Nothing in them grants authority; the stick, policy and
  control boundary enforce that.

## Durable task store

Tasks live in the room database, not the supervisor's, because they are coordination state that
unsupervised members and the operator must also see. The supervisor reads them; it doesn't own
them.

| Record | Fields (outline) |
| --- | --- |
| task | id, room, title, intent (operator text, verbatim), state, slot assignments, template version, budget, deadline, parent task |
| decision | task, decided by (identity and kind), text, supersedes |
| evidence | task, kind (test run, CI run, PR head, probe output), reference, sha256, recorded by |
| ask | id, task, from slot, to (slot, manager or operator), text, idempotency key, state (open, answered, withdrawn, expired) |
| context packet | task, version, summary, open questions, pointers to decisions and evidence |

- An ask carries an idempotency key built from (task, from slot, normalized question). A manager
  handoff, a crash, or two leads asking the same thing produce one open ask, not two.
- The context packet is written by the task lead at handoff and at each milestone. A fresh-context
  worker starts from it plus the room's notes, never from a transcript replay.
- Existing room notes stay the room's free-form memory. Tasks don't replace them.

## Lifecycles

Each machine moves only on recorded events, and each transition is audited.

- **Room:** `draft` (template chosen, invalid until slots validate) → `active` → `paused` →
  `closing` (no new tasks; running tasks finish or are cancelled) → `closed`.
- **Task:** `proposed` → `assigned` → `in_progress` ⇄ `blocked` → `in_review` → `done`, or
  `cancelled` from any state. `blocked` names an open ask or an escalation.
- **Worker:** the existing desired/actual states, plus a slot binding. New transitions:
  - **sleep**: a worker with nothing assigned is stopped after an idle bound; its slot stays bound.
  - **wake**: assigned work or a directed message restarts it and resumes its native session when
    the adapter can prove resume. Otherwise it starts fresh from the context packet.
  - **fresh context**: an explicit restart with a new native session, built from the packet.
  - **crash uncertainty**: an input that may have reached a dead generation stays `uncertain` and
    is never resent automatically, as now. The task gets an ask to the lead (or the operator) to
    decide.
  - **cancellation**: interrupts the turn (when control is unlocked), stops the worker, and marks
    the task `cancelled` with a reason. Locked control means a cancel waits for the turn to end.
  - **closeout**: the lead writes the final packet, every ask is closed or handed to the manager,
    and the slot's worker sleeps or is removed according to the template.

## Bounds, budgets and escalation

- **Queues:** each worker's delivery queue is bounded (count and bytes). Overflow coalesces into a
  body-free notice and raises an escalation; nothing is dropped silently.
- **Budgets:** wall clock per task, turns per task, and spend where the harness reports usage. No
  adapter reports usage today, so spend is an adapter capability to add per harness, and an absent
  report means the budget is unknown, not unlimited.
- **Deadlines:** set per task; missing one raises an escalation, never an automatic cancel.
- **Stall:** no turn activity, no stick change and no ask for `stall_after` raises a nudge to the
  lead, then an escalation to the manager, then the operator.
- **Human override:** the operator can pause a room, cancel a task, reassign a slot or answer any
  ask, and overrides win over manager actions. They go through the human-control path; until the
  gate is enabled, the ones that change workers are the locked commands and wait for it.

## Manager handoff and recovery

- **One manager at a time:** a manager lease in the room database with a fencing epoch. Every
  manager write carries its epoch; a write from a stale epoch is refused. Promotion first revokes
  the old epoch, then grants the new one, so two managers can never both write.
- **Recovery:** the supervisor restarts the manager like any worker. The new generation reads open
  asks, task states and its own last context packet. Idempotency keys mean re-asking is a no-op.
  An action the old generation may have taken without recording it stays `uncertain` and is
  surfaced, not repeated.
- **Demotion:** a demoted manager keeps its worker but loses the epoch. Its assignments stay in the
  store and pass to the next manager.

## Operator policy

A small policy file under the supervisor's protected state root (so a worker can't edit it,
per eligibility) says what the manager may do without a human:

- create, assign and cancel tasks inside rooms it was given;
- wake, sleep and fresh-start workers bound to those rooms' slots, within each template;
- answer asks from leads, and escalate.

It can never approve or deny a tool request, interrupt a turn, resend an uncertain input, enable
the gate, edit policy, templates, instructions or `room.toml`, or merge. Manager actions go
through the daemon with the manager's generation identity, are audited, and are refused outside
policy. Because any same-user process can forge a request, every manager-allowed action must be
safe if forged by a worker: bounded, idempotent, inside the template, and harmless to repeat. An
action that isn't goes behind the human gate.

## Milestones

Two tracks. Track A closes existing proof gaps and is mostly operator-attended. Track B builds the
orchestration. Track B doesn't wait for Track A, except where a milestone says so.

### Track A: existing proof gaps

| Id | Milestone | Acceptance | Who |
| --- | --- | --- | --- |
| A1 | Migrate live state | `tt supervisor migrate` exits 0; `tt supervisor status` runs; the old `supervisor.sqlite` is retired by the journal | operator (pending) |
| A2 | Foreground gate kit | `node scripts/attended-gate-acceptance.mjs` result `ok: true`, every step's expected outcome | operator (pending) |
| A3 | launchd gate kit | `--launchd` result: in `gui/<uid>` confirm gives `confirmed` and cancel gives `refused`; in `user/<uid>` an observed `unavailable`; Ctrl-C with the dialog up leaves the agent unloaded and the helper gone; cleanup complete | operator (pending) |
| A4 | Actual-supervisor helper launch | the real `tt supervisor install` agent, in a disposable data dir, raises the gate helper on one fake approval and records the outcome; then `uninstall` leaves nothing loaded | operator, attended |
| A5 | Native turn-tool confinement | a model turn under `workspace-write` attempts writes to state, program and LaunchAgents stand-ins and is denied; one authorized paid call per harness | operator authorizes spend |
| A6 | Enable the gate | a reviewed change selects `localAuthenticationGate` in `run` and unlocks approve, deny and interrupt only; needs A2 to A5 | Claude, reviewed by Codex and Grok |
| G1 | Grok credential | `session/new` succeeds with an `XAI_API_KEY` Keychain reference in a disposable worker | operator, attended |
| G2 | Grok resume | a recorded Grok session resumes and its session id matches | after G1 |

The bounded `command/exec` evidence (#221) and the wrapper LaunchAgent (#222) prove neither A4 nor
A5. The unsupervised-TUI reconnect stays an upstream gap (see "What the supervisor does not prove")
and blocks no milestone here. Neither does G1 or G2; a template that needs Grok is the only thing
that waits for them.

### Track B: templates, context and orchestration

Each milestone is one or more reviewed PRs, with Vitest coverage and no model calls in CI.

| Id | Milestone | Acceptance tests |
| --- | --- | --- |
| M1 | Template schema, validation, preview | `tests/room-templates.test.ts`: bundled → user → project resolution by name and version; unknown keys rejected; a slot nobody can fill fails with its reason; `differ_from` enforced; Grok-requiring template invalid, Grok-allowing valid; `room.toml` `template` key parsed and pinned; preview output stable |
| M2 | Instruction layers for workers | `tests/instructions.test.ts`: template and worker layers in order, line attribution; per-generation hash recorded and changed by an edit at the next turn only; a role change still never moves the stick |
| M3 | Task store | `tests/tasks.test.ts`: task, decision, evidence, ask and packet round-trip in the room DB; ask idempotency (same key, one open ask); filters in SQL before `LIMIT`; non-members can read, only members write |
| M4 | Lifecycles | `tests/lifecycle.test.ts`: every allowed transition and every refused one for room, task and worker; sleep and wake with a FakeAdapter; resume when provable, packet-based fresh start when not; crash with an in-flight input leaves it `uncertain` and opens one ask |
| M5 | Bounds and escalation | `tests/supervisor-bounds.test.ts`: queue overflow coalesces and escalates; stall ladder lead → manager → operator with fake clocks; a missing usage report is "unknown"; a deadline escalates and never cancels |
| P1 | Single-room pilot | one `standard` room, a managed lead and reviewer (Codex and Claude), one small authorized task taken from proposal to merged PR with no human beyond the merge confirmation; record turns, wall clock, asks and interventions |
| M6 | Manager lease and policy | `tests/manager.test.ts`: epoch fencing (a stale write refused); promotion revokes before granting; policy refuses each forbidden action; a forged manager request inside policy is harmless and audited |
| M7 | Manager recovery | crash tests with FakeAdapter: kill the manager mid-ask, kill the daemon mid-delivery; restart produces no duplicate ask, no repeated task creation, and every uncertain action surfaced once |
| P2 | Pilot recovery | P1's room plus a manager: kill the manager, kill the daemon, then restart the Mac (attended, after A3 and A4); every task resumes or is surfaced, no duplicate ask or commit |
| M8 | Multi-room | two rooms under one manager; priorities ordered; one room paused while the other runs; cross-room asks routed through the manager only |
| P3 | Multi-room pilot | two small authorized tasks in two rooms, run concurrently to merge |
| M9 | Optional coordinator, measured | see "Comparison" |

Order: M1 → M2 → M3 → M4 → M5 → P1 → M6 → M7 → P2 → M8 → P3 → M9. P1 doesn't need the gate, but
works within it being locked. Codex workers keep `on-request` or `untrusted` (the supervisor
refuses `never`) inside `workspace-write`. Claude workers keep `default` with a narrow project
allowlist. Anything that asks for approval waits and expires as a deny. So P1's task is chosen to
fit inside the sandbox and the allowlist, and an expired approval counts as a finding, not a
failure. Every pilot task needs the operator's authorization for its model spend.

## Comparison: manager only, or with a coordinator

Run after P3, with three small authorized tasks of different shapes (a bug fix, a docs change, a
two-room change). Each runs twice: main manager only, then with the coordinator, same template,
models and budget. Not a bulk benchmark.

Record per run:

- operator interventions and their kind;
- duplicate asks, and dropped or stale asks;
- time stalled before someone noticed;
- turns and, where reported, spend, split by worker;
- review findings that reached merge and were later fixed;
- authority violations attempted by the coordinator (the bar is zero).

Keep the coordinator only if it cuts interventions or stall time without a single authority
violation or a rise in escaped findings. Otherwise leave it out of the bundled templates.

## Unresolved decisions

1. **Template location.** Recommended: `room.toml` gains only `template = "<name>@<version>"`, and
   definitions live in the instruction files' tiers like roles. The alternative is
   `.talking-stick/templates/*.toml`, which is easier to diff but adds a file kind.
2. **Task store home.** Recommended: the room DB (shared, visible to unsupervised members).
   The alternative, the supervisor DB, keeps tasks private to managed rooms.
3. **Where the manager lives.** Recommended: a dedicated control room with only the manager and
   the operator's console, so project rooms keep their lead and reviewer. The alternative is a
   manager seat in each project room.
4. **Manager control before the gate.** Recommended: allow only the forge-safe actions in
   "Operator policy" before A6, and nothing else. The alternative is to wait for A6 entirely.
5. **Solo risk rules.** The deterministic rule set, and whether the lead's own risk claim can
   lower it (recommended: it can only raise it).
6. **Spend reporting.** Which harness usage reports to trust for budgets, per adapter.
7. **Sleep policy.** The idle bound before a worker sleeps, and whether a reviewer sleeps between
   reviews (cheaper) or stays loaded (faster).
