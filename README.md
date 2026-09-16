# Talking Stick

A CLI coordination tool that lets multiple AI coding agents share a single workspace without stepping on each other. One agent holds the stick at a time; handoffs carry structured context so the next agent doesn't have to re-derive it.

Multi-process-safe (SQLite WAL), liveness-aware, no daemon. Supports Claude Code, Codex CLI, Antigravity CLI (`agy`), Grok Build, and OpenCode out of the box. Gemini CLI identity is retained for existing sessions, but Gemini skill installation is deprecated in favor of Antigravity and the shared agents skill directory.

- **One writer at a time.** Agents take turns holding the stick for shared edits and hand off with a structured summary.
- **One receive loop.** `tt wait --json` delivers turns, messages, and room events from a CLI-managed cursor.
- **Idle agents wake on their own.** A directed message wakes an idle Claude Code or Codex session natively, with no polling while idle.
- **An operator console.** `tt chat` lets you talk to every agent in the room, steer them with interrupts, and watch who holds the stick.

## Quickstart

Four steps, then you're coordinating two agents in the same repo.

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

Then give **both** panes the same prompt, a shared task plus the skill trigger:

> `Work together to implement OAuth login. Use the /talking-stick $talking-stick skill for coordination.`

`/talking-stick $talking-stick` triggers the skill in either harness. Harness goal modes such as `/goal` are optional; their automatic continuation keeps restarting an agent, which works against `tt standby`, so prefer a plain task when you plan to leave agents idle between requests. You don't script the turn-taking — the skill teaches each agent how to join, wait, listen, hand off, test, and review. Coordination is mandatory while the skill applies: agents take turns for shared edits, keep one receive path active whenever the harness can sustain it, carry structured handoffs (status, next action, artifacts, verification) across transitions, and never edit the repo at the same time.

### 4. Watch and steer from the operator console

In a third pane, from the same repo:

```bash
tt chat
```

You'll see the agents' messages as they coordinate, who holds the stick in the footer, and a notice as each of your messages is delivered. Type plain text to talk to the whole room, `@codex …` to address one agent, or `!@claude …` to steer an agent that is busy working. See [Operator chat](#operator-chat).

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

After updating, restart running harnesses so they load the new skill, and quit and reopen any `tt chat` console so it uses the new build.

### Remove

```bash
tt uninstall --all
```

Single-harness uninstalls for shared-reading harnesses leave `~/.agents/skills/talking-stick` in place because Codex, Antigravity, Grok, and OpenCode share that one skill location. Use `tt uninstall agents` or `tt uninstall --shared` to remove only the shared skill target.

## How a session flows

Here's what a typical two-agent session looks like, and what each step means.

1. **Join.** Each agent runs `tt join` and `tt instructions show`. The join result lists who is already there; later arrivals show up as `join` events.
2. **Listen.** Each agent keeps one `tt wait --json` running. It returns when there is something to act on: a turn, a message, a join or leave, or a handoff.
3. **Take a turn.** When `tt wait` returns `your_turn` with a live `guardian_pid`, that agent may edit, build, and test. A small background guardian keeps its lease alive. Everyone else stays read-only and can still investigate, message, and leave notes.
4. **Hand off.** The holder tests, then runs `tt release` (to the next fair waiter) or `tt assign <agent>` (for a specific reviewer). The handoff carries `status`, `next_action`, and `artifacts`, so the next agent picks up where the last one stopped.
5. **Talk without passing the stick.** `tt msg send` carries questions, review notes, and vetoes between turns. Directed messages reach the recipient's `tt wait`, or wake it if it's idle.
6. **Go idle.** An agent with nothing to do runs `tt standby`, ends its model turn, and waits without an active model turn. A directed message, an assignment, or a pending handoff wakes it again ([Waking idle agents](#waking-idle-agents)).
7. **Finish.** When the work is done, every participant reviews the final result and explicitly agrees. With an operator console open, agents stay in standby instead of leaving, so the operator can bring them back with a message.

On the local host, members whose harness process has definitely ended and whose last `tt` activity was over an hour ago are removed automatically, except the stick holder and reserved recipient. Unknown or remote process liveness is preserved. For a stuck holder, follow the takeover eligibility reported by `tt wait`; a single process-gone observation does not immediately revoke a live lease.

## What it gives your agent

Once installed, each agent harness has a skill that tells it to coordinate through the `tt` CLI:

```
tt list            — which rooms exist under a path
tt join            — join the room for this workspace
tt leave           — explicitly leave a room; deletes it when no active agents or live consoles remain
tt wait            — long-poll for ownership and room events; cursor is saved automatically
tt wait --park      — stay coordinated without auto-claiming idle rooms
tt standby          — park, return immediately, and wake this harness session later
tt release         — normal handoff to the next fair waiter, with structured Handoff
tt assign          — explicit handoff to a named agent
tt take            — deliberate claim when the prior holder is gone/stuck
tt kick            — evict a member whose process is gone (or --force)
tt chat            — operator console: talk to agents, steer, and watch the room
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
- `--interrupt` forces one native submission per message, even with a live listener or an earlier unread wake. Claude Code receives the urgent prompt in its active turn at the next tool boundary, so a working session is steered without stopping; a single long-running tool call finishes first. This is the same for human and agent senders, and Claude's inbound controls still apply. Codex queues the prompt for after its current turn; its queue CLI can't steer an active turn. Results report `interrupt_status: injected` for Claude or `unsupported` for transports that can't reach an active turn. Pending urgent deliveries expire after 60 seconds rather than interrupting unrelated later work; the room message remains readable. These statuses describe the request, not proof that the harness acted on it.
- A sender that crashes mid-delivery can leave that interrupt's status unknown. An idle Claude session with a live background `tt wait` may see both the wait exit and the injected prompt for one interrupt. `human:*` senders include any CLI caller without a harness identity under the same OS user.
- `tt wait` includes ownership and room events by default. It reads and advances `event_cursor_seq` in `cli-sessions.json`, so normal agents do not pass `--events` or manage `--after`.
- Joins and leaves are broadcast lifecycle events: an existing `tt wait` wakes when room membership changes. The joining or leaving member does not receive its own broadcast through the default self view.
- The CLI renews its bounded service wait internally and silently in the same process. Without an explicit `--timeout`, silence never makes `tt wait` exit.
- A foreground `tt wait` registers its exact process identity for the life of that command. A second live wait for the same room member fails with `duplicate_listener`; a crashed receiver may be replaced after exact liveness or heartbeat-grace validation.
- Default command JSON is a thin machine envelope: it omits repeated static reminders and event fields already present at the envelope, but adds a short `hint` only at join, authority, wait-exit, and handoff transitions. It never truncates message or handoff text. Add `--verbose` to retain the full diagnostic representation.
- A tool yield is not a wait timeout. If the harness returns a running process handle, poll that same process instead of starting another wait. When the process actually exits, start one successor if shared work remains. Do not add short explicit timeouts.
- `tt events --wait`, `tt events --follow`, and `tt msg recv` remain available for human audit and debugging. Agents should not run them beside `tt wait` as a second receive loop.
- The wait loop can claim or receive a turn. An event wake by itself grants no authority.
- Solo listening: `tt wait` does not claim an idle room when no other active agent is present. When you intend to work alone, use `tt wait --claim --json` to acquire the turn deliberately. After releasing, resume ordinary `tt wait --json` to listen. Assigned turns and multi-agent handoffs work as before. `--park` and `--claim` are mutually exclusive.
- Membership is checked again on every turn-wait poll and immediately before a grant, so a kicked, superseded, or otherwise removed waiter cannot acquire the stick from an already-running command.
- A successful `tt wait` or `tt take` result with `status: "your_turn"` and a live `guardian_pid` grants authority to edit shared files.
- Ordinary non-guardian `tt` commands refresh a detected harness member's presence. Lease renewal is carried by the local guardian spawned by `tt wait`/`tt take`; reads such as `tt health` do not extend owner authority.
- Default `tt state`, non-streaming `tt events`, and `tt notes list` hide much-older ghost rows behind a structured `hidden.older_count` summary. Default `tt health` is a concise action card backed by the receiver registry rather than command-line scanning; use `tt health --verbose` or `--all` for full member and receiver diagnostics.

**When to message vs note vs handoff.**

- **Message** — conversational, ephemeral, between live processes. Six round-trips of "what about line 84?" cost about as much as one structured handoff and zero stick churn.
- **Note** (`tt notes add`) — durable, resolvable artifacts. Leave a note when the next holder should consider something at handoff, or when the observation should outlive the conversation.
- **Handoff** (`tt release` / `tt pass`) — transfer of work. Messages do not replace handoffs; they live alongside them.

### Waking idle agents

When a directed message, assignment, pass, or pending handoff targets an agent that has no live `tt wait`, Talking Stick wakes that agent's harness session directly. For Claude Code and Codex, no keystrokes are typed and no model polls while idle.

| Harness | Transport | Registered from |
| --- | --- | --- |
| Claude Code (v2.1.224+, macOS/Linux) | The session's inbox socket | `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` |
| Codex (tested with 0.154.0) | `codex queue --thread <id>` | `CODEX_THREAD_ID` |
| Any harness in cmux | `cmux send` plus Enter, only for parked standby or an explicit interrupt | `cmux identify` |

- Endpoints register automatically on `tt join`, `tt wait`, and `tt standby`. They're tied to the harness session and host, and removed on leave, kick, or session change. The Claude token and socket path are stored owner-only and never appear in state, health, events, or errors.
- The wake is a fixed prompt, such as ``[talking-stick] New message from codex in /repo. Run `tt wait --json` to read it.`` It never carries the message body. The agent reads the real message, with sender attribution, through `tt wait`.
- Claude Code wraps inbox prompts in its own "another Claude session" preamble and permission guidance, even when an operator sent the room message. Talking Stick sends only the short wake prompt; the documented inbox protocol does not offer a way to suppress that wrapper. The sender returned by `tt wait` identifies the actual room author.
- Normal messages wake an agent once per unread batch. More messages join that batch until the agent's wait has read past them or the agent explicitly enters standby again. A new standby rearms future wakes without marking any messages read; previously submitted wakes are not replayed. Each explicit interrupt instead gets its own durable delivery reservation. Broadcasts never wake anyone; a room `--interrupt` may wake only the current owner. In chat, `!@everyone` explicitly addresses all agents.
- Order: a live receiver first, then the native transport, then cmux where eligible. The next transport is tried only after a definite failure, such as a missing socket or an unknown Codex thread. A timeout or unconfirmed write stops there, so an agent is never woken twice.
- `tt msg send` reports `delivery_status` plus `delivery_transport` and `delivery_state`. `tt chat` shows one dim notice per recipient, such as `claude: queued` or `codex: listening`, and advances it to `→ received` once the recipient's `tt wait` returns the message (delivery to its receiver, not proof a model read it). `delivery_state` is `queued` when the transport submitted the prompt (the socket write flushed, or `codex queue` exited 0; Claude may still hold or refuse it per its inbound settings), `ambiguous` (shown as `wake unconfirmed`) when a timeout or cut-off write left it unknown, and `failed` when every eligible transport definitely failed. A definite failure releases the batch so a later sender can retry. Neither harness confirms that a turn started.
- `tt standby` reports `wake_transports`, such as `["claude_inbox"]`, and `can_self_wake`. Its `transport` field names only the cmux-or-manual fallback, so `transport: manual` with `can_self_wake: true` means native wake is active.
- `tt health` shows a `Wake:` line with the last delivery status and a fixed error code.
- A message coalesced behind an earlier wake reports `delivery_status: pending` without reusing that wake's `delivery_state`. Chat shows `waiting for agent to read`, rather than implying a new wake was queued.
- Limits: same machine and OS user only. Claude's `crossSessionInbound: refuse` setting drops the prompt silently. A Codex thread that isn't loaded or was interrupted keeps the queued message but doesn't start a turn. Grok, Gemini, OpenCode, and Antigravity wake only through cmux for now.
- API users: service writes queue wakes, and `TalkingStickCommands.flushWakes()` or `sendMessageAndWake()` delivers them asynchronously.

**`to_agent_id` is routing, not ACL.** Any room member can read any message via `tt events --target any`. Messages are not private. They also do not grant the stick — a non-holder paging the holder gets attention, not write authority.

## Post-turn closeout

After a handoff, an agent keeps the wait loop alive while work is pending, runs `tt standby --json` when it is only waiting on an external signal, or — when the shared task is genuinely complete — stops and sends a final closeout instead of churning the room. Standby records parked intent, returns immediately, and wakes the agent once for a directed actionable update: natively in Claude Code and Codex, otherwise through the verified cmux surface (see [Waking idle agents](#waking-idle-agents)). Outside cmux, standby falls back to `manual`; a manual standby without a native endpoint cannot self-wake. Final handoffs include the tests, build checks, runtime checks, release checks, dogfood checks, or an explicit reason the task was not testable. The exact completion evidence an agent must see before declaring done lives in the skill ([`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md)).

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
tt wait [path] [--timeout 110s] [--park|--claim] [--after N]  # ownership + events; saved cursor by default
tt standby [path] [--wake cmux|manual]                     # return immediately; wake later on directed action
tt try [path] [--park] [--after N]                        # non-blocking claim/event check
tt state [path] [--all]                                  # compact room state; --all shows older rows
tt health [path] [--verbose|--all]                       # concise safety/action check; verbose shows diagnostics
tt status [path] [--verbose|--all]                       # alias for health
tt events [path] [--all] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]  # audit/debug event log; --wait/--follow lower-level streams
tt chat [path] [--history N] [--events] [--fullscreen] [--mouse|--no-mouse]                   # operator chat console for the room
tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--path DIR]  # send an OOB message
tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent] [--path DIR]  # receive OOB messages
tt kick <agent_id> [path] [--reason TEXT] [--force]      # remove a member (live ones need --force)
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

### Operator chat

Run `tt chat` in the workspace to talk with agents across harnesses. The conversation uses native terminal scrollback, with a live room bar, multiline composer, suggestions, and agent status beneath it. Scrolling, selection, and copying stay with the terminal. `--fullscreen` retains the alternate-screen layout and its application-managed scrolling. Each message has a sender and timestamp above the body, with a blank line separating messages:

```text
codex  12:04
  Rebased onto master. Running the suite now.

claude → you  12:05
  The review is ready.

Room · /path/to/workspace

─────────────────────────────────────────────────────
> @claude please summarize the changes
─────────────────────────────────────────────────────
3 members │ codex holding 12m · claude idle 3m
```

The default chat uses the terminal's normal scrollback. Scroll with the wheel or your terminal's scroll shortcuts; drag-select, double-click selection, and copy remain native. A live panel beneath the conversation shows the room bar, suggestions, multiline input, and agent status. The panel follows new output down to the bottom of the screen; it does not replace the terminal's scrollback or capture the mouse. Use `/older` to print the next page of earlier saved messages, under a clearly marked divider. Use your terminal's scroll-to-bottom shortcut to return to the live panel.

Typing `/`, `@`, or `!@` shows suggestions in reserved rows above the input without moving the conversation. Up/Down choose, Tab or Enter accept, and Enter sends once the word is complete. Escape closes the list first and clears the draft on a second press; Ctrl+C clears the draft. Neither quits. Alt+Enter (or Shift+Enter where supported) adds a new line. With suggestions closed, Up/Down move through multiline drafts or recall single-line prompt history; Ctrl+P/Ctrl+N also recall prompts. Pasted multiline text stays in the draft until Enter. The conversation remains in terminal scrollback after exit.

Resizing the window reflows the live panel in place. Shrinking both width and height at once (for example 80x24 to 20x8) can leave one copy of the old panel in the scrollback above the live one; it scrolls away and does not affect the conversation or your draft.

`tt chat --fullscreen` retains the alternate-screen layout, with a header pinned to the top and an input/status area pinned below the transcript. In that mode, Page Up/Page Down and Shift+Up/Down scroll the conversation; Ctrl+End or `/bottom` returns to live messages. Scrolling upward fetches earlier saved entries. The live buffer retains up to 2,000 blocks; browsing older history can grow it until returning to the bottom. Mouse capture remains opt-in with `--fullscreen --mouse`, which enables pointer-based wheel scrolling but may prevent native selection. `--no-mouse` wins over `--mouse`. Mouse flags have no effect in the default normal-screen mode. Fullscreen exit restores the previous terminal screen.

History is split with Today, Yesterday, and date dividers. Earlier days are dimmed and their timestamps include the day. When someone joins after four quiet hours, everything before that is dimmed as an earlier conversation; this is a visual boundary, not a sign that a quiet agent has exited.

After you send a directed message, a dim notice shows how it was delivered, for example `codex: listening`, `claude: queued`, or `codex: waiting for agent to read`. A subsequent `received` notice appears once the agent's `tt wait` returns your message.

The room bar above the input panel shows the room path (pinned at the screen top with `--fullscreen`); long paths are shortened from the left so the workspace name stays visible. The dim footer below the lower input rule shows each agent's most useful state, without a member count. `holding 12m` means the agent has had the stick for 12 minutes. The other states are `up next` (reserved for the next turn), `standby`, `away` (inactive with no confirmation that its process is still running), `active` (ran a `tt` command within the last minute), and `idle 3m` (time since its last `tt` command, including a live agent that is just quiet). Agents whose process has ended are left out of the footer; `/who` lists them as ended, and after an hour the room removes them. The stick holder is listed first. The line refreshes on room events and every 10 seconds, and it is trimmed to the terminal width with a `+N` count for agents that don't fit.

Names use consistent harness colors in the conversation and participant list: Claude is orange, Codex green, and the operator yellow. Directed messages remain visible to the room; addressing a member changes the recipient, not privacy. Colors require an interactive terminal and are disabled when `NO_COLOR` is set to a nonempty value. If an existing console was opened before a local rebuild, quit and reopen `tt chat` to load the new display.

| Input | Result |
| --- | --- |
| Plain text or `/all <message>` | Broadcast to the room |
| `@agent <message>` or `/to agent <message>` | Send to every matching ID or display-name prefix, ignoring case. Mention several agents anywhere in the text: `@claude @codex, review this` or `hey @codex and @claude, check this`. `@everyone` (or `@all`) addresses every agent in the room. Leading mentions are stripped from the message; an unknown `@name` blocks the whole send; email addresses and `` `code` `` spans are not mentions |
| `/who` | Show members and the current stick holder |
| `/kick [--force] <agent> [reason]` | Remove one exact ID or unique prefix from the room. Suggestions show full IDs and status, with ended agents first. Live or unconfirmed processes require `--force`; consoles cannot be kicked. Kicking only removes room membership: the harness keeps running, and its next `tt wait` can rejoin it |
| `/events` | Toggle turn and handoff events, hidden by default |
| `/interrupt [@agent] <message>`, `!@agent <message>`, or `!@ <message>` | Steer an agent now. A busy Claude Code session gets the prompt at its next tool step and changes course without stopping; Codex gets it after its current turn. `!@` works anywhere a mention does, and any `!@` makes the whole message an interrupt |
| `/help`, `/help keys` | Show chat commands, or keyboard shortcuts |
| `/quit`, `/exit`, or Ctrl+D on an empty draft | Exit and remove this console's membership |
| Ctrl+C | Clear the draft without quitting |
| Escape | Close the suggestion list; press again to clear the draft |
| `/older` | Print an earlier page of saved messages; in fullscreen, scroll into older history |
| `/bottom` or Ctrl+End | Fullscreen: return to latest messages. Default mode: use the terminal’s scroll-to-bottom shortcut |
| `//text` | Send a message beginning with `/` |

`tt chat [path] --history N` initially loads up to N recent conversation entries (default 20, maximum 500); `--history 0` starts without history. Use `/older` for saved entries beyond that initial count. In fullscreen mode, scrolling upward also fetches older saved entries. `--events` also shows turn events at startup. Agents must keep their normal `tt wait` receive process active to respond live. Broadcasts do not wake anyone; a directed message wakes an idle Claude Code or Codex session (see [Waking idle agents](#waking-idle-agents)). A message being stored in the room is not an acknowledgement that an agent has read it.

Each console uses a separate `human:<username>:chat:<id>` identity. Agents reply to the sender ID from the received message or a unique display name. Replies addressed to the console ring the terminal bell. The console is an observer: it cannot acquire the stick, receive a handoff, or make a lone agent eligible for an automatic claim. A running console does keep its room open: when the last agent leaves, the conversation stays up so agents can rejoin the same room, and an agent-less room is deleted once the last console closes. A crashed console (its process is gone) never keeps a room alive. Agents that see a console in the room finish with `tt standby` instead of `tt leave`, so a directed `@agent` message can wake them (natively in Claude Code and Codex, see [Waking idle agents](#waking-idle-agents)). An agent that has left can't receive messages until it rejoins. Opening and closing the console do not emit agent join/leave wakes. Message text is stripped of terminal escape sequences before display.

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
- **Ephemeral rooms.** `tt leave` removes membership, rooms with no active agents or live consoles are physically deleted, and long-idle rooms with no recent activity or provably live member process are purged opportunistically on later invocations. The default idle retention is seven days.
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
