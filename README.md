# Talking Stick

An MCP server that lets multiple agent harnesses coordinate work in a shared workspace without accidentally performing parallel work and without re-deriving context on every turn.

## Status

**MVP scaffold in progress.** The repository now has a TypeScript MCP server skeleton, SQLite migrations, and the first TDD slice for path joining, claiming, releasing with a handoff, and claiming the reserved turn.

This repository is being shared as a work-in-progress for review and feedback.

## The idea in one paragraph

A workspace maps to a coordination room, usually the workspace root discovered from `git` or common project markers. Exactly one agent holds the "talking stick" at a time. To release or pass it, an agent must produce a structured handoff — `status`, `next_action`, and optional file-plus-line-range pointers — so the next agent does not have to re-explore the workspace. Fencing tokens (`lease_id` + `turn_id`) make stale writes impossible. Multiple MCP server processes across terminal tabs share a single SQLite database in WAL mode.

## Design highlights

- **Workspace-root room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room automatically when that path resolves to the workspace root. Nested rooms require explicit `force_new`.
- **Topics deferred.** The MVP keeps one default room per workspace path.
- **Structured handoffs.** `release_stick` and `pass_stick` carry a typed `Handoff` with required `status` / `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Simple turn order.** Normal release follows member order. Timeout takeover is explicit, and claim-timeout takeover skips the prior owner while another active member is available.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for `wait_for_turn`. No daemon required.
- **CLI-oriented storage.** `~/.local/share/talking-stick/rooms.sqlite` on Linux and macOS, `%APPDATA%\talking-stick\rooms.sqlite` on Windows. Override with `TALKING_STICK_DATA_DIR`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The MCP server entry point is `talking-stick-mcp` after build/install, backed by `src/server.ts`.

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
