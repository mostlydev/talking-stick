# Receive Consumer Contract

`tt wait` is the agent receive primitive. It combines turn state and room events in one signal-only CLI process. The service RPC remains bounded internally, but the CLI silently re-enters it until an actionable signal or explicit timeout.

## Cursor ownership

- `event_seq` is monotonic per database.
- Normal `tt wait --json` calls read `event_cursor_seq` from `cli-sessions.json` and persist the returned cursor before exiting.
- A sustained foreground wait registers its room member, receiver ID, exact PID/start time, cursor, generation, and heartbeat for the command lifetime. Cleanup is conditional on receiver ID, so an old process cannot erase its replacement.
- `--after N` is an explicit replay/debug override, not part of the normal agent loop.
- Delivery is at least once across crashes; consumers must tolerate replay and may deduplicate by `event_id`.
- Default JSON omits only duplicated protocol boilerplate: static coordination prose, the prose restart hint, and room/turn or identical handoff fields repeated inside an event when the envelope already carries them. Substantive messages and handoffs are never truncated. Use `--verbose` for the full diagnostic representation.

## Process lifecycle

- Keep one wait subprocess active while shared work remains.
- Build, clean, and generated-output commands count as shared workspace mutations. They may remove or replace the CLI executable underneath another consumer and therefore require a live stick grant.
- A concurrent second wait for the same room member receives `duplicate_listener`; Talking Stick does not kill either process automatically.
- Internal service timeouts do not produce CLI output and do not exit the process.
- A harness tool may yield a process handle before the subprocess exits. Poll or resume that same handle; do not launch a replacement yet.
- Only after the subprocess exits should the consumer process the result and start one successor.
- Do not shorten the CLI timeout to fit a tool-yield interval. A tool yield and a wait timeout are different events.

## Passive standby

- `tt wait --park` is a live parked listener. It does not auto-claim and is excluded from ordinary release routing.
- Once a room contains receiver registrations, fair release skips active waiters without a live registered receiver. Pre-registry rooms retain their existing behavior during upgrade.
- `tt standby --wake cmux` records parked intent and returns immediately so the model turn can end without a terminal process.
- Directed messages, passes, assignments, and pending-handoff hints wake a registered cmux surface once. Broadcast chatter does not.
- `tt standby --wake manual` records the same intent but cannot self-wake.

## Filtering and authority

- `target=self` receives direct events plus broadcasts from other agents and excludes the caller's own broadcasts.
- `target=any` is for audit/debug views.
- Messages are room-visible routing, not private ACLs.
- Event delivery never grants write authority. Only `status: "your_turn"` with a live `guardian_pid` does.
- An expired unowned reservation emits `reservation_expired`, keeps the pending handoff, and reroutes to a reachable waiter or idle. That event is not write authority and does not return `takeover_available`. Owner-gone, owner-idle, and owner-timeout still require explicit `tt take`.

## Interrupt delivery

- A foreground `tt wait` records the caller's verified cmux surface (when `cmux identify` succeeds) as a session-scoped wake endpoint. Absence of cmux is valid; the endpoint is invalidated when the harness session changes.
- `tt msg send ... --interrupt` delivers through a live receiver's wait output when one exists. Otherwise a directed interrupt sends one fixed, body-free wake prompt to the recipient's verified endpoint, coalesced until the recipient is next seen.
- A room-targeted interrupt may wake only the current owner. Normal chatter, directed or broadcast, never injects terminal input.
- The send result exposes `delivery_status`: `receiver` (live wait will surface it), `endpoint` (wake prompt delivered), `pending` (endpoint known but not woken now: coalesced, failed, or manual standby), or `unreachable` (no live receiver and no valid endpoint). There is no acknowledgement handshake.

Lower-level `tt events` and `tt msg recv` commands remain useful for human audit and debugging, but agents must not run them beside `tt wait` as a second receive loop.
