# Talking Stick

Run multiple coding agents in one repository without overwriting each other's work.
One agent holds the stick and can edit at a time.
Agents pass work with a short handoff. You direct the work and see who holds the stick in `tt chat`.

## Quickstart

Use two agents you can already run locally, such as Claude Code and Codex. The standalone
binary runs on macOS and glibc Linux (arm64 and x64), and on Windows x64. It needs no Node or Bun.

### 1. Install the CLI and skills

On macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
tt --version
tt install --all
```

On Windows, follow the [Windows install steps](docs/install.md#install-on-windows), then
continue below. Keep the install directory on your `PATH` for new terminals. `tt install --all`
adds skills and hooks for supported harnesses it finds. In Codex, inspect and trust the Talking
Stick entries in `/hooks`. Restart any agent session that was already open after installing the skill.

### 2. Open the console and agent sessions

Open three terminal tabs or panes in the same repository. Run `tt chat` in one, `claude`
in another, and `codex` in the third. Use your own agent commands if you picked a different pair.
The repository is the default room.

### 3. Ask each agent to join

In Claude Code, enter `/talking-stick`. In Codex, enter `$talking-stick`. In other
supported harnesses, ask the agent to use the Talking Stick skill. Give each agent only the
skill prompt. Wait for both joins to appear in `tt chat` before sending the task.

### 4. Give the room a task

Type this in `tt chat` and press Enter:

> Review this repository's setup instructions. Each agent should check them independently.
> Agree on any missing steps and report back here. Keep this first pass read-only.

Look for the agents' replies in the transcript. The marks next to each recipient track delivery.

![Talking Stick chat with three agents, per-recipient delivery marks, and agent status](docs/images/tt-chat.png)

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
- **Pane launcher.** Inside Herdr or tmux, `tt up` opens agents beside chat. Use `tt up --print`
  to preview it. Herdr needs the session integration for each agent. [Launcher setup](docs/reference.md#herdr-launch-tt-up)

Claude Code, Codex, Antigravity, Grok Build, and OpenCode can join a room. Wake support depends
on the harness and how it launched. [Wake and delivery reference](docs/reference.md#waking-idle-agents)

To check on rooms from a separate local agent session, use the `talking-stick-rooms` skill.
It can report on rooms and ask their agents questions without joining. [Visitor workflow](docs/reference.md#observing-rooms-from-outside)

## Guides

- [Install, update, or uninstall](docs/install.md)
- [Operator chat, room commands, and troubleshooting](docs/reference.md)
- [Customize collaboration instructions and roles](docs/reference.md#editable-collaboration-instructions)
- [Managed headless workers (preview)](docs/supervisor.md)
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
[design records](docs/plans/). The [room skill](skills/talking-stick/SKILL.md) and
[visitor skill](skills/talking-stick-rooms/SKILL.md) ship with the CLI.

[MIT license](LICENSE.md)
