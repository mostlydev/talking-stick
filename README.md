<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/shrooms-wordmark-dark.svg">
    <img alt="shrooms" src="docs/images/shrooms-wordmark-light.svg" width="320">
  </picture>
</h1>

![Glowing mushroom houses in a night forest, joined by dotted paths with small lit messages travelling between them](docs/images/shrooms-banner.jpg)

Shell rooms for coding agents. Each project folder gets a room: a shared space where a few
agents work on that project, take turns at its shared files, and hand the work on with a note.
You can sit in a room with them, or look in from outside.

shrooms was called Talking Stick. `tt` still works; your rooms, settings, and skills carry over.

## Why rooms

When every agent works in one shared space, with no walls and no subject of its own, their
contexts converge. Each agent reads what all the others did, until they all hold the same mixed
picture, and then that picture collapses: nobody keeps the details of their own subject.

People are the same. A team in its own workshop keeps its craft: what the materials are, what
is half finished, and why it was done that way. Teams in different workshops work together by
sending each other complete briefs, not by moving into one crowded room.

So each project gets its own room. A room belongs to one folder, usually a repository, and takes
its name and subject from it. It has its own members, messages, notes and handoffs, and one
talking stick. The agents in it keep the working knowledge of that project. Rooms reach each
other by asking questions and reading the answers, and they never merge.

## Inside a room

- **Members.** An agent joins the room for the folder it works in. Claude Code, Codex, Grok
  Build, Antigravity (`agy`) and OpenCode can all join. Any member can read, investigate and
  review at any time.
- **The talking stick.** One member at a time holds the stick, and only that member changes the
  shared files. It runs its checks, then passes the stick on with what changed, what it verified,
  and what to do next. See [Turns and room roles](#turns-and-room-roles).
- **You.** You come in through `rooms chat`. It shows who holds the stick and who is on standby,
  and you can message one agent or all of them. Members take your messages as instructions.
- **Blockers.** When the room needs your decision, a member raises a blocker: the facts and one
  question. It stays open in `rooms chat` (the header shows `1 blocker · /blockers`) and in
  `rooms room list --all` until you answer it. Use `/resolve ID <answer>` in chat to answer and
  close it.
- **Managers and visitors.** A manager is an agent session outside every room that uses the
  `rooms-oversee` skill. It starts rooms, asks what each one is doing, and passes on your
  instructions without joining. Anyone outside a room can ask it a question with
  `rooms room ask` and read the answers with `rooms room replies`.
- **Headless workers.** A room can also run agents that have no terminal. The supervisor starts
  them, keeps them running, and wakes them when work arrives for them.

## Briefs, questions and done

A room works from what it is told. Whoever sends it work, whether you, a manager or another
room, gives it a brief it can work from on its own:

- what the result is for, and who will use it;
- decisions from earlier conversations that the room hasn't seen;
- what will count as working, in use.

A good brief lets the room carry on even if its sender disappears.

A member that can't tell from its brief why something is wanted, or how to check it, asks the
sender before building. Asking is part of the work.

Done means the result works for its purpose, not merely that a list of steps ran.

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
| A member | An agent session that joined a room. |
| The operator | You, usually in `rooms chat`. |
| A manager | An agent session using the `rooms-oversee` skill. It starts rooms and asks them questions without joining. |
| A visitor | Anyone who asks a room a question from outside, with `rooms room ask`. |
| A blocker | A decision a room needs from the operator, left open and visible until it's answered. |
| A room role | A member's responsibility in one room, such as reviewer or scribe. It never grants the stick. Organization roles in [my-cli](https://github.com/fluxinc/my-cli#readme) are a different thing. |

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

### 2. Start rooms from a manager session

Open Claude Code or Codex, in its desktop app or a terminal, in any folder. Start the manager
skill: `/rooms-oversee` in Claude Code, `$rooms-oversee` in Codex. Then give it a brief for each
room, with what the work is for and how the room will know it's done:

> Start a room in ~/dev/ai/shrooms with Claude and Codex. Someone new will follow the setup
> instructions on a clean Mac next week. Have them check that each step works as written, and
> report what they had to change.

> Start another room in ~/dev/work/api with Claude and Codex. I'm planning next week's work.
> Have them review the open pull requests and tell me which ones need a decision from me.

The manager starts each room and visits it from outside, without joining. Each room keeps its
own members, messages and turn, so a question for the API room stays with the agents working on
the API. To preview what the manager will run for the first room:

```sh
rooms up --headless --path ~/dev/ai/shrooms --agents claude,codex --print
```

Without `--print`, this adds a headless Claude and a headless Codex, named `shrooms-claude` and
`shrooms-codex`, which join the room for that folder. On macOS it also installs and starts the
supervisor that runs them, if none is running. On Linux, run `rooms supervisor run` in a
terminal and leave it open.

Headless agents approve their own tool use and run with your account's access, since no one is
at their keyboard to approve prompts. Use `--restricted` to start new workers under each
harness's own permission rules instead. The supervisor denies any tool request that still needs
approval.

### 3. Check on the rooms

> What is each room doing?

The manager asks each room and reports back. To read a room's summary yourself, with who holds
the stick, its last handoff, open blockers and recent messages:

```sh
rooms room brief ~/dev/ai/shrooms
```

To sit in on the conversation, open `rooms chat ~/dev/ai/shrooms`:

![Talking Stick chat with three agents, per-recipient delivery marks, and agent status](docs/images/tt-chat.png)

To organize your own workspace and set organization roles, see
[my-cli](https://github.com/fluxinc/my-cli#readme). A my-cli session gets its own room.

### Work in a room alongside visible agents

You can also run agents in your own terminals. Open three tabs or panes in the same repository
and run `rooms chat`, `claude` and `codex`, one in each. Enter `/rooms` in Claude Code, Grok Build
or Antigravity (`agy`), or `$rooms` in Codex, and wait for both joins to appear in `rooms chat`.
Then type the task in `rooms chat` and press Enter. Inside Herdr or tmux, `rooms up` opens the agents
and chat for you.

## Turns and room roles

A room has one talking stick. The member holding it may change the shared workspace, including a build that replaces a file another member is using. The others read, investigate, and review. The holder runs the checks for that change, then passes the stick with what changed and what to do next.

A room role does not grant the stick and does not move it.

`rooms roles show` lists the roles in the room. The same list is edited in `rooms chat` with `/roles`. The grid's keys are in the [reference](docs/reference.md#role-assignments-and-harness-defaults).

| Room role | Responsibility |
|---|---|
| architect | Architecture, drafting, and synthesis across a long context |
| implementer | Precise implementation |
| tester | Tests and verification |
| reviewer | Independent review and cross-checks |
| scribe | Notes, documentation, and handoff summaries |

What a room role changes is the responsibility text in `rooms instructions show`, and who is told when an assignment or a definition changes. An assignment change tells the affected members. A definition change tells the members who hold that role. A change to the shared project instructions tells the members reading that file. A harness default also tells members in other open rooms who inherit it, and leaves a room's own override alone. The notice is a `[roles vN]` message. It applies on that member's next turn.

A room can add a role under `## Roles` in `.talking-stick/instructions.md`. User defaults live in the user instructions file. Definitions layer bundled, then user, then project.

These are room roles. They are not organization roles from another tool.

## Delivery and what you see

An agent with nothing to do waits on standby. A message from you, a message addressed to it, or
a pass of the stick wakes it. Messages between other agents in the room do not. Where its harness
can't be woken, the agent keeps one parked listener instead.
[Waking idle agents](docs/reference.md#waking-idle-agents)

When you send a message in `rooms chat`, each recipient gets its own delivery mark in the message
header:

- `…` while delivery is unfinished.
- `✓` once the recipient's `tt` has taken the message in. That is a receipt, not proof the model
  acted on it.
- `!` if delivery failed.

Plain output uses words such as `queued`, `not acknowledged yet` and `unreachable`. A message to
a member whose conversation has ended waits until that conversation runs `tt` again, and chat
does not mark it delivered.

A headless worker in the middle of a turn takes a new message when the turn ends. A headless
Codex worker can receive it mid-turn when the supervisor knows which turn is running. A worker stopped on an
approval prompt gets nothing until the prompt is settled.

To see what a room and its workers are doing:

- In `rooms chat`, the footer shows each member's state: `holding`, `up next`, `standby`,
  `active`, `idle` or `away`. `/who` lists the members, and each headless worker's state and
  the command that fixes it when it is blocked.
- The header shows `1 blocker · /blockers` while the room waits on your decision, and
  `1 headless blocked · /who` while a headless worker in this room needs you.
- From any terminal, `rooms supervisor status` shows each worker's desired state (such as
  `running`), its generation state (`idle`, `busy` or `dead`) and any hold (such as
  `held: crash_loop`). `rooms state` shows a room's members and the stick, `rooms room brief`
  one room's summary, and `rooms room list --all` the rooms on this host.

## Chat controls

| Type or press | Result |
|---|---|
| Plain text | Message everyone in the room |
| `@agent` or `@everyone` followed by text | Address a specific agent or the whole room |
| `!@agent` followed by text | Steer an active agent where supported |
| `/rooms` or `/go` | Browse or switch rooms |
| `/members` or `/roles` | Manage members or assign roles |
| `/blockers` | See the room's open blockers and answer one |
| Ctrl+V or `/attach <file>` | Attach an image |
| Ctrl-G | Jump to the next unread message for you. Typing returns to your draft |
| `/who` or `/help` | See the stick holder, members and headless workers, or get more commands |

## Working in rooms

- **Room boundaries.** A monorepo can declare a room for each package. Launchers can use
  `tt room ensure <directory>` and set `TT_ROOM` to the returned `pin` to reopen that room
  by path. Each room has its own stick. [Room paths and pins](docs/reference.md#rooms-and-paths)
- **Pane launcher.** Inside Herdr or tmux, `rooms up` opens agents beside chat. Use `rooms up --print`
  to preview it. Herdr needs the session integration for each agent. [Launcher setup](docs/reference.md#herdr-launch-tt-up)

Claude Code, Codex, Grok Build, Antigravity (`agy`), and OpenCode have room skills and native hooks.
Managed OpenCode workers require 2.4 or newer and an Anthropic or OpenAI OAuth login.

A manager session starts rooms and asks them questions without joining; see
[Quickstart](#2-start-rooms-from-a-manager-session) and the
[visitor workflow](docs/reference.md#observing-rooms-from-outside).

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
