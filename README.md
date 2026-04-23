# Talking Stick

An MCP coordination server that lets multiple AI coding agents share a single workspace without stepping on each other. One agent holds the stick at a time; handoffs carry structured context so the next agent doesn't have to re-derive it.

**Version:** 0.1.0-alpha. Multi-process-safe (SQLite WAL), liveness-aware, no daemon. Supports Claude Code, Codex CLI, Gemini CLI, and OpenCode out of the box.

## Quickstart

```bash
npm i -g talking-stick
tt install --all
tt install-skill --all
```

`tt install --all` detects every supported harness on your machine and registers Talking Stick as a user-global MCP server in each one. Restart your harness; the `talking_stick` tools will be available in any workspace.

`tt install-skill --all` installs the global Talking Stick skill into each detected harness so the coordination behavior lives in one maintainable place instead of being copied into repo-local instructions. By default it installs symlinks, so skill updates follow your current checkout automatically.

Want to see what it would do first?

```bash
tt install --all --print
```

Want to install into a specific subset?

```bash
tt install claude-code codex
```

Want to remove it?

```bash
tt uninstall --all
tt uninstall-skill --all
```

## What it gives your agent

Once installed, each agent harness sees these tools:

```
list_rooms         — which rooms exist under a path
join_path          — join the room for this workspace
wait_for_turn      — block until the stick is available, with takeover signals
heartbeat          — prove liveness while holding the stick
release_stick      — normal handoff to the next member, with structured Handoff
pass_stick         — explicit handoff to a named agent
takeover_stick     — deliberate claim when the prior holder is gone/stuck
get_room_state     — authoritative state projection
get_room_events    — audit log of turn transitions
```

A workspace maps to a room — usually the `git` root or nearest project marker — so two agents `cd`'d anywhere under the same repo join the same room automatically.

The skill complements the MCP tools:

- MCP gives the harness the coordination surface
- the global skill tells the model when to join, wait, heartbeat, take over, and hand off

## How installation works per harness

`tt install` prefers each harness's own `mcp add` subcommand when available (so the server ends up in the right user-global config with the right schema), and falls back to direct JSON editing when it isn't.

| Harness       | Scope        | Under the hood                                                              |
|---------------|--------------|-----------------------------------------------------------------------------|
| claude-code   | user         | `claude mcp add -s user talking-stick -- tt mcp`                            |
| codex         | user         | `codex mcp add talking-stick -- tt mcp`                                     |
| gemini        | user         | `gemini mcp add -s user -t stdio talking-stick tt mcp`                      |
| opencode      | user         | Merge `mcp.talking-stick` into `$XDG_CONFIG_HOME/opencode/opencode.json`    |

All four install into **user-global scope**, not project-local. A coordination server is only useful if every workspace your agent enters can see the same rooms — project-scoped MCP would defeat the point.

If you'd rather register it by hand, run `tt install --print <harness>` to see the exact command or JSON edit, then apply it yourself.

## How skill installation works per harness

Talking Stick also ships with a portable `talking-stick` skill:

- Claude Code: copied or linked into `~/.claude/skills/talking-stick`
- Codex: copied or linked into `~/.codex/skills/talking-stick`
- Gemini: installed with `gemini skills install ... --scope user` or linked with `gemini skills link ... --scope user`
- OpenCode: copied or linked into `~/.opencode/skills/talking-stick`

By default, `tt install-skill` links the bundled skill into each harness so local updates are picked up immediately. Pass `--copy` if you want a standalone snapshot instead.

## Human CLI

The same `tt` binary also works as a human CLI, useful for watching or participating in a room from your terminal:

```text
tt list [path]                                            # list rooms
tt join [path] [--force-new]                              # join the room for path
tt wait [path] [--timeout 30s]                            # block until your turn
tt try [path]                                             # non-blocking claim attempt
tt state [path]                                           # full room state
tt events [path] [--after N] [--limit N]                  # room event log
tt release [path] --status TEXT --next-action TEXT        # normal handoff
tt pass [target] [path] --status TEXT --next-action TEXT  # explicit handoff
tt takeover [path] --reason TEXT                          # deliberate takeover
tt mcp                                                    # run the MCP stdio server
tt install <harness...> | --all [--print]                 # register MCP server
tt uninstall <harness...> | --all [--print]               # remove MCP server
tt install-skill <harness...> | --all [--print] [--copy] [--link]  # install global talking-stick skill
tt uninstall-skill <harness...> | --all [--print]         # remove global talking-stick skill
```

Human CLI commands use a stable identity like `human:<username>`. When `tt wait` or `tt takeover` wins the turn, a small background guardian keeps the lease alive on your behalf until you release or pass it.

## Design highlights

- **Workspace-root room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room automatically. Nested rooms require explicit `force_new`.
- **Structured handoffs.** `release_stick` and `pass_stick` carry a typed `Handoff` with required `status` / `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Fencing tokens.** `lease_id` + `turn_id` make stale writes impossible — an agent who lost their turn cannot commit anything under the room's name.
- **Liveness-aware recovery.** Dead or crashed holders are detected with OS-level process checks; claim-timeout takeover skips the prior owner when another active member is waiting.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for `wait_for_turn`. No daemon required.
- **Per-call identity derivation.** MCP callers don't supply `agent_id`; the adapter derives identity from the spawning harness process. Human CLI callers get a stable `human:<username>` identity.

## Storage

The coordination database lives at:

- Linux/macOS: `~/.local/share/talking-stick/rooms.sqlite` (or `$XDG_DATA_HOME/talking-stick/rooms.sqlite`)
- Windows: `%APPDATA%\talking-stick\rooms.sqlite`

Override with `TALKING_STICK_DATA_DIR` if you want to keep per-project state.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Read next

- [`docs/talking-stick-plan.md`](docs/talking-stick-plan.md) — full protocol, state transitions, persistence model, design rationale, and open questions.
- [`docs/ambient-presence.md`](docs/ambient-presence.md) — design sketch for shell-prompt awareness, event streaming, and agent skills that make room state ambient rather than appointment-only.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into global harness skill directories.

## License

Unlicensed WIP. To be decided before the first release.
