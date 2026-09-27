# Talking Stick reference

Full command surface, delivery semantics, identity resolution, and install behavior.
For the introduction and quickstart, see [`README.md`](../README.md).

## Contents

- [Command reference](#command-reference)
- [Out-of-band messaging](#out-of-band-messaging)
- [Waking idle agents](#waking-idle-agents)
- [Native event delivery](#native-event-delivery)
- [Operator chat](#operator-chat)
- [Editable collaboration instructions](#editable-collaboration-instructions)
- [Install behavior per harness](#install-behavior-per-harness)
- [CLI identity](#cli-identity)
- [Design highlights](#design-highlights)
- [Storage](#storage)

## Command reference

```text
tt whoami [--explain]                                     # show the resolved CLI identity
tt list [path]                                            # list rooms
tt join [path] [--force-new]                              # join the room for path
tt leave [path]                                           # leave the room for path
tt wait [path] [--timeout 110s] [--park|--claim] [--after N]  # ownership + events; saved cursor by default
tt standby [path] [--wake cmux|manual]                    # return immediately; wake later on directed action
tt try [path] [--park] [--after N]                        # non-blocking claim/event check
tt state [path] [--all]                                   # compact room state; --all shows older rows
tt health [path] [--verbose|--all]                        # concise safety/action check
tt status [path] [--verbose|--all]                        # alias for health
tt events [path] [--all] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]
tt chat [path] [--history N] [--events] [--fullscreen] [--mouse|--no-mouse]   # operator console
tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--path DIR]
tt msg recv [--wait|--follow] [--from agent] [--after N] [--target self|any|agent] [--path DIR]
tt ack <delivery-token> [--json]                          # acknowledge a native delivery envelope
tt kick <agent_id> [path] [--reason TEXT] [--force]       # remove a member (live ones need --force)
tt instructions show [path] [--harness claude|codex|antigravity|gemini|grok|opencode|all] [--scope effective|bundled|user|project]
tt instructions edit [path] [--user|--project]            # edit user or project prompt
tt instructions update [path] [--user|--project] [--replace]
tt instructions reset [path] (--user|--project)           # delete a user or project prompt
tt release [path] (--status TEXT --next-action TEXT | --stdin)   # normal handoff
tt pass [path] (--status TEXT --next-action TEXT | --stdin)      # pass/end your turn
tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin) [--operator-requested]
tt take [path] [--reason TEXT] [--operator-requested]     # deliberate claim when the holder is gone/stuck
tt takeover [path] [--reason TEXT] [--operator-requested] # alias for take
tt notes add <body> [--turn N] [--path DIR] [--stdin]     # leave an async note
tt notes list [--all] [--after ID] [--limit N] [--path DIR]
tt install <harness...> | --all [--print] [--copy] [--link] [--replace] [--no-guard]
tt uninstall <harness...|agents> | --all | --shared [--print]
tt self-update [--print] [--manager npm|pnpm|yarn|bun]
```

`[path]` defaults to the current working directory. Pass it only when you intentionally
want a different or nested room.

Help flags are always read-only. `--help` and `-h` take precedence over command execution,
even for stateful commands such as `wait`, `release`, `assign`, `notes add`, or `msg send`;
they do not join rooms, claim turns, spawn guardians, write events, or update session state.

`tt self-update` detects how `tt` was installed (npm / pnpm / yarn / bun, including
npm-via-Homebrew/mise/asdf/nvm) and runs the right global-update command. Pass `--print`
to see the inferred command without running it, or `--manager` to override detection.
Running it from a development checkout refuses and tells you to
`git pull && npm install && npm run build` instead.

Human CLI commands use a stable identity like `human:<username>`. When `tt wait`, `tt take`,
or `tt takeover` wins the turn, a small background guardian keeps the lease alive until you
release, pass, or assign it. If that guardian's captured harness process appears gone but the
harness has recent `tt` activity, the lease is retained and keeps heartbeating; a process-gone
and silent owner is surrendered as `harness_gone`. Human CLI `take` works without a required
reason so an operator can step into a stuck room quickly; harness-aware CLI takeovers still
require `--reason` unless the command includes `--operator-requested`.

### Rooms and paths

A workspace maps to a room — usually the `git` root or nearest project marker — so two agents
`cd`'d anywhere under the same repo join the same room automatically. An existing parent room
wins across a nested Git repository or nearer project marker; `--force-new` is the explicit way
to create a nested room. Marker files directly in your home directory are ignored for descendant
paths, so scratch directories under `$HOME` do not collapse into one home-scoped room unless you
join home itself.

On the local host, members whose harness process has definitely ended and whose last `tt`
activity was over an hour ago are removed automatically, except the stick holder and reserved
recipient. Unknown or remote process liveness is preserved. For a stuck holder, follow the
takeover eligibility reported by `tt wait`; a single process-gone observation does not
immediately revoke a live lease.

### Non-owner notes

While you wait your turn you may still need to flag something to the current owner. Non-owner
notes give you a durable channel without interrupting the turn.

- Any joined member can `tt notes add` a short plain-text body (≤ 16 KB). An optional `--turn N`
  scopes the note to a specific turn; omitted, the note is room-scoped and survives transitions.
- `tt notes list` returns notes for the room; readers can paginate with `--after` and see the
  full history with `--all`.
- Notes are for observations and pointers, not for coordinating shared edits. Shared workspace
  changes still require holding the stick.

## Out-of-band messaging

The stick establishes single-writer authority over shared workspace state at the protocol level: it
is an agreement participating agents honor, not a sandbox that prevents writes. It is also **not** a
chat protocol. When two agents need to talk — design questions, "are you about to break X?", live
coordination — use messages instead of churning the stick.

```bash
tt msg send <recipient|room> "<body>" [--interrupt] [--stdin]
tt wait --json
```

- `<recipient>` is a full `agent_id`, an unambiguous active display name (`codex`, `claude`), or
  the literal `room` for broadcast.
- `--interrupt` forces one native submission per message, even with a live listener or an earlier
  unread wake. Claude Code receives the urgent prompt in its active turn at the next tool boundary,
  so a working session is steered without stopping; a single long-running tool call finishes first.
  Codex queues the prompt for after its current turn; its queue CLI can't steer an active turn.
  Results report `interrupt_status: injected` for Claude or `unsupported` for transports that can't
  reach an active turn. Pending urgent deliveries expire after 60 seconds rather than interrupting
  unrelated later work; the room message remains readable. These statuses describe the request, not
  proof that the harness acted on it.
- A sender that crashes mid-delivery can leave that interrupt's status unknown. An idle Claude
  session with a live background `tt wait` may see both the wait exit and the injected prompt for
  one interrupt. `human:*` senders include any CLI caller without a harness identity under the same
  OS user.
- `tt wait` includes ownership and room events by default. It reads and advances `event_cursor_seq`
  in `cli-sessions.json`, so normal agents do not pass `--events` or manage `--after`.
- Joins and leaves are broadcast lifecycle events: an existing `tt wait` wakes when room membership
  changes. The joining or leaving member does not receive its own broadcast through the default
  self view.
- The CLI renews its bounded service wait internally and silently in the same process. Without an
  explicit `--timeout`, silence never makes `tt wait` exit.
- A foreground `tt wait` registers its exact process identity for the life of that command. A second
  live wait for the same room member fails with `duplicate_listener`; a crashed receiver may be
  replaced after exact liveness or heartbeat-grace validation.
- Default command JSON is a thin machine envelope: it omits repeated static reminders and event
  fields already present at the envelope, but adds a short `hint` at join, authority, wait-exit, and
  handoff transitions. It never truncates message or handoff text. Add `--verbose` for the full
  diagnostic representation.
- A tool yield is not a wait timeout. If the harness returns a running process handle, poll that same
  process instead of starting another wait. When the process actually exits, start one successor if
  shared work remains. Do not add short explicit timeouts.
- `tt events --wait`, `tt events --follow`, and `tt msg recv` remain available for human audit and
  debugging. Agents should not run them beside `tt wait` as a second receive loop.
- The wait loop can claim or receive a turn. An event wake by itself grants no authority.
- Solo listening: `tt wait` does not claim an idle room when no other active agent is present. When
  you intend to work alone, use `tt wait --claim --json`. After releasing, resume ordinary
  `tt wait --json`. `--park` and `--claim` are mutually exclusive.
- Membership is rechecked on every turn-wait poll and immediately before a grant, so a kicked,
  superseded, or removed waiter cannot acquire the stick from an already-running command.
- A successful `tt wait` or `tt take` result with `status: "your_turn"` and a live `guardian_pid`
  grants authority to edit shared files.
- Ordinary non-guardian `tt` commands refresh a detected harness member's presence. Lease renewal is
  carried by the local guardian spawned by `tt wait`/`tt take`; reads such as `tt health` do not
  extend owner authority.
- Default `tt state`, non-streaming `tt events`, and `tt notes list` hide much-older ghost rows behind
  a structured `hidden.older_count` summary. Default `tt health` is a concise action card backed by
  the receiver registry; use `tt health --verbose` or `--all` for full diagnostics.

**When to message vs note vs handoff.**

- **Message** — conversational, addressed to whoever is listening now. Messages are recorded in the
  room event log, but they are read in passing rather than tracked to resolution, and they cost no
  stick churn.
- **Note** (`tt notes add`) — durable, resolvable artifacts. Leave a note when the next holder should
  consider something at handoff, or when the observation should outlive the conversation.
- **Handoff** (`tt release` / `tt pass`) — transfer of work. Messages do not replace handoffs.

**`to_agent_id` is routing, not ACL.** A directed or scoped message is filtered out of other agents'
default waits, so addressing someone does narrow who is prompted with it. It does not make the
message private: any room member can read it via `tt events --target any`. Messages also do not grant
the stick — a non-holder paging the holder gets attention, not write authority.

## Waking idle agents

When a directed message, assignment, pass, or pending handoff targets an agent that has no live
`tt wait`, Talking Stick wakes that agent's harness session directly. For Claude Code and Codex, no
keystrokes are typed and no model polls while idle.

| Harness | Transport | Registered from |
| --- | --- | --- |
| Claude Code (v2.1.224+, macOS/Linux) | The session's inbox socket | `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` |
| Codex (tested with 0.154.0) | `codex queue --thread <id>` | `CODEX_THREAD_ID` |
| Any harness in cmux | `cmux send` plus Enter, only for parked standby or an explicit interrupt | `cmux identify` |

Grok Build receives events through active-turn hooks while its session is running, which is not an
idle wake; an idle Grok session still needs a live `tt wait` or a verified cmux wake. Gemini,
OpenCode, and Antigravity wake only through cmux.

- Endpoints register automatically on `tt join`, `tt wait`, and `tt standby`. They're tied to the
  harness session and host, and removed on leave, kick, or session change. The Claude token and
  socket path are stored owner-only and never appear in state, health, events, or errors.
- Native wakes carry complete attributed events in a bounded plain-text envelope. The agent acts on
  the supplied content and records exact-event receipt with `tt ack <delivery-token> --json`, without
  fetching again or acquiring ownership. Oversized payloads and cmux retain the fixed body-free
  `tt wait` notification.
- Claude Code wraps inbox prompts in its own "another Claude session" preamble and permission
  guidance, even when an operator sent the room message. Talking Stick sends only the envelope
  itself; the documented inbox protocol offers no way to suppress that wrapper. The sender returned
  by `tt wait` identifies the actual room author.
- Normal messages wake an agent once per unread batch. More messages join that batch until the
  agent's wait has read past them, the agent acknowledges the batch with `tt ack`, or the agent
  explicitly enters standby again. A new standby rearms
  future wakes without marking messages read; previously submitted wakes are not replayed. Each
  explicit interrupt instead gets its own durable delivery reservation.
- A room message from an operator (a `human:*` sender) reaches every agent that is a member when it
  is sent, standby included, as one event; members who join later do not receive it. A room message
  from an agent wakes nobody, so agents cannot set off loops of replies. An operator's room
  `--interrupt` interrupts every agent; an agent's room `--interrupt` reaches only the current owner.
- Order: a live receiver first, then the native transport, then cmux where eligible. The next
  transport is tried only after a definite failure, such as a missing socket or an unknown Codex
  thread. A timeout or unconfirmed write stops there, so an agent is never woken twice.
- `tt msg send` reports `delivery_status` plus `delivery_transport` and `delivery_state`.
  `delivery_state` is `queued` when the transport submitted the prompt (the socket write flushed, or
  `codex queue` exited 0; Claude may still hold or refuse it per its inbound settings), `ambiguous`
  when a timeout or cut-off write left it unknown, and `failed` when every eligible transport
  definitely failed. A definite failure releases the batch so a later sender can retry. Neither
  harness confirms that a turn started.
- A message coalesced behind an earlier wake reports `delivery_status: pending` without reusing that
  wake's `delivery_state`. This does not imply a new wake was submitted.
- `tt standby` reports `wake_transports`, such as `["claude_inbox"]`, and `can_self_wake`. Its
  `transport` field names only the cmux-or-manual fallback, so `transport: manual` with
  `can_self_wake: true` means native wake is active.
- `tt health` shows a `Wake:` line with the last delivery status and a fixed error code.
- Limits: same machine and OS user only. Claude's `crossSessionInbound: refuse` setting drops the
  prompt silently. A Codex thread that isn't loaded or was interrupted keeps the queued message but
  doesn't start a turn.
- API users: service writes queue wakes, and `TalkingStickCommands.flushWakes()` or
  `sendMessageAndWake()` delivers them asynchronously.

## Native event delivery

Claude Code and Codex native wakes carry complete, attributed room events in a bounded plain-text
envelope: a `[talking-stick] room <path> · ack: tt ack <token> --json` header, one
`#seq sender → you|room` line per event with its content indented two spaces beneath, and a closing
`[/talking-stick]` line. Indented text is always content, so a message body can never forge an event
header or the boundary. The recipient answers from the supplied content and runs
`tt ack <delivery-token> --json` to acknowledge the exact events, without fetching them again or
claiming a turn. Queuing a prompt is not acknowledgement: a refused or unprocessed prompt leaves the
durable message unread. Normal waits remain a recovery path. Acknowledged native events are excluded
from later self waits, while audit and history views retain them.

The token is bound to the receiving member, harness session, and host. Repeated acknowledgement is
safe; events arriving behind a pending normal batch are delivered after its acknowledgement.
Interrupt acknowledgement leaves any unrelated normal batch outstanding. New directed work rearms a
batch unaccepted for five minutes; quiet rooms do not retry on a timer. The room path plus `#seq`
identifies an event for deduplication if an urgent prompt races a running receiver. A handoff
envelope never substitutes for acquiring a lease and live guardian. Oversized envelopes and cmux use
the existing body-free pull notification.

Normal messages from an operator (a `human:*` sender) use Claude inbox priority `next`, delivering at
the next tool boundary without cancelling the current tool. This is operator-only: an ordinary
agent-to-agent message never requests priority steering, so a peer cannot nudge a working session
mid-turn without an explicit `--interrupt`. Grok receives messages through active-turn hooks. Codex
native queue delivery waits until the current turn ends. Normal messages still coalesce into an
unread batch.

## Operator chat

Run `tt chat` in the workspace to talk with agents across harnesses. The conversation uses native
terminal scrollback, with a live room bar, multiline composer, suggestions, and agent status beneath
it. Scrolling, selection, and copying stay with the terminal.

### Input

| Input | Result |
| --- | --- |
| Plain text or `/all <message>` | Broadcast to the room |
| `@agent <message>` or `/to agent <message>` | Send to every matching ID or display-name prefix, ignoring case. Mention several agents anywhere in the text: `@claude @codex, review this`. `@everyone` (or `@all`) addresses every agent in the room. Leading mentions are stripped from the message; an unknown `@name` blocks the whole send; email addresses and `` `code` `` spans are not mentions |
| `/interrupt [@agent] <message>`, `!@agent <message>`, or `!@ <message>` | Steer an agent now. A busy Claude Code session gets the prompt at its next tool step and changes course without stopping; Codex gets it after its current turn. `!@` works anywhere a mention does, and any `!@` makes the whole message an interrupt |
| `/who` | Show members and the current stick holder |
| `/kick [--force] <agent> [reason]` | Remove one exact ID or unique prefix from the room. Live or unconfirmed processes require `--force`; consoles cannot be kicked. Kicking only removes room membership: the harness keeps running, and its next `tt wait` can rejoin it |
| `/events` | Toggle turn and handoff events, hidden by default |
| `/help`, `/help keys` | Show chat commands, or keyboard shortcuts |
| `/older` | Print an earlier page of saved messages; in fullscreen, scroll into older history |
| `/bottom` or Ctrl+End | Fullscreen: return to latest messages. Default mode: use the terminal's scroll-to-bottom shortcut |
| `/quit`, `/exit`, or Ctrl+D on an empty draft | Exit and remove this console's membership |
| Ctrl+C | Clear the draft without quitting |
| Escape | Close the suggestion list; press again to clear the draft |
| `//text` | Send a message beginning with `/` |

### Delivery marks

The header of each message you send names its recipients, each followed by one mark: `…` not
delivered yet, `✓` delivered, `!` delivery failed. A room message lists everyone it went to, as in
`you → claude ✓, codex …, grok ✓`, and appears once no matter how many agents received it. A mark
changes to `✓` when the agent acknowledges the native envelope or its receiver returns your message.
Headers update while still on screen; older saved history shows `✓` where delivery was recorded.
Plain non-terminal output appends one status line per recipient instead. This is a delivery receipt,
not proof the model has acted.

### Display and navigation

Typing `/`, `@`, or `!@` shows suggestions above the room bar. Up/Down choose, Tab or Enter accept,
and Enter sends once the word is complete. Escape
closes the list first and clears the draft on a second press; Ctrl+C clears the draft. Neither quits.
Alt+Enter (or Shift+Enter where supported) adds a new line. With suggestions closed, Up/Down move
through multiline drafts or recall single-line prompt history; Ctrl+P/Ctrl+N also recall prompts.
Pasted multiline text stays in the draft until Enter. The conversation remains in terminal scrollback
after exit.

The room bar above the input panel shows the room path (pinned at the screen top with
`--fullscreen`); long paths are shortened from the left so the workspace name stays visible. The dim
footer below the lower input rule shows each agent's most useful state, without a member count.
`holding 12m` means the agent has had the stick for 12 minutes. The other states are `up next`
(reserved for the next turn), `standby`, `away` (inactive with no confirmation that its process is
still running), `active` (ran a `tt` command within the last minute), and `idle 3m` (time since its
last `tt` command). Agents whose process has ended are left out of the footer; `/who` lists them as
ended, and after an hour the room removes them. The stick holder is listed first. The line refreshes
on room events and every 10 seconds, and is trimmed to the terminal width with a `+N` count for
agents that don't fit.

History is split with Today, Yesterday, and date dividers. Earlier days are dimmed and their
timestamps include the day. When someone joins after four quiet hours, everything before that is
dimmed as an earlier conversation; this is a visual boundary, not a sign that a quiet agent has
exited.

Names use consistent harness colors in the conversation and participant list: Claude is orange,
Codex green, and the operator yellow. Directed messages remain visible to the room; addressing a
member changes the recipient, not privacy. Colors require an interactive terminal and are disabled
when `NO_COLOR` is set to a nonempty value. If an existing console was opened before a local
rebuild, quit and reopen `tt chat` to load the new display.

Resizing the window reflows the live panel in place, rebuilding only the visible tail and keeping
native scrollback. Narrowing a terminal can leave repeated recent lines at the scrollback boundary,
and the redraw replaces any pre-chat shell output still in the visible area.

`tt chat --fullscreen` retains the alternate-screen layout, with a header pinned to the top and an
input/status area pinned below the transcript. In that mode, Page Up/Page Down and Shift+Up/Down
scroll the conversation; Ctrl+End or `/bottom` returns to live messages. Scrolling upward fetches
earlier saved entries. The live buffer retains up to 2,000 blocks; browsing older history can grow it
until returning to the bottom. Mouse capture remains opt-in with `--fullscreen --mouse`, which
enables pointer-based wheel scrolling but may prevent native selection. `--no-mouse` wins over
`--mouse`. Mouse flags have no effect in the default normal-screen mode. Fullscreen exit restores the
previous terminal screen.

`tt chat [path] --history N` initially loads up to N recent conversation entries (default 20, maximum
500); `--history 0` starts without history. Use `/older` for saved entries beyond that initial count.
`--events` also shows turn events at startup.

### The console as a member

Each console uses a separate `human:<username>:chat:<id>` identity. Agents reply to the sender ID
from the received message or a unique display name. Replies addressed to the console ring the
terminal bell. The console is an observer: it cannot acquire the stick, receive a handoff, or make a
lone agent eligible for an automatic claim. A running console does keep its room open: when the last
agent leaves, the conversation stays up so agents can rejoin the same room, and an agent-less room is
deleted once the last console closes. A crashed console never keeps a room alive. Agents that see a
console in the room finish with `tt standby` instead of `tt leave`, so a directed `@agent` message
can wake them. An agent that has left can't receive messages until it rejoins. Opening and closing
the console do not emit agent join/leave wakes. Message text is stripped of terminal escape sequences
before display.

## Editable collaboration instructions

The bundled skill is the safety floor. It is intentionally small and package-managed. Local
collaboration preferences live in editable Markdown files that `tt instructions` shows to agents
after they join.

Instruction delivery is deliberately tiered:

| Surface | When the model sees it | Content |
| --- | --- | --- |
| Installed skill | When Talking Stick is invoked/loaded | Full ownership, wait, recovery, and handoff mechanics |
| `tt instructions show` | Once after joining | Concise working agreement plus the detected harness's default role |
| Compact `tt` result hints | Only at join, authority, wait-exit, and handoff transitions | One short next-step safety reminder |
| Native wakes and delivery hooks | When a message or handoff reaches an idle or working session | The room events themselves, in a bounded envelope, plus the `tt ack` line |
| Claude and Grok Stop guards | Only when a session tries to stop owning the stick | Fixed release/pass warning |
| README and design docs | Only when explicitly opened | Human reference and rationale |

Normal `tt join --json` includes compact current-member summaries and omits the large policy block;
`--verbose` retains the full diagnostic result. This lets an agent discover expected peers without
polling `tt state`.

```bash
tt instructions show                     # effective prompt for the detected harness
tt instructions show --harness codex     # view one harness's effective prompt
tt instructions edit                     # edit user defaults
tt instructions edit --project           # edit this repo's overrides
tt instructions update --user            # auto-refresh generated defaults; preserve custom content
tt instructions update --user --replace  # explicitly replace customized user instructions
tt instructions reset --project          # remove this repo's override
```

Effective instructions are layered in this order: bundled defaults, user overrides at
`${TALKING_STICK_DATA_DIR}/instructions.md` (normally
`~/.local/share/talking-stick/instructions.md`), then project overrides at
`.talking-stick/instructions.md` in the workspace root. Generated, unedited files update
automatically. Customized files are preserved and appear as `update_available` in
`tt instructions show` until explicitly replaced. User and project files are created lazily on first
edit, so installing `tt` does not litter repositories or harness config directories.

## Install behavior per harness

`tt install` installs or refreshes the bundled `talking-stick` skill. Skill directory writes are
delegated to the `skiller` binary when available; package postinstall bootstraps skiller from the
published release and verifies `checksums.txt` before installation. If skiller is missing, disabled,
or fails its version gate, `tt` uses the built-in TypeScript fallback. Set
`TALKING_STICK_DISABLE_SKILLER_BOOTSTRAP=1` to skip the postinstall bootstrap, or
`TALKING_STICK_DISABLE_SKILLER=1` to force the TypeScript fallback.

- Claude Code: copied or linked into `~/.claude/skills/talking-stick`, because Claude Code does not
  read `~/.agents/skills`
- Codex, Antigravity (`agy`), Grok Build, and OpenCode: copied or linked once into the shared
  `~/.agents/skills/talking-stick`
- Grok Build: also installs a trusted global session hook at
  `~/.grok/hooks/talking-stick-session.json`, a stop guard at `~/.grok/hooks/talking-stick-stop.json`,
  and active-turn delivery hooks at `~/.grok/hooks/talking-stick-inbox.json`
- Gemini CLI: deprecated for skill installation; `tt install gemini` prints a deprecation notice and
  runs cleanup only

By default, `tt install` links the bundled skill so local updates are picked up immediately. Pass
`--copy` for a standalone snapshot. `tt install --all --print` shows exactly what would change
without touching anything. During normal execution, install commands skip harnesses that are not
present instead of failing or creating new harness config roots.

Single-harness uninstalls for shared-reading harnesses leave `~/.agents/skills/talking-stick` in
place because Codex, Antigravity, Grok, and OpenCode share that one skill location. Use
`tt uninstall agents` or `tt uninstall --shared` to remove only the shared skill target.

### The Claude Code stop guard

Installing for Claude Code also merges a managed Stop-guard hook into `~/.claude/settings.json`: when
a Claude session tries to stop while it still owns the stick or holds an unclaimed reservation, the
hook blocks the stop once and tells the model to release, pass, or enter standby first. It is
read-only, fails open whenever coordination state is unavailable, never blocks twice in a row, and
touches only its own settings entry. Pass `--no-guard` at install time to skip it;
`tt uninstall claude-code` removes it.

Grok Build's guard at `~/.grok/hooks/talking-stick-stop.json` does the same. Grok loads
`~/.claude/settings.json` hooks too, so the guard ships the byte-identical command and Grok's
identical-handler deduplication collapses the pair into one run. The guard blocks only an ordinary
turn end (`reason: "end_turn"`); a session-end Stop and any subagent stop are observed and never
blocked.

### Skill sync and duplicate cleanup

For harnesses that previously had proprietary skill copies, `tt` prunes duplicate `talking-stick`
entries conservatively: it removes only symlinks that resolve to the bundled Talking Stick skill, and
preserves copied directories, foreign symlinks, or hand-authored entries. OpenCode cleanup checks
both `~/.config/opencode/skills/talking-stick` (honoring `XDG_CONFIG_HOME`) and the older
`~/.opencode/skills/talking-stick` location.

Automatic skill sync records the digest of managed copied skills. A known unedited copy updates
automatically; an unknown or edited copy is preserved and the CLI offers
`tt install <harness> --replace`. Managed symlinks continue to follow the bundled skill directly.

Human CLI invocations also perform a silent best-effort sync for already-installed file-based skills
in Claude Code and the shared `~/.agents/skills/talking-stick` target. If the installed skill is a
copy, it is refreshed from the bundled skill; if it is a stale symlink, it is relinked. Missing skill
installs are skipped.

## CLI identity

By default, `tt` behaves like a human CLI and resolves to `human:<username>` only when no harness
environment is detected. Harness-aware identity is resolved before the human fallback:

- Known harness environment markers such as `CLAUDECODE=1`, `CODEX_THREAD_ID`, `GROK_AGENT=1`,
  `ANTIGRAVITY_AGENT=1`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `GEMINI_CLI=1`,
  `CMUX_AGENT_LAUNCH_KIND=grok`, or `OPENCODE=1` make `tt` derive a harness-style identity
  automatically. Antigravity uses `ANTIGRAVITY_CONVERSATION_ID` as the preferred session anchor,
  falling back to `ANTIGRAVITY_TRAJECTORY_ID` and then `agy` process ancestry. The cmux Grok marker is
  optional; Grok Build also works without cmux by walking process ancestry for a `grok` root process.
- Grok Build's installed hook records hook-only `GROK_SESSION_ID` context into
  `${TALKING_STICK_DATA_DIR}/grok-sessions.jsonl`, letting later Grok-launched `tt` calls upgrade from
  process identity to the real Grok session id. It runs only at `SessionStart`, `UserPromptSubmit`,
  and `SessionEnd`; equivalent observations for one session/process/workspace are idempotent, so
  per-tool activity does not grow the log. `GROK_SESSION_ID` by itself is not treated as a normal
  shell marker, and the hook is not required for basic Grok detection. When `GROK_AGENT=1` (or process
  ancestry) has already established Grok, the exported `GROK_SESSION_ID` is used directly and the
  recorded log is the fallback.
- Set `TT_HARNESS_AGENT_ID=<agent-id>` if the harness wants to export the exact agent id directly.
- Set `TT_HARNESS_EXPORT=1` only when you need ancestry-based harness detection without a known
  harness environment marker.

If no harness signal is present, `tt` stays on the human CLI path. That keeps ordinary shell usage
predictable while preventing harness-launched shells from silently joining rooms as
`human:<username>`. Use `tt whoami --explain` to see which identity path the CLI chose.

Grok Build receives directed room events through `PostToolUse`, `PostToolUseFailure`, and ordinary
`Stop` hooks while its session is active. These hooks deliver complete attributed event envelopes;
`tt ack` records receipt without claiming the turn. Delivery is bounded to 8 KB per envelope and
drains after acknowledgement. Oversized events remain available through `tt wait`; unacknowledged
hook deliveries may retry after one minute at the next hook. Hooks never auto-join a room. Run
`/hooks` to reload an existing Grok session after installation.

## Design highlights

- **Parent-room resolution.** An agent at any depth under `/repo/` joins the `/repo/` room
  automatically, even when the chosen subfolder is a nested Git/project root. The search stops before
  a descendant implicitly inherits a room at `$HOME`; nested rooms require explicit `force_new`.
- **Structured handoffs.** `tt release` and `tt pass` carry a typed `Handoff` with required `status` /
  `next_action` and optional `artifacts[]` pointing at specific files and line ranges.
- **Fair handoff selection.** Normal release prefers a recent waiter that is new or has gone longest
  without holding the stick; if the best-known candidate is between wait polls, a short grace window
  prevents immediate recycling to a less-fair claimant.
- **No immediate take-backs.** If release leaves a handoff idle, the prior owner waits through the
  short grace window before reclaiming while another member exists.
- **Ephemeral rooms.** `tt leave` removes membership, rooms with no active agents or live consoles are
  physically deleted, and long-idle rooms with no recent activity or provably live member process are
  purged opportunistically on later invocations. The default idle retention is seven days.
- **Conservative harness identity upgrades.** A verified `harness:<session>` identity may replace a
  provisional `pid:`, `term:`, or `userhost:` identity only when both belong to the same harness
  process. Distinct verified sessions coexist; one cannot delete another merely because their
  short-lived `tt` subprocesses share a parent harness.
- **Fencing tokens.** `lease_id` + `turn_id` make stale writes to the coordination database
  impossible — an agent that lost its turn cannot record work under the room's name. This fences
  Talking Stick's own state; it does not sandbox the filesystem, so cooperation still depends on
  agents honoring the protocol.
- **Liveness-aware recovery.** Dead or crashed holders are detected with OS-level process checks;
  claim-timeout takeover skips the prior owner when another active member is waiting.
- **Readable default projections.** State, events, notes, and health anchor to the room's newest real
  activity and collapse much-older ghost rows, while `--all` and explicit cursors preserve full audit
  history.
- **Multi-process safe.** Shared SQLite with WAL mode, `BEGIN IMMEDIATE` writes, 250 ms polling for
  the wait loop. No daemon required.
- **Per-call identity derivation.** Harness-launched CLI calls derive identity from harness
  environment or ancestry. Human CLI callers get a stable `human:<username>` identity.

## Storage

### Session lifecycle

`tt install claude codex grok` installs merge-only `SessionStart`/`SessionEnd`
hooks for those harnesses. Review and trust Codex's new hooks in `/hooks`;
reload hooks or restart other harnesses if their settings are cached.
Existing hooks and settings are preserved.

An end event removes only the matching session on the same host and exact
harness process instance, releasing its turn and wake registrations. A saved
retirement marker prevents an old background listener from rejoining; a later
session-start event permits an explicit resume. Concurrent sessions remain
separate even when they share a process. Crashes without hooks still use process
liveness cleanup.

Claude reports the old session ending during `/clear` and `/resume`. Codex
does **not** report an immediate end on `/clear`; cleanup waits for its actual
end hook (normal shutdown, archive/delete, or the documented unopened-idle
timeout). A still-open standby session does not meet that timeout condition.
See [Codex's lifecycle contract](https://learn.chatgpt.com/docs/hooks#sessionend).
Installing hooks cannot reconstruct end events that occurred before installation.

Process retirement markers older than 30 days are reclaimed only when the
exact process is confirmed gone. Room-member markers remain until resume or
room deletion, protecting against metadata-less stale listeners.

### Database location

The coordination database lives at:

- Linux/macOS: `~/.local/share/talking-stick/rooms.sqlite` (or
  `$XDG_DATA_HOME/talking-stick/rooms.sqlite`)
- Windows: `%APPDATA%\talking-stick\rooms.sqlite`

Override with `TALKING_STICK_DATA_DIR` if you want to keep per-project state.
