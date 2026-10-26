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
| Default room setups? | Versioned room templates in their own TOML files, resolved bundled → user → project like roles, pinned by name and version in the room. |
| Default instructions? | The existing layering (bundled → user → project), plus a template layer and a managed-worker layer, with an effective preview and a content hash recorded for every turn. |
| Role assignments? | Roles stay responsibility only. Authority is enforced separately: the stick, the control boundary, and grants and bounds in the supervisor's protected state. A template fills logical slots; a slot is not a vendor. |
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

An assignment binds a task to a slot, and a slot to a worker. A crash or a resume keeps the
`worker_id` and starts a new generation. Replacing the worker (a different model or harness)
changes the slot's binding and keeps the assignment. Approvals, inputs and fences stay bound to
their generation, as they are now.

The binding of a slot to a worker and generation is authoritative only in the supervisor's
protected state. The room database may mirror it for display; a mirror that disagrees is stale,
and the daemon acts on its own copy.

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

Bundled templates:

- `standard`, the default: lead and reviewer, review always required.
- `specialist`: `standard` plus one optional slot started per task (for example docs or security),
  whose AGREE is required only for tasks that name it.
- `solo`, deferred: a lead only, with risk-based review. It ships only once two things exist: a
  deterministic classification (no protected path, a diff under a size bound, no dependency, CI,
  release or credential file, no new executable), and a required-review snapshot in protected
  state, taken when the task starts, that a later room write can't lower. A model's own risk
  claim can only raise the level. Anything the rules can't classify needs a reviewer.

Rules:

- Harness, model and effort are per-slot constraints, checked against each adapter's declared
  capabilities (`prompt`, `resume`, `interrupt`, `approvals`, accepted model names or "any",
  effort levels it can pass). There are no fixed role-to-vendor mappings. A slot whose
  constraints no configured worker meets makes the room invalid with an exact reason, never a
  silent substitution.
- A task-capable slot needs a candidate with `prompt`. Grok's adapter reports `prompt: false`
  today (and `resume: false`, with no proven credential path), so a fresh Grok worker can't fill
  a lead or reviewer slot even when the template allows Grok. Listing an unavailable candidate is
  harmless only when fully capable candidates fill every required slot.
- Definitions are dedicated, versioned TOML files in bundled, user and project template
  directories (`.talking-stick/templates/<name>.toml` for a project), resolved by name like role
  definitions. They're not embedded in instruction prose. `room.toml` gains
  `template = "standard@1"`, pinning name and version. A newer version is never adopted
  implicitly; changing it is an explicit, previewed operator action.

## Instructions

The layers, lowest first: bundled skill floor, bundled defaults, user, project, template,
managed-worker. The managed-worker layer is generated by the supervisor and says only what
differs for a headless worker: how input arrives, that it never waits on a TTY, and its slot.

- `tt instructions show --worker <id>` (and `--template <name>@<v> --slot <slot>` before a worker
  exists) prints the effective text, with each line attributed to its layer.
- Each turn records the sha256 of the effective instructions it was started with, next to its
  input in the supervisor DB. A change applies at the next turn as it does for roles today, so a
  single generation can span several revisions, and the per-turn hash, not a per-generation one,
  shows which text a turn saw.
- Instructions describe responsibility. Nothing in them grants authority; the stick, policy and
  control boundary enforce that.

## Durable task store

Tasks live in the room database, because they are coordination state that unsupervised members
and the operator must also see. That database is worker-writable by design: any member, or any
same-user process, can write a row. So nothing in it is authority. A task's recorded intent,
an AGREE, a piece of evidence or a "human override" row is a claim to check, not a grant.

Authority lives in the supervisor's protected state, written only by the daemon and applied
atomically there:

- the manager epoch and every slot's worker and generation binding;
- operator grants: which rooms a manager may act in, and its scope;
- budgets, cumulative start and spend quotas, cooldowns and target bounds;
- the human-override sequence (pause, cancel, reassign), which a room write can never undo;
- the required-review snapshot taken at task start.

A forged or tampered room row must never promote a manager, widen scope, reset a budget, clear a
veto or lift a human pause. The daemon acts only on its protected copy, and a room row that
disagrees with it is reported as a conflict.

| Record | Fields (outline) |
| --- | --- |
| task | id, room, title, intent (operator text, verbatim), state, slot assignments, template version, budget, deadline, parent task |
| decision | task, decided by (identity and kind), text, supersedes |
| evidence | task, kind (test run, CI run, PR head, probe output), reference, sha256, recorded by |
| ask | request id (immutable), payload digest, occurrence, task, from slot, to (slot, manager or operator), text, state (open, answered, withdrawn, expired) |
| context packet | task, version, summary, open questions, pointers to decisions and evidence |

- Each ask carries an immutable request id, chosen by its sender, and a digest of its payload.
  A retry with the same id and digest is a no-op, so a crash or a manager handoff doesn't
  duplicate it. The same id with a different payload is a conflict, and is refused.
- Dedup is scoped to one sender slot in one task. Two slots asking the same thing are two asks; a
  manager or coordinator may link them, but never merges them.
- Once an ask is answered, or the subject has changed (a new PR head, say), asking again is a new
  occurrence with a new request id. Question text is never the identity.
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
  - **sleep**: stopping a worker only at the safe frontier: the daemon observes it quiescent,
    with no in-flight or uncertain input, no pending approval, no active task turn and no
    writer lease, and rechecks all of that atomically right before the stop. Its slot stays
    bound. Initially workers stay loaded until an explicit idle policy exists.
  - **wake**: assigned work or a directed message restarts it and resumes its native session when
    the adapter proves resume.
  - **resume failure**: `resume_failed`, an auth or protocol failure, or an unknown result holds
    the worker, as now, and escalates. It never silently falls back to a fresh context.
  - **fresh context**: a new native session built from the context packet, only when explicitly
    asked for, or when a preauthorized policy allows it and the worker is at the safe frontier
    with every input completed. Otherwise it escalates.
  - **crash uncertainty**: an input that may have reached a dead generation stays `uncertain` and
    is never resent automatically, as now. The task gets an ask to the lead (or the operator) to
    decide.
  - **cancellation**: on a quiescent worker, the task is marked `cancelled` with a reason. While
    a turn runs, a cancel is only a recorded request; actually interrupting or stopping the
    worker stays behind human control, and the task reads `cancel_requested` until it is done.
  - **closeout**: the lead writes the final packet, every ask is closed or handed to the manager,
    and the slot's worker sleeps or is removed according to the template.

## Bounds, budgets and escalation

- **Queues:** each worker's delivery queue is bounded (count and bytes). Overflow coalesces into a
  body-free notice and raises an escalation; nothing is dropped silently.
- **Budgets:** hard bounds the supervisor owns and enforces: worker starts, turns and wall clock,
  each per task and cumulative per worker, with cooldowns between starts. They live in protected
  state, so a new or forged task id can't reset them. Native usage telemetry is advisory until
  its completeness, units and pricing are proven per adapter; no adapter reports usage today.
  Unknown spend is shown as unknown, never treated as unlimited.
- **Deadlines:** set per task; missing one raises an escalation, never an automatic cancel.
- **Stall:** no turn activity, no stick change and no ask for `stall_after` raises a nudge to the
  lead, then an escalation to the manager, then the operator.
- **Human override:** the operator can pause a room, cancel a task, reassign a slot or answer any
  ask, and overrides win over manager actions. They go through the human-control path; until the
  gate is enabled, the ones that change workers are the locked commands and wait for it.

## Manager handoff and recovery

- **One manager at a time:** one optional manager, in a dedicated control room, with an explicit
  list of the rooms it may act in. Its lease and fencing epoch live in the supervisor's protected
  state, never the room database. The daemon checks the epoch on every manager action it applies;
  an action from a stale epoch is refused. Promotion revokes the old epoch before granting the
  new one, in one protected transaction, so two managers can never both act.
- **Recovery:** the supervisor restarts the manager like any worker. The new generation reads open
  asks, task states and its own last context packet. Request ids make a retried ask a no-op.
  An action the old generation may have taken without recording it stays `uncertain` and is
  surfaced, not repeated. A recovered manager never reacquires a writer lease implicitly.
- **Demotion:** a demoted manager keeps its worker but loses the epoch. Its assignments stay in the
  store and pass to the next manager.

## Operator policy

A small policy file under the supervisor's protected state root (so a worker can't edit it,
per eligibility) says what the manager may do without a human.

Any same-user process can forge a request, and a generation label doesn't authenticate a caller.
So bounded and idempotent isn't enough: an unattended action must be harmless when a worker forges
it. A forged stop could kill a busy writer, a forged fresh start could discard context, and a
forged wake and stop cycle could spend repeatedly. Before A6, the manager may therefore only:

- create and assign tasks in rooms it was granted, and record cancel requests;
- answer asks from leads, and escalate;
- wake a worker, and sleep one at the safe frontier (see "Lifecycles"), within the protected
  cumulative start quotas and cooldowns.

Everything else waits for human control: stopping or interrupting a busy worker, a fresh context
outside preauthorized policy, approving or denying a tool request, resending an uncertain input,
enabling the gate, editing policy, templates, instructions or `room.toml`, and merging. No action
implicitly reacquires a writer lease or retries an uncertain side effect. Every manager action
goes through the daemon, is audited, and is refused outside policy.

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
| M1 | Template schema, validation, preview | `tests/room-templates.test.ts`: bundled → user → project resolution of template files by name and version; unknown keys rejected; a slot nobody can fill fails with its reason; `differ_from` enforced; a candidate without `prompt` (Grok today) can't fill a task slot; an unavailable optional candidate is ignored only when capable ones fill every required slot; `room.toml` `template` key parsed and pinned; preview output stable |
| M2 | Instruction layers for workers | `tests/instructions.test.ts`: template and worker layers in order, line attribution; each turn records the hash it started with; an edit between two turns of one generation shows two hashes; a role change still never moves the stick |
| M3 | Task store and protected authority | `tests/tasks.test.ts`: task, decision, evidence, ask and packet round-trip in the room DB; same request id and digest is a no-op, same id with a changed payload conflicts, a new occurrence after an answer or head change is a new ask, two sender slots stay two asks; filters in SQL before `LIMIT`; non-members can read, only members write. `tests/supervisor-authority.test.ts`: direct room-DB tampering (a forged epoch, binding, override, budget or AGREE row) changes no daemon decision and is reported as a conflict; a stale binding is detected |
| M4 | Lifecycles | `tests/lifecycle.test.ts`: every allowed transition and every refused one for room, task and worker, with a FakeAdapter; sleep refused with an in-flight or uncertain input, a pending approval, an active turn or a writer lease, and rechecked atomically before the stop; resume failure with an uncertain input stays held and escalates; fresh context only by explicit request or preauthorized policy at the safe frontier; an unproven-prompt adapter never takes a task; cancel during a turn is only recorded |
| M5 | Bounds and escalation | `tests/supervisor-bounds.test.ts`: queue overflow coalesces and escalates; stall ladder lead → manager → operator with fake clocks; cumulative start and turn quotas and cooldowns survive a new task id; a missing usage report is "unknown"; a deadline escalates and never cancels |
| P1 | Single-room pilot | one `standard` room, a managed lead and reviewer (Codex and Claude), one small authorized task taken from proposal to merged PR with no human beyond the merge confirmation; record turns, wall clock, asks and interventions. Its report states which of A4, A5 and G1 were still unproven when it ran |
| M6 | Manager lease and policy | `tests/manager.test.ts`: epoch in protected state, a stale epoch refused; promotion revokes before granting in one transaction; policy refuses each forbidden action; a forged socket request and a forged room row each fail to promote, widen scope, reset quotas, stop a busy worker or lift a pause; allowed forged requests are harmless and audited |
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
failure. Every pilot task needs the operator's authorization for its model spend. A pilot that
passes shows orchestration, not security: until A4 and A5 pass, it doesn't show that the real
supervisor's agent can raise the dialog or that a model's own tool calls are confined, and until
G1 nothing about Grok's credential.

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

## Decisions

Proposed by Claude and recommended by Codex in review. Each stands unless the operator changes it.

1. **Template location:** dedicated, versioned TOML files in bundled, user and project template
   directories, resolved like role definitions; `room.toml` pins name and version.
2. **Task store home:** the room DB for coordination; the supervisor's protected state for
   authoritative grants, bindings, bounds and fences.
3. **Where the manager lives:** one optional manager in a dedicated control room, with an
   explicit list of the rooms it may act in.
4. **Manager control before the gate:** only the forge-safe actions in "Operator policy", at the
   safe frontier and within protected cumulative bounds. Other lifecycle effects stay locked
   until A6.
5. **Solo:** `standard`'s always-review is the default. Risk-based `solo` waits for the
   deterministic classification and the protected review snapshot. A model may only raise risk.
6. **Spend:** native usage telemetry is advisory until proven per adapter. Starts, turns and wall
   clock are hard bounds the supervisor owns. Unknown spend is shown, never unlimited.
7. **Sleep:** sessions stay loaded until an explicit idle policy exists. Sleep happens only at the
   safe frontier. A reviewer may sleep between completed reviews. Unsupported resume holds, or
   uses an explicitly authorized fresh context.

Still open for the operator: the idle bound itself, the solo size bound, and which of the three
comparison tasks to authorize.
