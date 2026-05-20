# wait-events ambient loop

> **Status:** converged Codex + Claude design after operator pushback.
>
> **Problem trigger:** a holder still needs live messages while holding the
> stick. A checkpoint-only wait loop lets agents fall out of receive exactly
> when coordination matters.

## Problem

The current recommended workflow has two concepts:

- `tt wait --json` grants ownership and starts or repairs the guardian.
- `tt events --follow --json` is the ambient receiver for messages, passes,
  releases, and assignments.

That split is correct semantically, but it is too fragile operationally. Some
harnesses cannot observe a long-running child process line-by-line and only see
process completion. Others can start an ambient receiver but then stop paying
attention after a release, timeout, or apparent task boundary. In practice, an
agent can miss a late message or stop receiving while it owns the turn.

The UX goal is one harness receive loop that remains active while waiting and
while holding.

## Decision

Add an event-aware wait mode:

```sh
tt wait --events --after <event_seq> --json
```

This is the recommended ambient loop for harnesses. It runs in the background,
returns on each wake, and is restarted with the returned `cursor_event_seq`.

The normal ownership rule remains unchanged: only a `your_turn` wait result
with a live guardian grants authority to mutate shared workspace state.
Events returned by the command are observability, not permission.

`tt events --follow` stays available for audit, debugging, and lower-level
event inspection, but the bundled skill should stop teaching it as the primary
harness loop once `wait --events` is dogfooded.

## Output Shape

`tt wait --events --after N --json` returns the existing wait result plus:

```json
{
  "events": [],
  "cursor_event_seq": 1234,
  "wake_reason": "turn"
}
```

`wake_reason` is one of:

- `turn`: ownership state changed or an ownership-relevant branch is available.
- `event`: self-targeted events arrived.
- `timeout`: no relevant turn or event change arrived before timeout.
- `closed`: the room closed. `status: "closed"` remains the canonical signal;
  this reason only explains why the long-poll woke.

If both a turn change and events are present, `wake_reason` is `turn`, and the
harness still drains `events`.

Events are returned on every result branch, including `your_turn`, `not_yet`,
`takeover_available`, and `closed`. Terminal branches must not silently drop
queued events.

Holder timeout result shape is explicit: when the caller already owns the turn
and no relevant events arrive before timeout, return `status: "your_turn"`,
`reason: "already_owner"`, `events: []`, and `wake_reason: "timeout"`. The
caller still owns the turn; the result is only a receive-loop checkpoint.

## Wake Semantics

When the caller is not the owner, wait-events wakes on:

- a normal `your_turn` grant,
- a reservation/pass to the caller,
- room state entering a `takeover_available` branch the caller could exercise,
- self-targeted event batches,
- room closure,
- timeout.

When the caller already owns the turn, wait-events still long-polls. It wakes
on:

- self-targeted messages or broadcasts,
- ownership loss or takeover,
- room closure,
- timeout.

If the holder loses the turn, return `status: "not_yet"` with
`reason: "lost_turn"` and any queued events. The former holder should not get an
automatic re-grant path from that result.

Holder-side wait-events must not release the turn, renew the lease, or change
guardian state. The foreground work remains covered by the existing guardian
process.

## Park Mode

`tt wait --park --events --after N --json` composes the same receive loop with
park semantics.

It wakes on self-targeted events, ownership-relevant state changes, closure, or
timeout, but it never claims an idle room. In an idle room with a pending
handoff, the result remains `status: "not_yet"` with
`reason: "auto_claim_disabled"` plus the event fields. `wake_reason` reflects
what woke the loop: usually `event`, `turn`, or `timeout`.

## Targeting

The default event target is `self`, matching the existing event filter:

- direct messages to the caller,
- broadcasts from other agents,
- non-message events to or from the caller.

`--target any` may exist for diagnostics, but the skill should not recommend it
for normal harness loops.

## Cursor Contract

`--after` is required when `--events` is present. Omitting it is an explicit
usage error. The harness owns the cursor and must pass the previous
`cursor_event_seq` into the next invocation.

`--after` without `--events` should also be an explicit usage error. Plain
`tt wait` should not gain cursor semantics accidentally.

Initial cursor choices:

- use the room sequence from `tt join` / current state if available,
- or use `--after 0` for a deliberate full replay.

No implicit historical replay in the default path.

## Heartbeat Contract

Guardian remains the only owner lease heartbeat.

Wait-events may refresh ordinary member presence as a read/check-in, but it
must not update `lease_expires_at`, create a guardian, stop a guardian, or
otherwise mutate owner lease state except when the wait-events path legitimately
grants ownership. In that case, it is the normal wait path and must spawn or
repair the guardian before returning `your_turn`.

This is important for background use: if a backgrounded wait-events call grants
`your_turn`, that same process must return a live `guardian_pid`. Requiring a
follow-up foreground `tt wait` would create a race where the harness starts work
before a guardian exists.

## Skill Shape

The harness guidance becomes:

1. Join once.
2. Start one background `tt wait --events --after <cursor> --json` loop.
3. On each return, process `events`, update the cursor, and restart the loop.
   Restart after `your_turn` too; ownership is not a reason to stop receiving.
4. Treat `your_turn` plus guardian as write authority.
5. Treat events on any non-owner result as messages/signals only.
6. Release or park according to the existing active-work rules.

This removes the separate "ambient receiver vs wait fallback" decision from
normal harness behavior.

## Implementation Order

1. Extend wait CLI parsing with `--events`, `--after`, and optional `--target`.
2. Add result fields for `events`, `cursor_event_seq`, and `wake_reason`.
3. Implement service polling that checks both wait state and self-targeted
   events without mutating owner lease state.
4. Preserve existing `tt wait` behavior when `--events` is absent.
5. Add tests for:
   - waiting agent receives `your_turn` with events and a live guardian,
   - holder receives a message while holding and gets `your_turn`,
     `already_owner`, events, and no lease mutation,
   - holder timeout returns `your_turn`, `already_owner`, empty events, and
     `wake_reason: "timeout"`,
   - holder is taken over and receives `not_yet`, `lost_turn`, and queued
     events,
   - event-only wake for a non-owner returns `not_yet` plus events,
   - turn+event wake returns `wake_reason: "turn"` and still includes events,
   - closed room still returns queued events,
   - park plus events in an idle room returns `not_yet`,
     `auto_claim_disabled`, and event fields,
   - two concurrent wait-events calls on idle: one wins `your_turn`, the other
     gets `not_yet` plus any queued events,
   - `--events` without `--after` fails,
   - `--after` without `--events` fails,
   - wait-events alone does not preserve ownership if the guardian dies.
6. Dogfood in a shared room with Codex and Claude before changing the bundled
   skill recommendation.

## Risks

- The name `wait` now covers both ownership and receive-loop behavior. The
  output must keep permission boundaries explicit.
- A holder can still idle-hold if the harness misuses the loop as foreground
  sleep. The skill must say the loop is background observability, not a reason
  to keep the stick while inactive.
- Wait-events alone must not preserve ownership. If the guardian dies or the
  harness idles without active work, the lease expires normally and peers can
  reach takeover availability.
- Cursor misuse can replay or miss events. Requiring `--after` makes this
  explicit instead of magical.
