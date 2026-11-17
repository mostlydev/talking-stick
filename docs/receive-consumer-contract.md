# Receive Consumer Contract

`tt wait` is the agent receive primitive. It combines turn state and room events in one signal-only CLI process. The service RPC remains bounded internally, but the CLI silently re-enters it until an actionable signal or explicit timeout.

## Cursor ownership

- `event_seq` is monotonic per database.
- Normal `tt wait --json` calls read `event_cursor_seq` from `cli-sessions.json` and persist the returned cursor before exiting.
- A sustained foreground wait registers its room member, receiver ID, exact PID/start time, cursor, generation, and heartbeat for the command lifetime. Cleanup is conditional on receiver ID, so an old process cannot erase its replacement.
- `--after N` is an explicit replay/debug override, not part of the normal agent loop.
- Delivery is at least once across crashes; consumers must tolerate replay and may deduplicate by `event_id`.
- Default JSON omits duplicated protocol boilerplate and room/turn or identical handoff fields repeated inside an event when the envelope already carries them. It adds one short `hint` only when the caller must cross a join, authority, wait-exit, or handoff transition. Substantive messages, handoffs, and `event_id` values are never truncated. Use `--verbose` for the full diagnostic representation.

## Process lifecycle

- Keep one wait subprocess active while shared work remains.
- Build, clean, and generated-output commands count as shared workspace mutations. They may remove or replace the CLI executable underneath another consumer and therefore require a live stick grant.
- A concurrent second wait for the same room member receives `duplicate_listener`; Talking Stick does not kill either process automatically.
- Internal service timeouts do not produce CLI output and do not exit the process.
- A harness tool may yield a process handle before the subprocess exits. Poll or resume that same handle; do not launch a replacement yet.
- Only after the subprocess exits should the consumer process the result and start one successor.
- A terminal active-wait `not_yet` result carries that successor reminder. Parked waits do not, because park is not an active-work loop.
- Do not shorten the CLI timeout to fit a tool-yield interval. A tool yield and a wait timeout are different events.
- A non-zero exit from `tt release`, `tt pass`, `tt assign`, or `tt take` means the turn did not change. Exit 127 means `tt` never ran at all. Re-verify ownership with `tt state --json` instead of assuming the handoff happened.

## Passive standby

- `tt wait --park` is a live parked listener. It does not auto-claim and is excluded from ordinary release routing.
- Once a room contains receiver registrations, fair release skips active waiters without a live registered receiver. Pre-registry rooms retain their existing behavior during upgrade.
- `tt standby` records parked intent and reports `can_self_wake` and `wake_transports`. The
  `transport` field describes the cmux or manual fallback. A native wake can be available with
  `transport: manual`.
- Directed messages, operator room messages, passes, assignments, and pending-handoff hints can
  wake parked members. Ordinary agent room messages wake nobody.
- When `can_self_wake` is false, keep one `tt wait --park --json` subprocess running.

## Filtering and authority

- `target=self` receives direct events plus broadcasts from other agents and excludes the caller's own broadcasts.
- Turn-taking member joins and leaves are broadcast lifecycle events. They wake existing self-targeted receivers so an agent does not infer room membership from a silent, stale wait.
- `target=any` is for audit/debug views and the operator chat console. A `human_chat` console refreshes its existing observer membership separately; watching the full stream does not register turn interest.
- Chat observer joins and leaves do not produce agent lifecycle wakes. A live console keeps the
  room open. Observers are excluded from claim eligibility and fair handoff selection, and
  observer wait/take attempts are rejected.
- Ordinary CLI waits do not open-claim a solo room. An agent deliberately working alone uses `tt wait --claim`; a self reservation can still be claimed normally. The service API retains its compatible default unless `allow_solo_claim: false` is supplied.
- A wait suppresses the caller's completed release/pass events and obsolete self claim events before applying the batch limit. Incoming takeover warnings remain visible; audit queries retain the original events.
- Messages are room-visible routing, not private ACLs.
- Event delivery never grants write authority. Only `status: "your_turn"` with a live `guardian_pid` does.
- Membership is revalidated throughout a turn wait. A member removed while polling receives `unknown_member` and can never be granted a lease from that stale wait.
- An expired unowned reservation emits `reservation_expired`, keeps the pending handoff, and reroutes to a reachable waiter or idle. That event is not write authority and does not return `takeover_available`. Owner-gone, owner-idle, and owner-timeout still require explicit `tt take`.

## Interrupt delivery

- A foreground `tt wait` records the caller's verified cmux surface (when `cmux identify` succeeds) as a session-scoped wake endpoint. Absence of cmux is valid; the endpoint is invalidated when the harness session changes.
- An operator room interrupt targets every joined agent. An agent room interrupt targets the
  current owner. Each directed interrupt reserves its own delivery and can trigger native
  steering even while a receiver is running.
- Native envelopes include a token for `tt ack`. A fallback wake instructs the consumer to read
  through its normal wait. Transport acceptance and receipt are separate. See
  [wake routing and send results](reference.md#waking-idle-agents).

Lower-level `tt events` and `tt msg recv` commands remain useful for human audit and debugging, but agents must not run them beside `tt wait` as a second receive loop.
