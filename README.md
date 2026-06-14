# Talking Stick

A CLI coordination tool that lets multiple AI coding agents share a single workspace without stepping on each other. One agent holds the stick at a time; handoffs carry structured context so the next agent doesn't have to re-derive it.

**Version:** 0.4.12. Multi-process-safe (SQLite WAL), liveness-aware, no daemon. Supports Claude Code, Codex CLI, Antigravity CLI (`agy`), Grok Build, and OpenCode out of the box. Gemini CLI identity is retained for existing sessions, but Gemini skill installation is deprecated in favor of Antigravity and the shared agents skill directory. Two agents in the same room can also chat out-of-band — without passing the stick — via `tt msg send/recv`.

## Quickstart

Three steps, then you're coordinating two agents in the same repo.

### 1. Install the `tt` binary

```bash
npm i -g talking-stick
```

### 2. Install the skill in every harness

```bash
tt install --all
```

Restart any harness that was already running so it loads the updated skill. The skill teaches agents to coordinate by running `tt` CLI commands from the workspace. To tune the default collaboration prompt without editing installed package files, run `tt instructions edit`.

### 3. Try it: two agents, one repo

Open two terminal panes side by side — tmux split, iTerm split, two windows, whatever you like. `cd` into the same repo in each, and launch a different harness in each pane:

| Pane A — Claude Code | Pane B — Codex |
|---|---|
| `cd ~/myrepo && claude [--dangerously-skip-permissions]` | `cd ~/myrepo && codex` |

Then prompt them.

**Pane A (Claude Code):**

> Draft a plan to add OAuth login. When it's solid, pass the stick to Codex for critique. After Codex hands it back with revisions, finalize, then pass to Codex to implement — you'll test and review. `/talking-stick`

**Pane B (Codex):**

> Join the room and wait for the stick. When Claude passes you a plan, critique it sharply and pass it back with revisions. Later, when Claude hands you the implementation turn, build it and pass back for review. `$talking-stick`

That's the whole workflow. They negotiate turns automatically, hand off structured context (status, next action, artifacts) at each transition, and never edit the repo at the same time.

### Install options

| Method | Command | Notes |
|---|---|---|
| **From npm** | `npm i -g talking-stick` | Published as `0.4.1`. Requires Node ≥ 22. |
| **From GitHub** | `npm i -g github:mostlydev/talking-stick` | Tracks the `master` branch; builds on install via the `prepare` hook. |
| **From source** | `git clone … && npm install && npm link` | For contributors. |

All three produce a `tt` binary on your `PATH`. Everything else below works identically.

### Verify without installing

Want to see exactly what `tt install` would change before touching anything?

```bash
tt install --all --print
```

### Install into a subset

```bash
tt install claude-code codex
```

During normal execution, install commands skip harnesses that are not present instead of failing or creating new harness config roots.

### Update

Uses the right npm/pnpm/yarn by default:

```bash
tt self-update
```

`tt self-update` also removes stale Talking Stick MCP registrations left by older installs. The first normal `tt` invocation after a package-version change runs the same cleanup if the package manager skipped lifecycle scripts.

### Remove

```bash
tt uninstall --all
```

Single-harness uninstalls for shared-reading harnesses leave `~/.agents/skills/talking-stick` in place because Codex, Antigravity, Grok, and OpenCode share that one skill location. Use `tt uninstall agents` or `tt uninstall --shared` to remove only the shared skill target.

## What it gives your agent

Once installed, each agent harness has a skill that tells it to coordinate through the `tt` CLI:

```
tt list            — which rooms exist under a path
tt join            — join the room for this workspace
tt leave           — explicitly leave a room; deletes it when no active members remain
tt wait            — block until the stick is available, with takeover signals
tt wait --park     — stay coordinated without auto-claiming idle rooms
tt release         — normal handoff to the next fair waiter, with structured Handoff
tt assign          — explicit handoff to a named agent
tt take            — deliberate claim when the prior holder is gone/stuck
tt kick            — evict an idle member whose process is gone
tt state           — authoritative state projection
tt events          — audit log and long-poll stream of turn transitions/messages
tt notes add/list  — durable async observations for the room
tt msg send/recv   — out-of-band chat into the room event log
tt instructions    — editable collaboration prompt loaded by the skill
```

A workspace maps to a room — usually the `git` root or nearest project marker — so two agents `cd`'d anywhere under the same repo join the same room automatically. Marker files directly in your home directory are ignored for descendant paths, so scratch directories under `$HOME` do not collapse into one broad home-scoped room unless you explicitly join home itself.

The global skill tells the model when to join, wait, take over, leave notes, send messages, and hand off.

## Editable collaboration instructions

The bundled skill is the safety floor. It is intentionally small and package-managed. Local collaboration preferences live in editable Markdown files that `tt instructions` shows to agents after they join.

```bash
tt instructions show                     # effective prompt for the detected harness
tt instructions show --harness codex     # view one harness's effective prompt
tt instructions edit                     # edit user defaults
tt instructions edit --project           # edit this repo's overrides
tt instructions reset --project          # remove this repo's override
```

Effective instructions are layered in this order: bundled defaults, user defaults at `${TALKING_STICK_DATA_DIR}/instructions.md` (normally `~/.local/share/talking-stick/instructions.md`), then project overrides at `.talking-stick/instructions.md` in the workspace root. User and project files are created lazily on first edit, so installing `tt` does not litter repositories or harness config directories.

## Non-owner notes

While you wait your turn you may still need to flag something to the current owner: a subtle invariant, a related bug, a pointer to a doc. Non-owner notes give you a durable channel without interrupting the turn.

- Any joined member (owner or not) can `add_note` with a short plain-text body (≤ 16 KB). An optional `turn_id` scopes the note to a specific turn; omitted, the note is room-scoped and survives turn transitions.
- `list_notes` returns notes for the room; readers can paginate with `after_note_id` and opt into resolved entries with `include_resolved`.
- Notes are for observations and pointers, not for coordinating shared edits. Shared workspace changes still require holding the stick.

## Out-of-band messaging

The stick guarantees single-writer authority over shared workspace state. It is **not** a chat protocol. When two agents need to talk — design questions, "are you about to break X?", live coordination — use messages instead of churning the stick.

```bash
tt msg send <recipient|room> "<body>" [--interrupt] [--stdin]
tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent]
tt events --wait|--follow [--event TYPE[,TYPE]] [--target self|any|agent]
```

- `<recipient>` is a full `agent_id`, an unambiguous active display name (`codex`, `claude`), or the literal `room` for broadcast.
- `--interrupt` marks the message time-sensitive; receivers decide whether to act on it now.
- `tt msg recv --follow` is a long-running tail (one JSON line per event) suited to harnesses that can monitor child stdout (Claude Code Monitor, terminals).
- `tt msg recv --wait` exits on the next matching batch — ideal for harnesses that can launch a background command and notice when it completes; restart with `--after <last_event_seq>` to resume.
- `tt events --wait` and `tt events --follow` default to `--target self`; pass `--target any` only for audit/debug views.
- `wait_for_events` is observer-safe: it never mutates room state, so non-holders can use it freely without disturbing turn-fairness bookkeeping.
- Event receive does not grant the stick. Agents must still use `tt wait` for ownership before editing shared files.

**When to message vs note vs handoff.**

- **Message** — conversational, ephemeral, between live processes. Six round-trips of "what about line 84?" cost about as much as one structured handoff and zero stick churn.
- **Note** (`tt notes add`) — durable, resolvable artifacts. Leave a note when the next holder should consider something at handoff, or when the observation should outlive the conversation.
- **Handoff** (`release_stick` / `pass_stick`) — transfer of work. Messages do not replace handoffs; they live alongside them.

**`to_agent_id` is routing, not ACL.** Any room member can read any message via `get_room_events` or `tt events --follow --target any`. Messages are not private. They also do not grant the stick — a non-holder paging the holder gets attention, not write authority.

For harnesses that only notice completed subprocesses, run `tt events --wait --after <cursor> --json` as a wake process alongside the normal `tt wait --json` loop. A message, pass, release, or assignment event should make the agent read/reply/retry `tt wait`; it is not permission to mutate the workspace.

## How installation works per harness

`tt install` installs or refreshes the bundled `talking-stick` skill. It does not add MCP servers. During install, uninstall, package update, and first run after an installed package version changes, `tt` removes stale MCP registrations written by older Talking Stick releases.

- Claude Code: copied or linked into `~/.claude/skills/talking-stick` because Claude Code does not read `~/.agents/skills`
- Codex, Antigravity (`agy`), Grok Build, and OpenCode: copied or linked once into the shared `~/.agents/skills/talking-stick`
- Grok Build: also installs a trusted global session hook at `~/.grok/hooks/talking-stick-session.json`
- Gemini CLI: deprecated for skill installation; `tt install gemini` prints a deprecation notice and runs cleanup only

By default, `tt install` links the bundled skill so local updates are picked up immediately. Pass `--copy` if you want a standalone snapshot.

For harnesses that previously had proprietary skill copies, `tt` prunes duplicate `talking-stick` entries conservatively: it removes only symlinks that resolve to the bundled Talking Stick skill, and preserves copied directories, foreign symlinks, or hand-authored entries. OpenCode cleanup checks both `~/.config/opencode/skills/talking-stick` (honoring `XDG_CONFIG_HOME`) and the older `~/.opencode/skills/talking-stick` location.

Stale MCP cleanup is strict for OpenCode JSON entries: it removes only the canonical `mcp.talking-stick` value with `["tt", "mcp"]` and leaves hand-edited entries alone. Claude Code, Codex, and Gemini cleanup uses their own `mcp remove` commands when the old server name exists. Grok Build and Antigravity have no Talking Stick MCP registration path; install is native skill plus hook/shared skill only. Every cleanup run appends JSONL audit entries to `${TALKING_STICK_DATA_DIR}/update-migrations.log`.

Human CLI invocations also perform a silent best-effort sync for already-installed file-based skills in Claude Code and the shared `~/.agents/skills/talking-stick` target. If the installed skill is a copy, it is refreshed from the bundled skill; if it is a stale symlink, it is relinked. Missing skill installs are skipped. Gemini skill sync is deprecated; use Antigravity/shared install instead.

## Human CLI

The same `tt` binary also works as a human CLI, useful for watching or participating in a room from your terminal:

```text
tt whoami [--explain]                                      # show the resolved CLI identity
tt list [path]                                            # list rooms
tt join [path] [--force-new]                              # join the room for path
tt leave [path]                                           # leave the room for path
tt wait [path] [--timeout 110s] [--park]                  # block until your turn; --park disables idle auto-claim
tt try [path] [--park]                                    # non-blocking claim attempt
tt state [path]                                           # full room state
tt events [path] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]  # room event log; --wait/--follow long-polls
tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--path DIR]  # send an OOB message
tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent] [--path DIR]  # receive OOB messages
tt instructions show [path] [--harness claude|codex|antigravity|gemini|grok|opencode|all] [--scope effective|bundled|user|project]  # show collaboration prompt
tt instructions edit [path] [--user|--project]             # edit user or project prompt
tt instructions reset [path] (--user|--project)            # delete a user or project prompt
tt release [path] --status TEXT --next-action TEXT        # normal handoff
tt pass [path] --status TEXT --next-action TEXT           # pass/end your turn
tt assign <target|next> [path] --status TEXT --next-action TEXT  # explicit handoff
tt take [path] [--reason TEXT]                            # human-friendly take/override
tt takeover [path] [--reason TEXT]                        # alias for take
tt notes add <body> [--turn N] [--path DIR] [--stdin]     # leave an async note
tt notes list [--all] [--after ID] [--limit N] [--path DIR] # read notes
tt install <harness...> | --all [--print] [--copy] [--link]  # install skill and clean stale MCP entries
tt uninstall <harness...|agents> | --all | --shared [--print] # remove skill and stale MCP entries
tt self-update [--print] [--manager npm|pnpm|yarn|bun]    # update to the latest published tt
```

`[path]` defaults to the current working directory. Omit it for normal in-repo coordination; pass it only when you intentionally want a different or nested room.

`tt self-update` detects how `tt` was installed (npm / pnpm / yarn / bun, including npm-via-Homebrew/mise/asdf/nvm), runs the right global-update command, then removes stale MCP registrations from older Talking Stick installs. Pass `--print` to see the inferred command without running it; pass `--manager` to override detection. Running `tt self-update` from a development checkout (where `tt` resolves outside `node_modules/talking-stick`) refuses and tells you to `git pull && npm install && npm run build` instead.

Human CLI commands use a stable identity like `human:<username>`. When `tt wait`, `tt take`, or `tt takeover` wins the turn, a small background guardian keeps the lease alive on your behalf until you release, pass, or assign it. Human CLI `take` intentionally works without a required reason so an operator can step into a stuck room quickly; harness-aware CLI takeovers still require `--reason` unless the command includes `--operator-requested`.

### CLI identity

By default, `tt` behaves like a human CLI and resolves to `human:<username>` only when no harness environment is detected.

Harness-aware CLI identity is resolved before the human fallback:

- Known harness environment markers such as `CLAUDECODE=1`, `CODEX_THREAD_ID`, `ANTIGRAVITY_AGENT=1`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `GEMINI_CLI=1`, `CMUX_AGENT_LAUNCH_KIND=grok`, or `OPENCODE=1` make `tt` derive a harness-style identity automatically. Antigravity uses `ANTIGRAVITY_CONVERSATION_ID` as the preferred session anchor, falling back to `ANTIGRAVITY_TRAJECTORY_ID` and then `agy` process ancestry. The cmux Grok marker is optional; Grok Build also works without cmux by walking process ancestry for a `grok` root process.
- Grok Build's installed hook records hook-only `GROK_SESSION_ID` context into `${TALKING_STICK_DATA_DIR}/grok-sessions.jsonl`, letting later Grok-launched `tt` calls upgrade from process identity to the real Grok session id. `GROK_SESSION_ID` by itself is not treated as a normal shell marker, and the hook is not required for basic Grok detection.
- Set `TT_HARNESS_AGENT_ID=<agent-id>` if the harness wants to export the exact agent id directly.
- Set `TT_HARNESS_EXPORT=1` only when you need ancestry-based harness detection without a known harness environment marker.

If no harness signal is present, `tt` stays on the human CLI path. That keeps ordinary shell usage predictable while preventing harness-launched shells from silently joining rooms as `human:<username>`.

Use `tt whoami --explain` to see which identity path the CLI chose.

## Design highlights

- **Workspace-root room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room automatically. Nested rooms require explicit `force_new`.
- **Structured handoffs.** `release_stick` and `pass_stick` carry a typed `Handoff` with required `status` / `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Fair handoff selection.** Normal release prefers a recent waiter that is new or has gone longest without holding the stick; if the best-known candidate is between wait polls, a short grace window prevents immediate recycling to a less-fair claimant.
- **No immediate take-backs.** If release leaves a handoff idle, the prior owner waits through the short grace window before reclaiming while another member exists.
- **Ephemeral rooms.** `leave_room`/`tt leave` removes membership, rooms with no active members are physically deleted, and long-idle rooms with no recent activity or provably live member process are purged opportunistically on later invocations. The default idle retention is seven days.
- **Fencing tokens.** `lease_id` + `turn_id` make stale writes impossible — an agent who lost their turn cannot commit anything under the room's name.
- **Liveness-aware recovery.** Dead or crashed holders are detected with OS-level process checks; claim-timeout takeover skips the prior owner when another active member is waiting.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for `wait_for_turn`. No daemon required.
- **Per-call identity derivation.** Harness-launched CLI calls derive identity from harness environment or ancestry. Human CLI callers get a stable `human:<username>` identity.

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

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for a per-version summary; full release notes live in [`docs/releases/`](docs/releases/).

When cutting a release, add entries under `CHANGELOG.md`'s `Unreleased` section,
then run `npm version <new-version>`. The version lifecycle script moves those
entries into the new version section, writes `docs/releases/<version>.md`, and
adds the GitHub release link before npm commits and tags the version.

## Read next

- [`docs/talking-stick-plan.md`](docs/talking-stick-plan.md) — full protocol, state transitions, persistence model, design rationale, and open questions.
- [`docs/ambient-presence.md`](docs/ambient-presence.md) — design sketch for shell-prompt awareness, event streaming, and agent skills that make room state ambient rather than appointment-only.
- [`docs/non-owner-notes.md`](docs/non-owner-notes.md) — design backing the v1 notes feature; documents what shipped, what was deferred (`resolve_note`, wait_for_turn unread hints), and the rationale.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into global harness skill directories.

## License

MIT. See [LICENSE](LICENSE).
