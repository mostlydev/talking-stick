# Talking Stick

An MCP server that lets multiple agent harnesses coordinate work in a shared workspace without accidentally performing parallel work and without re-deriving context on every turn.

## Status

**Early planning.** No code yet. The full protocol design lives in [`docs/talking-stick-plan.md`](docs/talking-stick-plan.md) and is still evolving.

This repository is being shared as a work-in-progress for review and feedback.

## The idea in one paragraph

A workspace maps to a coordination room, identified by the deepest ancestor directory that already has one (like how `git` and `package.json` are discovered). Exactly one agent holds the "talking stick" at a time. To release or pass it, an agent must produce a structured handoff — `status`, `next_action`, and optional file-plus-line-range pointers — so the next agent does not have to re-explore the workspace. Round fairness prevents any agent from holding twice before every other active member has had a turn. Fencing tokens (`lease_id` + `turn_id`) make stale writes impossible. Multiple MCP server processes across terminal tabs share a single SQLite database in WAL mode.

## Design highlights

- **Hierarchical room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room automatically if one exists. Nested rooms require explicit `force_new`.
- **Optional topics.** Multiple concurrent conversations at the same path use `(canonical_path, topic)` as the room key. Default topic is empty.
- **Structured handoffs.** `release_stick` and `pass_stick` carry a typed `Handoff` with required `status` / `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Round fairness.** `last_held_turn_id` per member and `current_round_started_at_turn_id` per room enforce "no consecutive turns" across normal claims, reserved claims, and takeovers. Explicit pass is the only fairness-exempt operation.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for `wait_for_turn`. No daemon required.
- **Platform-conventional storage.** `~/.local/share/talking-stick/rooms.sqlite` on Linux, `~/Library/Application Support/talking-stick/rooms.sqlite` on macOS, `%APPDATA%\talking-stick\rooms.sqlite` on Windows. Override with `TALKING_STICK_DATA_DIR`.

## MCP surface (MVP)

```text
list_rooms
join_path
wait_for_turn
heartbeat
release_stick
pass_stick
takeover_stick
get_room_state
get_room_events
```

## Read next

- [`docs/talking-stick-plan.md`](docs/talking-stick-plan.md) — full protocol, state transitions, persistence model, design rationale, and open questions.

## License

Unlicensed WIP. To be decided before the first release.
