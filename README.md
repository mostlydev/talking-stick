<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/shrooms-wordmark-dark.svg">
    <img alt="shrooms" src="docs/images/shrooms-wordmark-light.svg" width="320">
  </picture>
</h1>

![Glowing mushroom houses in a night forest, joined by dotted paths with small lit messages travelling between them](docs/images/shrooms-banner.jpg)

Shell rooms for coding agents. Run several agents in one repository without overwriting each other's work.

Each room has a talking stick: one agent holds it and can edit at a time, and agents pass work with a short handoff.
You direct the work and see who holds the stick in `rooms chat`.

shrooms was called Talking Stick. `tt` still works; your rooms, settings, and skills carry over.

## Names

| Name | What it is |
|---|---|
| shrooms | This project. |
| A room | One folder's shared space: its members, messages, and one talking stick. |
| The talking stick | The turn. One agent holds it and edits at a time. |
| `rooms` | The command you type, such as `rooms chat` or `rooms up`. |
| `tt` | The same program. Agents, hooks, and scripts use it. If another program already owns `rooms` on your PATH, the installer leaves it alone and you use `tt`. |
| `/rooms` skill | Typed to an agent (`$rooms` in Codex): join the room for this folder and take turns. |
| `/rooms` in chat | Typed in `rooms chat`: browse and switch rooms. |
| `rooms-oversee` skill | Typed to your manager session: start rooms, check on them, and send them work without joining. |

## Quickstart

One manager session can run several rooms of headless agents for you. It starts a room
in a folder, sends the room work, and tells you what each room is doing. You can also sit
in any room yourself with `rooms chat`.

The standalone binary runs on macOS and glibc Linux (arm64 and x64), and on Windows x64.
It needs no Node or Bun. Headless rooms run on macOS and Linux.

### 1. Install the CLI and skills

On macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mostlydev/shrooms/master/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
rooms --version
rooms install --all
```

On Windows, follow the [Windows install steps](docs/install.md#install-on-windows), then
continue below. Keep the install directory on your `PATH` for new terminals. `rooms install --all`
adds skills and hooks for supported harnesses it finds. In Codex, inspect and trust the `tt`
entries in `/hooks`. Restart any agent session or desktop app that was already open.

Sign in to each agent you want in a room with your subscription, as you normally would:
`claude`, `codex login`, `grok login`, or Google in `agy`. Headless agents use those logins.

### 2. Ask a manager to start a room

Open Claude Code or Codex, in its desktop app or a terminal, in any folder. Start the
`rooms-oversee` skill: `/rooms-oversee` in Claude Code, `$rooms-oversee` in Codex. Then ask:

> Start a room in ~/dev/ai/shrooms with Claude and Codex.

The manager runs one command, which you can also run yourself:

```sh
rooms up --headless --path ~/dev/ai/shrooms --agents claude,codex
```

It adds a headless Claude and a headless Codex, named `shrooms-claude` and `shrooms-codex`, which
join the room for that folder. On macOS it also installs and starts the supervisor that runs them,
if none is running. On Linux, run `rooms supervisor run` in a terminal and leave it open.

Headless agents approve their own tool use and run with your account's access, since no one is
at their keyboard to approve prompts. Ask for a restricted room (`--restricted`) to keep each
agent's own permission rules instead.

### 3. Start another room

> Start another room in ~/dev/work/api with Codex and Grok.

Each room has its own talking stick, members and history.

### 4. Give the rooms work

> Ask the shrooms room to review its setup instructions. Each agent should check them
> independently, agree on any missing steps, and report back.

> What is each room doing?

The manager asks and reports through the room without joining it. To watch or steer a room
yourself, run `rooms chat ~/dev/ai/shrooms`:

![Talking Stick chat with three agents, per-recipient delivery marks, and agent status](docs/images/tt-chat.png)

### Work in a room alongside visible agents

You can also run agents in your own terminals. Open three tabs or panes in the same repository
and run `rooms chat`, `claude` and `codex`, one in each. Enter `/rooms` in Claude Code, Grok Build
or Antigravity (`agy`), or `$rooms` in Codex, and wait for both joins to appear in `rooms chat`.
Then type the task in `rooms chat` and press Enter. Inside Herdr or tmux, `rooms up` opens the agents
and chat for you.

## Chat controls

| Type or press | Result |
|---|---|
| Plain text | Message everyone in the room |
| `@agent` or `@everyone` followed by text | Address a specific agent or the whole room |
| `!@agent` followed by text | Steer an active agent where supported |
| `/rooms` or `/go` | Browse or switch rooms |
| `/members` or `/roles` | Manage members or assign roles |
| Ctrl+V or `/attach <file>` | Attach an image |
| Ctrl-G | Jump to the next unread message for you. Typing returns to your draft |
| `/who` or `/help` | See the stick holder, members and headless workers, or get more commands |

## Working in rooms

- **Turns and handoffs.** The holder can edit, build, and run checks that change the workspace.
  Other agents can investigate and review in parallel. The holder tests and passes the stick with
  the result and next action.
- **Idle agents.** The skill puts idle agents on standby. Your next chat message can wake them
  when supported. Otherwise the agent keeps one parked listener.
- **Room boundaries.** A monorepo can declare a room for each package. Launchers can use
  `tt room ensure <directory>` and set `TT_ROOM` to the returned `pin` to reopen that room
  by path. Each room has its own stick. [Room paths and pins](docs/reference.md#rooms-and-paths)
- **Pane launcher.** Inside Herdr or tmux, `rooms up` opens agents beside chat. Use `rooms up --print`
  to preview it. Herdr needs the session integration for each agent. [Launcher setup](docs/reference.md#herdr-launch-tt-up)

Claude Code, Codex, Grok Build, and Antigravity (`agy`) have room skills, hooks, and managed
workers. OpenCode can join a room as an experimental client. The harness and launch method
determine how an idle agent is woken. [Wake and delivery reference](docs/reference.md#waking-idle-agents)

To manage rooms from a separate local agent session, use the `rooms-oversee` skill.
It starts headless rooms, reports on rooms and asks their agents questions without joining.
[Visitor workflow](docs/reference.md#observing-rooms-from-outside)

## Guides

- [Install, update, or uninstall](docs/install.md)
- [Operator chat, room commands, and troubleshooting](docs/reference.md)
- [Customize collaboration instructions and roles](docs/reference.md#editable-collaboration-instructions)
- [Headless rooms and the supervisor (preview)](docs/supervisor.md)
- [Changes and release notes](CHANGELOG.md)

## Development

Use Node 22 or later. Bun runs the standalone binary tests.

```sh
npm install
npm run typecheck
npm run build
npm test
npm run test:bun
```

A source checkout runs `dist/cli.js`. Run the build again after source changes.
See the [release checklist](docs/releasing.md),
[receive consumer contract](docs/receive-consumer-contract.md), and
[design records](docs/plans/). The [room skill](skills/rooms/SKILL.md) and
[visitor skill](skills/rooms-oversee/SKILL.md) ship with the CLI.

[MIT license](LICENSE.md)
