# Receive Consumer Contract

`tt wait` is the agent receive primitive. It combines turn state and room events in one bounded long-poll.

## Cursor ownership

- `event_seq` is monotonic per database.
- Normal `tt wait --json` calls read `event_cursor_seq` from `cli-sessions.json` and persist the returned cursor before exiting.
- `--after N` is an explicit replay/debug override, not part of the normal agent loop.
- Delivery is at least once across crashes; consumers must tolerate replay and may deduplicate by `event_id`.

## Process lifecycle

- Keep one wait subprocess active while shared work remains.
- A harness tool may yield a process handle before the subprocess exits. Poll or resume that same handle; do not launch a replacement yet.
- Only after the subprocess exits should the consumer process the result and start one successor.
- Do not shorten the CLI timeout to fit a tool-yield interval. A tool yield and a wait timeout are different events.

## Filtering and authority

- `target=self` receives direct events plus broadcasts from other agents and excludes the caller's own broadcasts.
- `target=any` is for audit/debug views.
- Messages are room-visible routing, not private ACLs.
- Event delivery never grants write authority. Only `status: "your_turn"` with a live `guardian_pid` does.

Lower-level `tt events` and `tt msg recv` commands remain useful for human audit and debugging, but agents must not run them beside `tt wait` as a second receive loop.
