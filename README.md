# Talking Stick

Run Claude Code, Codex, and Grok on the same repo without them overwriting each other. One agent
holds the stick at a time, handoffs carry structured context so the next agent doesn't re-derive it,
and `tt chat` gives you one console to talk to all of them.

**[Jump to the quickstart →](#quickstart)**

![The tt chat console: three agents in one room, delivery marks on each message, and agent status in the footer](docs/images/tt-chat.png)

No daemon, no server. Multi-process-safe via SQLite WAL, liveness-aware, and it works with Claude
Code, Codex CLI, Antigravity (`agy`), Grok Build, and OpenCode out of the box.

## Quickstart

Node ≥ 22 required.

### 1. Install

```bash
npm i -g talking-stick
tt install --all
```

`tt install` adds the coordination skill to every harness it finds and skips the ones you don't have.
Restart any harness that was already running so it picks the skill up.

### 2. Set up the panes

Split your terminal like the screenshot above: the agents stacked on the left, the console on the
right. Each pane `cd`s into the same repo — that shared directory is what puts them in one room.

| Left column, one pane per agent | Right column |
|---|---|
| `cd ~/myrepo && claude`<br>`cd ~/myrepo && codex`<br>`cd ~/myrepo && grok` | `cd ~/myrepo && tt chat` |

Two agents is enough to start; add more panes on the left as you want them.

### 3. Point each agent at the skill, and nothing else

Give every agent pane the same one-line prompt:

> `Use the /talking-stick $talking-stick skill.`

That's the whole prompt — no task yet. Each agent joins the room, reports in, and goes idle waiting
for you. You should see them appear in the console as they join.

Prefer a plain prompt over harness goal modes such as `/goal`: their automatic continuation keeps
restarting an agent, which works against `tt standby`.

### 4. Give them the work from the console

Now type the task once, in `tt chat`:

> `Work together to implement OAuth login.`

It reaches every agent in the room, and they coordinate from there. You don't script the turn-taking:
the skill teaches each agent to join, wait, hand off, test, and review.

Driving from the console, rather than typing into each harness, is what keeps the agents in sync —
they all hear the same instruction at the same time, so no one has to relay it. You'll see who holds
the stick in the footer and a delivery mark next to each agent you message.

| You type | What happens |
|---|---|
| `ship it when tests pass` | Goes to the whole room |
| `@codex rebase onto master` | Goes to Codex; `@everyone` addresses every agent that has joined the room |
| `!@claude stop, wrong file` | Steers Claude mid-task, at its next tool step |
| `/who`, `/help` | Members and stick holder; all commands |

Each message header marks every recipient: `…` not delivered yet, `✓` delivered, `!` failed. That's a
delivery receipt, not proof the model acted on it.

## How a session flows

1. **Join.** Each agent runs `tt join` and `tt instructions show`.
2. **Listen.** Each agent keeps one `tt wait --json` running. It returns on anything worth acting on:
   a turn, a message, a join or leave, a handoff.
3. **Take a turn.** When `tt wait` returns `your_turn` with a live `guardian_pid`, that agent may
   edit, build, and test. A background guardian keeps its lease alive. Everyone else stays read-only
   and can still investigate, message, and leave notes.
4. **Hand off.** The holder tests, then runs `tt release` (to the next fair waiter) or
   `tt assign <agent>` (to a specific reviewer). The handoff carries `status`, `next_action`, and
   `artifacts`.
5. **Talk without passing the stick.** `tt msg send` carries questions, review notes, and vetoes
   between turns.
6. **Go idle.** An agent with nothing to do runs `tt standby` and ends its model turn. A directed
   message, assignment, or pending handoff wakes it again.
7. **Finish.** Every participant reviews the result and explicitly agrees. With a console open,
   agents stay in standby instead of leaving, so you can bring them back with a message.

## Waking idle agents

A directed message, or a room message you send from the console, wakes an idle Claude Code or Codex
session natively — no keystrokes typed, no model polling while idle.

| Harness | How it wakes |
|---|---|
| Claude Code | Its inbox socket. A message you send as the operator arrives at the next tool boundary without cancelling the current tool |
| Codex | `codex queue`, delivered after the current turn ends |
| Grok Build | Active-turn hooks while a session is running; an idle session needs a live `tt wait` or cmux |
| Antigravity, OpenCode, Gemini | cmux only |

Claude Code and Codex wakes, and Grok's active-turn hooks, carry the message itself in a compact
envelope, so the agent answers from what it received and acknowledges with `tt ack <token> --json`
instead of fetching again. cmux and anything too large to fit fall back to a body-free notice that
tells the agent to pull with `tt wait`. Details in
[Waking idle agents](docs/reference.md#waking-idle-agents).

## Command overview

```text
tt join / tt leave       join or leave the room for this workspace
tt wait                  long-poll for the turn and room events (--park to never auto-claim)
tt standby               park and wake this session later
tt release / tt pass     hand off with structured status and next action
tt assign <agent>        hand off to someone specific
tt take                  claim when the holder is gone or stuck
tt chat                  operator console
tt msg send / tt notes   message live processes, or leave durable notes
tt state / tt health     room state and a concise safety check
```

Full flags and semantics: [`docs/reference.md`](docs/reference.md#command-reference).

## Installing and updating

| Method | Command |
|---|---|
| From npm | `npm i -g talking-stick` |
| From GitHub (`master`) | `npm i -g github:mostlydev/talking-stick` |
| From source | `git clone … && npm install && npm link` |

```bash
tt install --all --print   # preview every change without touching anything
tt install claude-code codex   # install into a subset
tt self-update             # update using whichever npm/pnpm/yarn you installed with
tt uninstall --all         # remove
```

After updating, restart running harnesses so they load the new skill, and reopen `tt chat` so it uses
the new build.

Installing for Claude Code also adds a Stop-guard hook that blocks a session from stopping once while
it still holds the stick, telling it to hand off first. It is read-only, fails open, and never blocks
twice in a row. Skip it with `tt install claude-code --no-guard` (`--no-guard` needs an explicit
harness or `--all`). Grok Build gets the same guard, and keeps its delivery and session hooks either
way.

## Customizing what agents are told

The bundled skill is the safety floor. Your own collaboration preferences live in editable Markdown
that agents read after joining:

```bash
tt instructions show      # effective prompt for the detected harness
tt instructions edit      # your defaults
tt instructions edit --project   # this repo's overrides
```

Layering is bundled defaults → user overrides → project overrides. Unedited generated files update
automatically; customized ones are preserved. See
[Editable collaboration instructions](docs/reference.md#editable-collaboration-instructions).

## Storage

`~/.local/share/talking-stick/rooms.sqlite` on Linux/macOS (honoring `$XDG_DATA_HOME`),
`%APPDATA%\talking-stick\rooms.sqlite` on Windows. Override with `TALKING_STICK_DATA_DIR`.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`tt` executes `dist/cli.js`, so run `npm run build` after source changes and restart any long-running
harness that cached the old build.

When cutting a release, add entries under `CHANGELOG.md`'s `Unreleased` section, then run
`npm version <new-version>`. The lifecycle script moves those entries into the new version section,
writes `docs/releases/<version>.md`, and adds the GitHub release link before npm commits and tags.

## Read next

- [`docs/reference.md`](docs/reference.md) — full command surface, delivery semantics, identity
  resolution, install behavior, and design notes.
- [`docs/receive-consumer-contract.md`](docs/receive-consumer-contract.md) — cursor ownership,
  subprocess lifecycle, filtering, and authority rules for the unified wait loop.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into
  harness skill directories.
- [`CHANGELOG.md`](CHANGELOG.md) — per-version summary; full notes in [`docs/releases/`](docs/releases/).

## License

MIT. See [LICENSE.md](LICENSE.md).
