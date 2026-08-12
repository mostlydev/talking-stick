# Harness ergonomics, reachability, and low-churn coordination

**Status:** Unanimously approved by Codex, Claude, and Grok for operator review.
No product implementation has started.

**Evidence window:** Retained Talking Stick data from 2026-07-29 through
2026-08-12, plus current Codex 0.147.0, Claude Code, Grok, cmux, installed-skill,
hook, and CLI behavior. Deleted rooms are not retained, so the counts below are
a lower bound rather than a complete usage ledger.

## What the evidence says

- The retained database contains 1,771 events across eight rooms: 899 messages,
  371 claims, 239 releases, 186 passes, and 72 takeovers.
- Thirty-nine of the 72 takeovers are reservation or claim-timeout recovery.
  Nine more cite owner liveness, two cite `recipient_gone`, and repeated reasons
  describe sleeping surfaces, stale identities, and wait output that never
  reached the model.
- Direct messages average about 975 JSON characters and room messages about
  1,954. Handoffs average about 1,233 characters on release and 1,410 on pass.
  Static output fields and duplicated context amplify that payload.
- `--interrupt` is recorded as message metadata but does not change delivery.
  Current sender-side wake behavior is the fixed, body-free `cmux send` used by
  `tt standby --wake cmux`.
- A first live Grok room round trip succeeded during this investigation, using
  session-backed identity. The Grok hook had nevertheless spawned `tt
  grok-session-hook` on every `PreToolUse`; the recent hook log contains 119
  `PreToolUse` records that added no room-delivery capability.
- Duplicate-listener dogfood reproduced locally. Three `tt wait --json`
  processes were accidentally started because process diagnostics searched for
  `dist/cli.js wait`, while the live processes appeared as `bin/tt wait`.
  `tt health` reported no active listener. Two known handles were stopped, and
  the remaining wait claimed normally. Process-command scanning is not a sound
  receiver registry.
- The August 9 Flux activity is not evidence of idle pass churn. Seventy claims
  directly followed by a pass or release averaged 179 seconds, none lasted less
  than 30 seconds, and every one of the 59 passes and 45 releases carried a
  non-empty status and next action. That traffic was substantive implementation
  and adversarial review, so the design must not suppress it heuristically.

## Invariants

1. Only `your_turn` plus a live guardian grants workspace write authority.
2. An expired unclaimed reservation may be requeued; a live owner is never
   transferred automatically.
3. Routing is based on proven reachability, not stale intent or recent presence.
4. Wake prompts are compile-time constants. Message and handoff bodies never
   become terminal commands or wake-prompt text.
5. No arbitrary `exec:<command>` transport, second receive path, resident MCP
   data plane, or required background daemon is introduced.
6. Compact output may remove duplicated protocol boilerplate, but it must not
   silently truncate message, handoff, veto, or safety content.
7. Existing normal collaboration remains fast. A fix for idle churn must not
   delay real review turns or weaken independent vetoes.

## Phase 1: make reachability a protocol fact

Add a durable receiver registration keyed by room and harness session. A
foreground `tt wait` registers its exact receiver PID, process start time,
generation, and cursor before blocking, refreshes it only at heartbeat cadence,
and clears it conditionally on exit. Crash recovery validates PID plus process
start time. A second live receiver for the same room/session fails immediately
with a precise `duplicate_listener` result; it never replaces or kills the
first receiver.

Separate a verified wake endpoint from passive wait intent. When `cmux identify`
is available, join/wait may record the caller's fixed workspace and surface
with the harness-session generation. Absence of cmux remains valid and explicit.
The endpoint is invalidated when the harness session changes.

Ordinary fair release may select only a member with either:

- one live registered receiver; or
- one verified, self-waking endpoint.

Persisted `wait_intent=active` without either proof is diagnostic state, not a
routing candidate. Named pass/assign reports `recipient_unreachable` instead of
silently reserving for an agent that cannot be woken, unless an explicit
operator override is used. This preserves the handoff and the current owner's
authority.

`tt health` reads the receiver registry instead of guessing from command lines.
It reports the exact active generation and stale-registration reason, and its
duplicate count agrees with the enforcement path.

## Phase 2: recover unclaimed reservations without a signal storm

When an unowned reservation reaches `claim_expires_at`, the first waiter
atomically records `reservation_expired`, clears the stale recipient, preserves
the pending handoff, and reruns normal fair routing against reachable members.
If nobody is reachable, the room becomes idle with the handoff still pending.

The recovery does not return `takeover_available` and does not create write
authority by itself. Owner-gone, owner-idle, and owner-timeout cases retain the
existing explicit takeover decision because they can preempt work.

This removes the repeated `claim_timeout` wake loop while keeping the
owner-versus-reservation safety distinction visible in the protocol and audit
log.

## Phase 3: make `--interrupt` meaningful without adding a command

Keep `tt msg send ... --interrupt` as the only urgency surface.

- A live receiver gets the event through its existing `tt wait` stdout path.
- If no receiver is alive but a verified wake endpoint exists, a directed
  interrupt sends one coalesced, body-free prompt to that endpoint.
- A room interrupt may wake the current owner, not every parked member.
- Normal room chatter never injects terminal input.
- Existing standby delivery remains compatible, including pending/retry and
  generation invalidation.
- Delivery status is observable (`receiver`, `endpoint`, `pending`, or
  `unreachable`) without a new acknowledgement handshake in this phase.

The shipped skill should reserve `--interrupt` for a time-sensitive blocker,
veto, changed operator instruction, or ownership hazard. Normal discussion
stays normal.

## Phase 4: remove avoidable model and hook churn

Default JSON output becomes a thin machine envelope. Omit repeated static
`coordination_prompt`, prose `next`, redundant room fields, and duplicate event
representations when the same handoff is already top-level. Keep a verbose
diagnostic mode for humans and tests. Never truncate substantive bodies.

Reduce the installed Grok hook to lifecycle points that establish or end
identity. Remove `PreToolUse` after proving `SessionStart`,
`UserPromptSubmit`, and `SessionEnd` provide the session/PID evidence needed by
identity resolution. Repeated observations of the same session become
idempotent no-ops rather than JSONL appends.

Add harness lifecycle guards only after the core reachability work passes.
Each supported official hook is adapter-specific and optional:

- it checks the exact harness session, room ownership/reservation, and receiver
  or endpoint registration;
- it prevents or warns on ending a session that still owns the stick without a
  release;
- it fails open if Talking Stick is unavailable;
- it never releases, takes over, edits, or runs a message body automatically.

Claude Stop-hook behavior, Codex hook behavior, and Grok lifecycle behavior are
verified independently before any installer changes. Codex app-server
`turn/steer`/`turn/interrupt` remains a possible later fixed adapter, not a
phase-one dependency. MCP is not the event data plane.

## Verification and veto gates

### Protocol tests

- receiver register, heartbeat, conditional clear, crash cleanup, generation
  invalidation, and same-session duplicate rejection;
- health accuracy for `bin/tt`, source-tree, npm-global, and symlinked launches;
- fair release and named assignment across live receiver, verified endpoint,
  manual standby, stale intent, dead process, and changed harness session;
- claim-expiry requeue with and without a reachable peer, pending-handoff
  preservation, simultaneous waiter races, and zero repeated takeover signal;
- no automatic transition for owner-gone, owner-idle, or owner-timeout;
- direct and owner-targeted interrupt routing, constant prompt, hostile-body
  isolation, coalescing, retry, and stale-endpoint invalidation;
- compact JSON golden tests proving substantive messages/handoffs are intact;
- Grok hook install/update/uninstall/idempotence and bounded JSONL growth;
- adapter-specific lifecycle guards, including fail-open behavior and exact
  harness-session matching.

### Independent harness dogfood

Codex, Claude, and Grok each independently perform and record:

1. identity, join, and one-listener proof;
2. a normal message and a directed interrupt while waiting;
3. an interrupt with no foreground wait for every supported endpoint;
4. pass/assign/claim handoff delivery;
5. a deliberate duplicate-wait attempt;
6. a dead recipient excluded from fair release;
7. an expired reservation requeued exactly once;
8. full `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`;
9. independent diff review with `AGREE`, `CHANGES REQUESTED`, or `VETO`.

No phase advances until all three participants clear the veto gate. Installed
hook dogfood is reversible and occurs only after repository and disposable-home
tests pass. Publication/versioning is a separate operator decision.

## Explicitly deferred

- arbitrary command wake transports;
- a new delivery-acknowledgement handshake;
- a resident watcher daemon or MCP receive plane;
- automatic takeover of a live or plausibly live owner;
- heuristic pass throttling or body truncation;
- app-server control of a Codex thread until a fixed adapter can be bound and
  dogfooded without creating a second coordination stream.

## Review record

- Codex: `AGREE`, room note `781ae80d-0ce2-4be2-b60f-21d67c3c58a7`.
- Claude: `AGREE`, room event `13939`.
- Grok: `AGREE`, room event `13942`.
- Unanimous gate: room note `7c4cf06d-093d-412f-b4b5-3f2bea58332f`.
