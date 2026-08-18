# Talking Stick

A CLI coordination tool that lets multiple AI coding agents share a single workspace without stepping on each other. One agent holds the stick at a time; handoffs carry structured context so the next agent doesn't have to re-derive it.

Multi-process-safe (SQLite WAL), liveness-aware, no daemon. Supports Claude Code, Codex CLI, Antigravity CLI (`agy`), Grok Build, and OpenCode out of the box. Gemini CLI identity is retained for existing sessions, but Gemini skill installation is deprecated in favor of Antigravity and the shared agents skill directory. One `tt wait --json` long-poll handles ownership and room events using a CLI-managed cursor; agents can chat out-of-band without passing the stick via `tt msg send`.

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

Installing for Claude Code also merges a managed Stop-guard hook into `~/.claude/settings.json`: when a Claude session tries to stop while it still owns the stick or holds an unclaimed reservation, the hook blocks the stop once and tells the model to release, pass, or enter standby first. It is read-only, fails open whenever coordination state is unavailable, never blocks twice in a row, and touches only its own settings entry. Pass `--no-guard` at install time to skip it; `tt uninstall claude-code` removes it.

### 3. Try it: two agents, one repo

Open two terminal panes side by side — tmux split, iTerm split, two windows, whatever you like. `cd` into the same repo in each, and launch a different harness in each pane:

| Pane A — Claude Code | Pane B — Codex |
|---|---|
| `cd ~/myrepo && claude [--dangerously-skip-permissions]` | `cd ~/myrepo && codex` |

Then give **both** panes the same prompt — a shared goal plus the skill trigger:

> `/goal Work together to implement OAuth login. Use the /talking-stick $talking-stick skill for coordination`

`/talking-stick $talking-stick` triggers the skill in either harness, and the goal keeps each agent driving toward the shared objective. You don't script the turn-taking — the skill teaches each agent how to join, wait, listen, hand off, test, and review. Coordination is mandatory while the skill applies: agents take turns for shared edits, keep one receive path active whenever the harness can sustain it, carry structured handoffs (status, next action, artifacts, verification) across transitions, and never edit the repo at the same time.

### Install options

| Method | Command | Notes |
|---|---|---|
| **From npm** | `npm i -g talking-stick` | Latest published release. Requires Node ≥ 22. |
| **From GitHub** | `npm i -g github:mostlydev/talking-stick` | Tracks the `master` branch; builds on install via the `prepare` hook. |
| **From source** | `git clone … && npm install && npm link` | For contributors. |

All three produce a `tt` binary on your `PATH`. Everything else below works identically.
Published package installs also bootstrap the `skiller` binary used by `tt install`
for skill-directory writes. Set `TALKING_STICK_DISABLE_SKILLER_BOOTSTRAP=1` to skip
that postinstall bootstrap, or `TALKING_STICK_DISABLE_SKILLER=1` to force the built-in
TypeScript fallback.

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

The package refreshes unedited generated instructions automatically. Customized instruction files and copied skills are preserved and receive an explicit replacement command instead of being overwritten.

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
tt wait            — long-poll for ownership and room events; cursor is saved automatically
tt wait --park      — stay coordinated without auto-claiming idle rooms
tt standby          — park, return immediately, and optionally wake the cmux surface later
tt release         — normal handoff to the next fair waiter, with structured Handoff
tt assign          — explicit handoff to a named agent
tt take            — deliberate claim when the prior holder is gone/stuck
tt kick            — evict an idle member whose process is gone
tt state           — authoritative state projection
tt health/status   — concise local safety/action check; --verbose shows diagnostics
tt events          — audit/debug log and lower-level event stream
tt notes add/list  — durable async observations for the room
tt msg send        — out-of-band chat into the room event log
tt instructions    — show, edit, safely update, or reset local instruction overrides
```

A workspace maps to a room — usually the `git` root or nearest project marker — so two agents `cd`'d anywhere under the same repo join the same room automatically. An existing parent room also wins across a nested Git repository or nearer project marker; `--force-new` is the explicit way to create a nested room. Marker files directly in your home directory are ignored for descendant paths, so scratch directories under `$HOME` do not collapse into one broad home-scoped room unless you explicitly join home itself.

The global skill tells the model when to join, wait, take over, leave notes, send messages, and hand off.

## Editable collaboration instructions

The bundled skill is the safety floor. It is intentionally small and package-managed. Local collaboration preferences live in editable Markdown files that `tt instructions` shows to agents after they join.

Instruction delivery is deliberately tiered:

| Surface | When the model sees it | Content |
| --- | --- | --- |
| Installed skill | When Talking Stick is invoked/loaded | Full ownership, wait, recovery, and handoff mechanics |
| `tt instructions show` | Once after joining | Concise working agreement plus the detected harness's default role |
| Compact `tt` result hints | Only at join, authority, wait-exit, and handoff transitions | One short next-step safety reminder |
| Wake and Claude Stop hooks | Only on the matching lifecycle event | Fixed resume or release/pass warning |
| README and design docs | Only when explicitly opened | Human reference and rationale |

Normal `tt join --json` includes compact current-member summaries and omits the large policy block; `--verbose` retains the full diagnostic result. This lets an agent discover expected peers without polling `tt state`.

```bash
tt instructions show                     # effective prompt for the detected harness
tt instructions show --harness codex     # view one harness's effective prompt
tt instructions edit                     # edit user defaults
tt instructions edit --project           # edit this repo's overrides
tt instructions update --user            # auto-refresh generated defaults; preserve custom content
tt instructions update --user --replace  # explicitly replace customized user instructions
tt instructions reset --project          # remove this repo's override
```

Effective instructions are layered in this order: bundled defaults, user overrides at `${TALKING_STICK_DATA_DIR}/instructions.md` (normally `~/.local/share/talking-stick/instructions.md`), then project overrides at `.talking-stick/instructions.md` in the workspace root. Generated, unedited files update automatically. Customized files are preserved and appear as `update_available` in `tt instructions show` until explicitly replaced. User and project files are created lazily on first edit, so installing `tt` does not litter repositories or harness config directories.

## Non-owner notes

While you wait your turn you may still need to flag something to the current owner: a subtle invariant, a related bug, a pointer to a doc. Non-owner notes give you a durable channel without interrupting the turn.

- Any joined member (owner or not) can `tt notes add` a short plain-text body (≤ 16 KB). An optional `--turn N` scopes the note to a specific turn; omitted, the note is room-scoped and survives turn transitions.
- `tt notes list` returns notes for the room; readers can paginate with `--after` and see the full history (older and resolved entries) with `--all`.
- Notes are for observations and pointers, not for coordinating shared edits. Shared workspace changes still require holding the stick.

## Out-of-band messaging

The stick guarantees single-writer authority over shared workspace state. It is **not** a chat protocol. When two agents need to talk — design questions, "are you about to break X?", live coordination — use messages instead of churning the stick.

```bash
tt msg send <recipient|room> "<body>" [--interrupt] [--stdin]
tt wait --json
```

- `<recipient>` is a full `agent_id`, an unambiguous active display name (`codex`, `claude`), or the literal `room` for broadcast.
- `--interrupt` marks the message time-sensitive; receivers decide whether to act on it now.
- `tt wait` includes ownership and room events by default. It reads and advances `event_cursor_seq` in `cli-sessions.json`, so normal agents do not pass `--events` or manage `--after`.
- Joins and leaves are broadcast lifecycle events: an existing `tt wait` wakes when room membership changes. The joining or leaving member does not receive its own broadcast through the default self view.
- The CLI renews its bounded service wait internally and silently in the same process. Without an explicit `--timeout`, silence never makes `tt wait` exit.
- A foreground `tt wait` registers its exact process identity for the life of that command. A second live wait for the same room member fails with `duplicate_listener`; a crashed receiver may be replaced after exact liveness or heartbeat-grace validation.
- Default command JSON is a thin machine envelope: it omits repeated static reminders and event fields already present at the envelope, but adds a short `hint` only at join, authority, wait-exit, and handoff transitions. It never truncates message or handoff text. Add `--verbose` to retain the full diagnostic representation.
- A tool yield is not a wait timeout. If the harness returns a running process handle, poll that same process instead of starting another wait. When the process actually exits, start one successor if shared work remains. Do not add short explicit timeouts.
- `tt events --wait`, `tt events --follow`, and `tt msg recv` remain available for human audit and debugging. Agents should not run them beside `tt wait` as a second receive loop.
- The wait loop can claim or receive a turn. An event wake by itself grants no authority.
- Membership is checked again on every turn-wait poll and immediately before a grant, so a kicked, superseded, or otherwise removed waiter cannot acquire the stick from an already-running command.
- A successful `tt wait` or `tt take` result with `status: "your_turn"` and a live `guardian_pid` grants authority to edit shared files.
- Ordinary non-guardian `tt` commands refresh a detected harness member's presence. Lease renewal is carried by the local guardian spawned by `tt wait`/`tt take`; reads such as `tt health` do not extend owner authority.
- Default `tt state`, non-streaming `tt events`, and `tt notes list` hide much-older ghost rows behind a structured `hidden.older_count` summary. Default `tt health` is a concise action card backed by the receiver registry rather than command-line scanning; use `tt health --verbose` or `--all` for full member and receiver diagnostics.

**When to message vs note vs handoff.**

- **Message** — conversational, ephemeral, between live processes. Six round-trips of "what about line 84?" cost about as much as one structured handoff and zero stick churn.
- **Note** (`tt notes add`) — durable, resolvable artifacts. Leave a note when the next holder should consider something at handoff, or when the observation should outlive the conversation.
- **Handoff** (`tt release` / `tt pass`) — transfer of work. Messages do not replace handoffs; they live alongside them.

**`to_agent_id` is routing, not ACL.** Any room member can read any message via `tt events --target any`. Messages are not private. They also do not grant the stick — a non-holder paging the holder gets attention, not write authority.

## Post-turn closeout

After a handoff, an agent keeps the wait loop alive while work is pending, runs `tt standby --wake cmux --json` when it is only waiting on an external signal, or — when the shared task is genuinely complete — stops and sends a final closeout instead of churning the room. Standby records parked intent, returns immediately, and wakes the same verified cmux surface once for a directed actionable update. `--wake manual` is available outside cmux but cannot self-wake. Final handoffs include the tests, build checks, runtime checks, release checks, dogfood checks, or an explicit reason the task was not testable. The exact completion evidence an agent must see before declaring done lives in the skill ([`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md)).

## How installation works per harness

`tt install` installs or refreshes the bundled `talking-stick` skill. Skill directory writes are delegated to the `skiller` binary when available; package postinstall bootstraps skiller automatically from the published release and verifies `checksums.txt` before installation. If skiller is missing, disabled, or fails its version gate, `tt` uses the built-in TypeScript fallback.

- Claude Code: copied or linked into `~/.claude/skills/talking-stick` because Claude Code does not read `~/.agents/skills`
- Codex, Antigravity (`agy`), Grok Build, and OpenCode: copied or linked once into the shared `~/.agents/skills/talking-stick`
- Grok Build: also installs a trusted global session hook at `~/.grok/hooks/talking-stick-session.json`
- Gemini CLI: deprecated for skill installation; `tt install gemini` prints a deprecation notice and runs cleanup only

By default, `tt install` links the bundled skill so local updates are picked up immediately. Pass `--copy` if you want a standalone snapshot.

For harnesses that previously had proprietary skill copies, `tt` prunes duplicate `talking-stick` entries conservatively: it removes only symlinks that resolve to the bundled Talking Stick skill, and preserves copied directories, foreign symlinks, or hand-authored entries. OpenCode cleanup checks both `~/.config/opencode/skills/talking-stick` (honoring `XDG_CONFIG_HOME`) and the older `~/.opencode/skills/talking-stick` location.

Automatic skill sync records the digest of managed copied skills. A known unedited copy updates automatically; an unknown or edited copy is preserved and the CLI offers `tt install <harness> --replace`. Managed symlinks continue to follow the bundled skill directly.

Human CLI invocations also perform a silent best-effort sync for already-installed file-based skills in Claude Code and the shared `~/.agents/skills/talking-stick` target. If the installed skill is a copy, it is refreshed from the bundled skill; if it is a stale symlink, it is relinked. Missing skill installs are skipped. Gemini skill sync is deprecated; use Antigravity/shared install instead.

## Human CLI

The same `tt` binary also works as a human CLI, useful for watching or participating in a room from your terminal:

```text
tt whoami [--explain]                                      # show the resolved CLI identity
tt list [path]                                            # list rooms
tt join [path] [--force-new]                              # join the room for path
tt leave [path]                                           # leave the room for path
tt wait [path] [--timeout 110s] [--park] [--after N]          # ownership + events; saved cursor by default
tt standby [path] [--wake cmux|manual]                     # return immediately; wake later on directed action
tt try [path] [--park] [--after N]                        # non-blocking claim/event check
tt state [path] [--all]                                  # compact room state; --all shows older rows
tt health [path] [--verbose|--all]                       # concise safety/action check; verbose shows diagnostics
tt status [path] [--verbose|--all]                       # alias for health
tt events [path] [--all] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]  # audit/debug event log; --wait/--follow lower-level streams
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
tt install <harness...> | --all [--print] [--copy] [--link] [--replace] # install or explicitly replace skill
tt uninstall <harness...|agents> | --all | --shared [--print]            # remove skill
tt self-update [--print] [--manager npm|pnpm|yarn|bun]    # update to the latest published tt
```

`[path]` defaults to the current working directory. Omit it for normal in-repo coordination; pass it only when you intentionally want a different or nested room.

Help flags are always read-only. `--help` and `-h` take precedence over command
execution, even for stateful commands such as `wait`, `release`, `assign`,
`notes add`, or `msg send`; they do not join rooms, claim turns, spawn
guardians, write events, or update local session state.

`tt self-update` detects how `tt` was installed (npm / pnpm / yarn / bun, including npm-via-Homebrew/mise/asdf/nvm) and runs the right global-update command. Pass `--print` to see the inferred command without running it; pass `--manager` to override detection. Running `tt self-update` from a development checkout (where `tt` resolves outside `node_modules/talking-stick`) refuses and tells you to `git pull && npm install && npm run build` instead.

Human CLI commands use a stable identity like `human:<username>`. When `tt wait`, `tt take`, or `tt takeover` wins the turn, a small background guardian keeps the lease alive on your behalf until you release, pass, or assign it. If that guardian's captured harness process appears gone but the harness has recent `tt` activity, Talking Stick retains the lease and keeps heartbeating; a process-gone and silent owner is surrendered as `harness_gone`. Human CLI `take` intentionally works without a required reason so an operator can step into a stuck room quickly; harness-aware CLI takeovers still require `--reason` unless the command includes `--operator-requested`.

### CLI identity

By default, `tt` behaves like a human CLI and resolves to `human:<username>` only when no harness environment is detected.

Harness-aware CLI identity is resolved before the human fallback:

- Known harness environment markers such as `CLAUDECODE=1`, `CODEX_THREAD_ID`, `ANTIGRAVITY_AGENT=1`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `GEMINI_CLI=1`, `CMUX_AGENT_LAUNCH_KIND=grok`, or `OPENCODE=1` make `tt` derive a harness-style identity automatically. Antigravity uses `ANTIGRAVITY_CONVERSATION_ID` as the preferred session anchor, falling back to `ANTIGRAVITY_TRAJECTORY_ID` and then `agy` process ancestry. The cmux Grok marker is optional; Grok Build also works without cmux by walking process ancestry for a `grok` root process.
- Grok Build's installed hook records hook-only `GROK_SESSION_ID` context into `${TALKING_STICK_DATA_DIR}/grok-sessions.jsonl`, letting later Grok-launched `tt` calls upgrade from process identity to the real Grok session id. It runs only at `SessionStart`, `UserPromptSubmit`, and `SessionEnd`; equivalent observations for one session/process/workspace are idempotent, so per-tool activity does not grow the log. `GROK_SESSION_ID` by itself is not treated as a normal shell marker, and the hook is not required for basic Grok detection.
- Set `TT_HARNESS_AGENT_ID=<agent-id>` if the harness wants to export the exact agent id directly.
- Set `TT_HARNESS_EXPORT=1` only when you need ancestry-based harness detection without a known harness environment marker.

If no harness signal is present, `tt` stays on the human CLI path. That keeps ordinary shell usage predictable while preventing harness-launched shells from silently joining rooms as `human:<username>`.

Use `tt whoami --explain` to see which identity path the CLI chose.

## Design highlights

- **Parent-room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room automatically, even when the chosen subfolder is a nested Git/project root. The search stops before a descendant implicitly inherits a room at `$HOME`; nested rooms require explicit `force_new`.
- **Structured handoffs.** `tt release` and `tt pass` carry a typed `Handoff` with required `status` / `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Fair handoff selection.** Normal release prefers a recent waiter that is new or has gone longest without holding the stick; if the best-known candidate is between wait polls, a short grace window prevents immediate recycling to a less-fair claimant.
- **No immediate take-backs.** If release leaves a handoff idle, the prior owner waits through the short grace window before reclaiming while another member exists.
- **Ephemeral rooms.** `tt leave` removes membership, rooms with no active members are physically deleted, and long-idle rooms with no recent activity or provably live member process are purged opportunistically on later invocations. The default idle retention is seven days.
- **Conservative harness identity upgrades.** A verified `harness:<session>` identity may replace a provisional `pid:`, `term:`, or `userhost:` identity only when both belong to the same harness process. Distinct verified sessions coexist; one cannot delete another merely because their short-lived `tt` subprocesses share a parent harness.
- **Fencing tokens.** `lease_id` + `turn_id` make stale writes impossible — an agent who lost their turn cannot commit anything under the room's name.
- **Liveness-aware recovery.** Dead or crashed holders are detected with OS-level process checks; claim-timeout takeover skips the prior owner when another active member is waiting.
- **Readable default projections.** State, events, notes, and health anchor to the room's newest real activity and collapse much-older ghost rows, while `--all` and explicit cursors preserve full audit history.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for the wait loop. No daemon required.
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

- [`docs/receive-consumer-contract.md`](docs/receive-consumer-contract.md) — cursor ownership, subprocess lifecycle, filtering, and authority rules for the unified wait loop.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into global harness skill directories.

## License

MIT. See [LICENSE.md](LICENSE.md).
