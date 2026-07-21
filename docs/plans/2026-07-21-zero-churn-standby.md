# Zero-churn wait and standby workflow

**Status:** Converged design for Talking Stick 0.10.0.

**Participants:** `codex:a7fe8015` and `claude:f8ab69cc`.

## Problem

Talking Stick currently describes `tt wait --park` as passive standby, but the
implementation and harness workflow still churn:

- the CLI inherits the normal 110-second wait deadline and exits on silence;
- agents restart or poll the wait subprocess and narrate empty results;
- parked waits refresh `last_wait_at`, so they remain automatic handoff
  candidates and can create ownership churn;
- the 250ms observation loop writes member presence on every iteration;
- keeping one long-running subprocess does not let a harness such as Codex end
  its model turn when process output is not injected asynchronously.

The release must remove process, model-turn, narration, ownership, and SQLite
churn for supported workflows while stating portable harness limits honestly.

## Agent workflows

### Active coordination

`tt wait --json` means the caller wants work. It records active wait intent,
participates in fair release routing, may claim an idle room, and remains open
until an actionable signal or an explicit `--timeout`.

### Portable passive coordination

`tt wait --park --json` means the caller is passively observing. It records
parked intent, never becomes an automatic release recipient, and remains open
until an actionable signal or an explicit `--timeout`. The harness must still
surface subprocess completion.

### Event-driven standby

`tt standby --wake cmux --json` records parked intent and a verified cmux
surface, then returns immediately so the agent can end its model turn. A later
targeted/actionable mutation delivers one constant, body-free wake prompt to
that surface. `--wake manual` records the same intent but explicitly warns that
it cannot self-wake.

An owner with a live lease must release before either passive workflow.

## Contract

### 1. Signal-only wait lifecycle

Both active and parked CLI waits exit only for:

- `your_turn`;
- `takeover_available`;
- a matching directed message;
- a new pending-handoff park hint;
- room close or caller kick;
- an explicit `--timeout`.

The service RPC remains bounded internally so the CLI can refresh presence and
inspect cancellation without exiting the process. Silence produces no stdout.

### 2. Persisted wait intent and routing

Add `room_members.wait_intent` with `active`, `parked`, or `NULL`. Intent is
only eligible while member presence is fresh.

- active wait sets `active` and refreshes presence/`last_wait_at` at a bounded
  cadence; persisted active intent remains eligible while presence is fresh
  and the selected candidate is not known gone;
- park/standby sets `parked` and clears stale active wait interest;
- ordinary release routes only to recent active waiters;
- release reports `no_active_waiters` and `parked_hinted` when applicable;
- named pass/assign may route to parked members;
- `assign next` selects active waiters first, then parked active members and
  reports `routed_to_parked`;
- `auto_claim` remains a compatibility input and maps to the new wait mode.

### 3. Write-bounded observation

Polling room state and events is read-only. Presence and wait-interest writes
occur once on entry or intent change and then no more frequently than the
configured heartbeat cadence. A quiet wait must have update complexity
`O(duration / heartbeat interval)`, not `O(duration / poll interval)`.

### 4. Honest lifecycle guidance

The README, bundled instructions, installed skill, help, and receive-consumer
contract distinguish tool yield from process exit, signal-only blocking wait
from event-driven standby, and manual standby from self-waking transports.
They must not instruct agents to narrate or restart silent waits.

### 5. Sender-side cmux wake

Add a `WakeTransport` seam with only `cmux` and `manual` implementations in
0.10.0. Registration stores transport, verified workspace/surface target,
generation, pending state, and timestamp.

cmux calls are bounded to five seconds. The caller refs returned by `cmux
identify` are the canonical target for this release; a renamed or removed
surface can fail delivery, which remains pending and visible for retry.

Qualifying signals in 0.10.0 are targeted messages, named/next assignment,
direct pass, and a release handoff hint. Room-broadcast chatter is not
qualifying. Inferred takeover availability has no sender-side transition, and
close/kick have no safe durable post-commit member endpoint, so those three are
explicitly deferred rather than pretending delivery is reliable.

Wake delivery rules:

- use a compile-time constant prompt with no message/event body interpolation;
- atomically coalesce a burst into one pending wake per registration;
- after a successful delivery, keep the registration one-shot until the agent
  explicitly waits or stands by again;
- a failed delivery never rolls back the room mutation; it remains pending;
- subsequent room mutations and `tt health` retry pending deliveries;
- foreground coordination invalidates the old generation so stale work cannot
  wake a resumed agent;
- state and health expose registration and pending-delivery diagnostics.

No native `codex resume` or `claude --resume` launching and no resident watcher
daemon are included in this release.

## Test matrix

### Service and state transitions

- active versus parked in idle, owned, reserved, stale-owner, owner-gone,
  owner-idle, recipient-gone, and closed rooms;
- ordinary release with active only, parked only, and mixed candidates;
- named pass/assign and `assign next` active-first/parked-second routing;
- owner rejection based on a live lease, with expired ex-owner allowed;
- all takeover reasons remain advisory;
- the historical both-agents-park-after-release churn/deadlock sequence;
- park-hint throttling per member and pending handoff;
- directed messages wake; room-broadcast chatter does not wake standby;
- cursor advancement and replay remain at-least-once and deduplicable.

### Wait lifecycle and persistence

- a quiet CLI wait survives multiple internal RPC deadlines with zero stdout
  and one OS process;
- explicit timeout remains honored for active and parked modes;
- message and handoff signals exit promptly; takeover/close/kick wake adapters
  are deferred as described above;
- a SQLite update trigger proves writes stay within the heartbeat bound;
- `wait_intent` migration and legacy-null compatibility;
- crash/stale presence removes intent from routing eligibility.

### Standby and wake safety

- standby returns immediately and starts no terminal child/watcher;
- cmux registration requires verifiable same-caller surface identity;
- fake transport receives exactly one wake for a qualifying burst;
- hostile message bodies cannot alter the constant wake prompt;
- irrelevant broadcasts produce no wake;
- failed delivery remains pending and is retried by a later mutation/health;
- active resumption invalidates the prior generation;
- manual mode prints a no-self-wake warning;
- state and health report target, generation, pending state, and failure.

### CLI, docs, and release proof

- parser placement, JSON/text output, help, cursor persistence, guardian
  creation only after authority, and duplicate-listener diagnostics;
- instruction and installed-skill assertions for all three workflows;
- full typecheck, Vitest suite, build, diff check, and package contents;
- live Codex and Claude cmux dogfood proving standby ends the model turn and a
  targeted signal causes exactly one wake;
- published npm/GitHub state and a disposable global install smoke.

## Release gate

The version is 0.10.0 because wait lifecycle, passive routing, and owner-side
park behavior change. Publication requires explicit Codex and Claude review and
test sign-off. npm authentication is checked before versioning; registry,
GitHub release, tarball contents, installed CLI behavior, and installed skill
text are verified after publication before the room is closed.
