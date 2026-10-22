# Talking Stick

Run Claude Code, Codex, Grok and other coding agents on the same repo without them overwriting
each other. One agent holds the stick at a time, handoffs carry structured context so the next
agent doesn't re-derive it, and `tt chat` gives you one console to talk to all of them.

**[Jump to the quickstart →](#quickstart)**

![The tt chat console: three agents in one room, delivery marks on each message, and agent status in the footer](docs/images/tt-chat.png)

No daemon, no server. Multi-process-safe via SQLite WAL, liveness-aware, and it works with Claude
Code, Codex CLI, Antigravity (`agy`), Grok Build, and OpenCode out of the box.

## Quickstart

macOS or glibc Linux, arm64 or x64. No Node or Bun required.

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh | sh
tt install --all
```

The installer downloads the release for your platform, verifies its SHA-256 checksum, and links
`~/.local/bin/tt`. `tt install` adds the coordination skill, plus a few hooks, to every harness it
finds and skips the ones you don't have. In Codex, open `/hooks` once and trust the new Talking
Stick entries. Restart any harness that was already running.

In Herdr, run `tt install herdr` once to enable Ctrl-click navigation to unread messages.
Restart `tt chat` after linking the plugin; `/ack` also works without it.

### 2. Set up the panes

Split your terminal like the screenshot above: the agents stacked on the left, the console on the
right. Start every pane in the same repository. By default the whole repository is one room
([unless you declare more](#commands)).

| Left column, one pane per agent | Right column |
|---|---|
| `cd ~/myrepo && claude`<br>`cd ~/myrepo && codex`<br>`cd ~/myrepo && grok` | `cd ~/myrepo && tt chat` |

Two agents are enough to start. In [Herdr](https://herdr.dev) or tmux, `tt up` builds this layout
for you (see [Herdr and tmux](#herdr-and-tmux)).

### 3. Point each agent at the skill, and nothing else

Give every agent pane the same one-line prompt:

> `Use the /talking-stick $talking-stick skill.`

That's the whole prompt — no task yet. Each agent joins the room and waits for you; the console
shows each join, so agents don't announce themselves. Prefer a plain prompt over harness goal
modes such as `/goal`, whose automatic continuation keeps restarting an agent.

### 4. Give them the work from the console

Say hello in `tt chat`, then give the task in the same console:

> `Hey guys. Introduce yourselves.`
>
> `Work together to implement OAuth login.`

A room message reaches every agent, and they coordinate from there: the skill teaches each agent
to join, wait, take turns, hand off, test, and review. Driving from the console rather than typing
into each harness keeps them in sync. The footer shows who holds the stick.

| You type | What happens |
|---|---|
| `ship it when tests pass` | Goes to the whole room |
| `@codex rebase onto master` | Goes to Codex; `@everyone` addresses every agent in the room |
| `!@claude stop, wrong file` | Steers Claude mid-task, at its next tool step |
| `/rooms` or Ctrl+T | Folders first; Backspace moves up. Tab narrows the tree to active host rooms; `/` filters and `s` sorts |
| `/members` | Pick a member to message or remove (removal asks first) |
| `/roles` | Assign roles, edit their definitions, and set harness defaults |
| `/clear` | Clear your room view; reopening resumes here. Saved messages remain available with `/older` |
| Cmd+V / Ctrl+V, a dragged-in image, or `/attach <file>` | Attach an image; agents get its path and read it |
| Ctrl-click the ▲ unread bar in Herdr, or `/unread` | Visit missed messages oldest-first; each visited message is marked read. Esc returns live |
| `/theme tide` | Save the palette: Lantern (warm default), Tide (teal), or Dusk (lavender) |
| Shift+Enter or Alt+Enter | Insert a newline; the draft wraps as you type |
| `/who`, `/help` | Members and stick holder; all commands |

Each message header marks every recipient: `…` not delivered yet, `✓` delivered, `!` failed. That's
a delivery receipt, not proof the model acted on it.

## How a session works

- **Turns.** Only the agent whose `tt wait` returned `your_turn` with a live guardian edits, builds,
  or tests. Everyone else stays read-only and can still investigate, message, and leave notes.
- **Handoffs.** The holder tests, then runs `tt release` (next fair waiter) or `tt assign <agent>`
  (a specific reviewer). The handoff carries `status`, `next_action`, and `artifacts`.
- **Messages.** `tt msg send` carries questions, review notes, and vetoes without passing the stick.
- **Idle.** An agent with nothing to do runs `tt standby` and ends its turn. A directed message, your
  room message, an assignment, or a pending handoff wakes it again.
- **Finish.** Every participant reviews the result and explicitly agrees. With a console open,
  agents stay in standby rather than leaving, so a message brings them back.

## Checking on rooms from anywhere

The `talking-stick-rooms` skill (installed by `tt install`) turns any local agent session into a
manager for every room on your computer: it reports what each room is doing, asks agents
questions, passes on your instructions or approvals, and collects their answers. It never joins a
room. It only needs a session that can run `tt` on this computer, started in any folder:

| App | How |
|---|---|
| Claude Code | `/talking-stick-rooms What is the clawdapus pair doing?` |
| Claude desktop | Switch to **Code** (`</>`), choose **This computer** and a folder (your home folder works), then type `/talking-stick-rooms` and your question |
| Codex CLI | `$talking-stick-rooms What is the clawdapus pair doing?` |
| ChatGPT desktop | Start a **Work** conversation that runs on your computer, with any local folder. Select **Talking Stick Rooms** with `@` and ask. |

ChatGPT finds the skill in `~/.agents/skills`, where `tt install codex` puts it. Before relying on a
new app or mode, check that it reaches your rooms: ask it to run `command -v tt` and
`tt room list --all --json`. Your home folder or development parent is not required: a dedicated
local manager folder works too, provided the session can access the host's `tt` and room data.
See [ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work) and
[skill selection](https://learn.chatgpt.com/docs/build-skills).

In the Claude desktop app, use a [local session in the **Code** tab](https://code.claude.com/docs/en/desktop#use-skills), which loads `~/.claude/skills`
and runs commands on your computer. `tt install` installs Claude Code's skill files, not your Claude
account's Skills, so the skill doesn't appear in regular chats or Cowork. You can upload it there
(zip the `talking-stick-rooms` folder, then
[Customize > Skills > + > Create skill > Upload a skill](https://support.claude.com/en/articles/12512180-use-skills-in-claude)).
An uploaded skill supplies instructions, not host command access. Chat/Cowork execution may run
in the cloud or an isolated local environment; connecting a folder alone does not establish access
to the host's `tt` and room database. That workflow needs its own host-tool bridge, which Talking
Stick does not currently install. See [Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview).

Some apps, ChatGPT among them, may not connect to the agents' sockets. The message is still
stored, and an open `tt chat` in that room delivers it within a minute; otherwise the next `tt`
command anyone runs does. Answers aren't pushed back to the app: ask it to check for replies.
Agents treat your relayed instructions as coming from the app's agent, not from you, and say
so if their rules need you to confirm in that room's console.

## Waking idle agents

A wake carries the messages themselves in a compact envelope. The agent acts on what it received
and acknowledges with a short `tt ack <token>` instead of fetching again. Native wakes type no keystrokes,
and an idle agent spends no model turns waiting.

| Harness | How messages reach it |
|---|---|
| Claude Code | Its inbox socket. Your messages arrive at the next tool boundary without cancelling the current tool |
| Codex | Native `turn/steer` for operator messages and urgent prompts in a live daemon-backed turn; `codex queue` while idle or when steering is definitely unavailable. Trusted Stop hooks deliver other unread room events |
| Grok Build | Hooks during an active turn; an idle session needs a live `tt wait` or cmux |
| Antigravity, OpenCode, Gemini | cmux only |

cmux, and anything too large for an envelope, gets a short notice telling the agent to run
`tt wait`. Details: [Waking idle agents](docs/reference.md#waking-idle-agents).

## Commands

```text
tt join / tt leave       join or leave this workspace's room
tt wait                  long-poll for the turn and room events (--park never claims)
tt standby               park and wake this session later
tt release / tt pass     hand off with structured status and next action
tt assign <agent>        hand off to someone specific
tt take                  claim when the holder is gone or stuck
tt msg send / tt notes   message members, or leave durable notes
tt chat                  operator console
tt up                    open agents and a console in Herdr or tmux panes (experimental)
tt room                  list, declare, adopt, or remove a repository's rooms
tt room list --all       every room on this host with live members
tt room brief <room>     what a room is doing, without joining it
tt room ask <room>       ask a room's agents something; tt room replies reads answers
tt state / tt health     room state and a concise safety check
tt events --follow       watch a room live, as JSON lines
```

Full flags and semantics: [command reference](docs/reference.md#command-reference).

**Rooms.** Every directory in a repository joins the repository's room unless you declare more with
`tt room create packages/api`, for example one per package in a monorepo. An agent belongs to one
room per repository at a time. See [Rooms and paths](docs/reference.md#rooms-and-paths).

### Herdr and tmux

Inside Herdr, or a tmux pane, `tt up` turns the current pane into the console and opens a column of agents beside
it: Claude, Codex, and Antigravity by default, when installed. `--agents claude,codex` picks agents,
`--print` previews, and `--new-tab` or `--new-workspace` opens a separate tab or workspace. Each
agent gets the skill prompt, and `tt up` checks that it joined the right room. Reruns don't
duplicate agents that are already running. Details:
[Herdr launch](docs/reference.md#herdr-launch-tt-up).

## Installing and updating

| Method | Command |
|---|---|
| Standalone binary (recommended) | `curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh \| sh` |
| A specific version | `… \| sh -s -- --version 0.30.0` |
| Windows (x64) | Download `talking-stick_<version>_windows_x64.tar.gz` from [Releases](https://github.com/mostlydev/talking-stick/releases) (see below) |
| From source | `git clone … && npm install && npm link` (needs Node ≥ 22) |

**Windows.** The installer script does not run on Windows yet, so install the archive by hand: check
it against `checksums.txt`, extract it with the built-in `tar -xzf`, put the folder on your `PATH`,
then run `tt install --all`. `tt.exe` finds its skill files beside it, so keep the folder intact. A
hand-extracted release does not update itself; download the next one to upgrade.

The installer accepts `--bin-dir DIR` (default `~/.local/bin`) and `--install-dir DIR` (default
`~/.local/share/talking-stick`). Each release lives in its own directory under `releases/`, with
the skill files beside the binary. `tt` links to the active release, and skill links go through the
`current` link, so updates keep them pointing at the right files.

```bash
tt install --all --print       # preview every change without touching anything
tt install claude-code codex   # install into a subset
tt self-update                 # reinstall the latest release with the same directories
tt uninstall --all             # remove
```

**Automatic updates.** An installed release checks for a new version once a day, when you start an
interactive command such as `tt chat`. The check takes at most three seconds; if a newer release
exists, `tt` downloads and installs it, then asks you to rerun the command. Agent commands, hooks,
JSON output, redirected terminals, and source checkouts never update. Set `TT_NO_AUTO_UPDATE=1` to
turn this off; `tt self-update` still works.

**After any update,** restart running harnesses so they load the new skill and hooks, and reopen
`tt chat`.

**Hooks `tt install` adds.** All of them merge into existing settings, fail open, and are
removed by `tt uninstall`.

- Claude Code: a stop guard that blocks stopping once while the session still holds the stick
  (skip with `--no-guard`), and tool-boundary hooks for `!@claude` steering.
- Codex: session lifecycle and turn hooks. Trust them in `/hooks`.
- Grok Build: session, stop-guard, and active-turn delivery hooks.

**Moving from npm.** The npm package stopped updating after 0.23.0. Run the installer: it moves
skill links that still point into the npm package (only ones Talking Stick made and you haven't
edited), then offers to run `npm uninstall -g talking-stick`. It answers No by default, and
`--remove-npm` answers yes. It never offers for an `npm link`ed checkout.

## Customizing what agents are told

The bundled skill is the safety floor. Your own collaboration preferences live in editable Markdown
that agents read after joining, layered bundled defaults → your defaults → this repository's
overrides:

```bash
tt instructions show             # effective prompt for the detected harness
tt instructions edit             # your defaults
tt instructions edit --project   # this repository's overrides
```

Roles, such as a reviewer, are defined in the same files. Assign them per room, or as defaults per
harness, from `/roles` in `tt chat`. Unedited generated files update automatically; customized ones
are preserved. See [Editable collaboration instructions](docs/reference.md#editable-collaboration-instructions)
and [Roles](docs/reference.md#role-assignments-and-harness-defaults).

## Storage

`~/.local/share/talking-stick/rooms.sqlite` on Linux and macOS (honoring `$XDG_DATA_HOME`),
`%APPDATA%\talking-stick\rooms.sqlite` on Windows. Override with `TALKING_STICK_DATA_DIR`.

## Development

```bash
npm install
npm test            # Node/Vitest suite; builds and drives the standalone binary when Bun is installed
npm run test:bun    # bun:sqlite adapter tests (needs Bun)
npm run typecheck
npm run build
node scripts/build-standalone.mjs   # standalone archive for this platform, in release-dist/
```

A development checkout runs `dist/cli.js` under Node (better-sqlite3); the standalone binary is the
same code compiled with `bun build --compile` (bun:sqlite). Run `npm run build` after source changes
and restart any long-running harness that cached the old build.

To cut a release, add entries under `CHANGELOG.md`'s `Unreleased` section, then on a release branch
run `npm version <new-version> --no-git-tag-version`. The lifecycle script moves those entries into
the new version section, writes `docs/releases/<version>.md`, and adds the release link. Merge the
release PR, wait for CI on the merge commit, then push an annotated `v<version>` tag. The Release
workflow builds and smoke-tests the macOS and Linux binaries and attaches them, with
`checksums.txt`, to the GitHub release.

Write local links relative to the repository root; the script rebases them for the release notes
and aborts before writing anything if a local target is missing. Put code examples in fenced blocks,
since indented lines are treated as list continuations and their links are rewritten too. Keep
inline code spans on one line.

## Read next

- [`docs/reference.md`](docs/reference.md) — full command surface, delivery semantics, identity
  resolution, install behavior, and design notes.
- [`docs/receive-consumer-contract.md`](docs/receive-consumer-contract.md) — cursor ownership,
  subprocess lifecycle, filtering, and authority rules for the unified wait loop.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into
  harness skill directories.
- [`skills/talking-stick-rooms/SKILL.md`](skills/talking-stick-rooms/SKILL.md) — the companion skill for
  managing rooms from outside them.
- [`CHANGELOG.md`](CHANGELOG.md) — per-version summary; full notes in [`docs/releases/`](docs/releases/).

## License

MIT. See [LICENSE.md](LICENSE.md).
