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
tt --version                                              # print the installed version
tt whoami [--explain]                                     # show the resolved CLI identity
tt list [path]                                            # rooms whose scope covers the path, most specific first
tt roles [show] | set <agent|harness> <roles|none|clear> | default <harness> <roles|none|clear> [--in ROOM]
tt room create [path] [--name NAME]                       # declare a room boundary (.talking-stick/room.toml)
tt room list [path]                                       # this repository's rooms, live agents in each, current marked
tt room list --all                                        # every room on this host with live members, most recent room activity first
tt room brief [room] [--limit N]                          # what a room is doing: holder, members, last handoff, notes, recent messages
tt room ask <room> --to <agents|room> [--stdin] [--request-key KEY]  # ask a room's agents a question without joining
tt room replies <request-id> [--after SEQ] [--limit N] [--timeout S] # read the answers, waiting up to 60s
tt msg reply <request-id> [--stdin]                       # answer a visitor's question (members of its room only)
tt room adopt [path] [--name NAME]                        # declare an existing nested room, keeping its id
tt room remove [path]                                     # remove a declaration and delete its agent-free room
tt join [path] [--in ROOM] [--force-new]                  # join the room for path (--force-new is deprecated)
tt leave [path]                                           # leave the room for path
tt wait [path] [--timeout 110s] [--park|--claim] [--after N]  # ownership + events; saved cursor by default
tt standby [path] [--wake cmux|manual]                    # return immediately; wake later on directed action
tt try [path] [--park] [--after N]                        # non-blocking claim/event check
tt state [path] [--all]                                   # compact room state; --all shows older rows
tt health [path] [--verbose|--all]                        # concise safety/action check
tt status [path] [--verbose|--all]                        # alias for health
tt events [path] [--all] [--after N] [--limit N] [--wait|--follow] [--event TYPE[,TYPE]] [--target self|any|agent]
tt chat [path] [--history N] [--events] [--fullscreen] [--mouse|--no-mouse]   # operator console
tt up [--agents claude,codex,grok,opencode,antigravity] [--path DIR] [--in ROOM] [--new-tab|--new-workspace] [--print] [--forget] [--timeout 120s] # experimental Herdr/tmux launcher
tt msg send <recipient|room> <body...> [--interrupt] [--stdin] [--attach IMAGE]... [--path DIR]
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
tt install <harness...|herdr> | --all [--print] [--copy] [--link] [--replace] [--no-guard]
tt uninstall <harness...|agents|herdr> | --all | --shared [--print]
tt self-update [--print] [--manager npm|pnpm|yarn|bun]
```

`[path]` defaults to the current working directory. Pass it only when you intentionally
want a different room.

`--in ROOM` (or the `TT_ROOM` environment variable) names a room explicitly for `join`,
`wait`, `try`, `standby`, `take`, `chat`, `state`, `health`, `events`, `msg`, `notes`,
`release`, `pass`, and `assign`. `ROOM` is a room id, an absolute room path, `root`
(the repository's root room), a short name (`api` or `#api`), or a path suffix
(`web/api`). Exactly one open room must match; `--in` never creates a room. `tt chat #api`
is shorthand for `tt chat --in api` (quote `#api` in shells where `#` starts a comment).

Help flags are always read-only. `--help` and `-h` take precedence over command execution,
even for stateful commands such as `wait`, `release`, `assign`, `notes add`, or `msg send`;
they do not join rooms, claim turns, spawn guardians, write events, or update session state.

Installer-managed standalone releases check for newer stable versions at most every 24–30 hours at human,
interactive startup (for example `tt chat`), install under a per-install lock, then ask you to restart
before the command opens the database. Agent RPCs, hooks, JSON/redirected output, `--print`, and
development checkouts never auto-install. `TT_NO_AUTO_UPDATE=1` disables automatic checks.
The version check runs through `curl` with a five-second network deadline; installing a newer release then
takes as long as its download. Failures go to stderr and leave the command usable.
Previous release directories remain available for running processes. Explicit and automatic updates
share the same lock. Automatic installs keep any npm copy without prompting.


Running chats show an unobtrusive footer notice when a newer release is available, or
“installed · restart chat” only when the active install on disk is newer than the running
process. Live chats never install updates. Startup and chats share a cache under the data
directory and a cross-process lock. The public CDN checksum manifest is checked at most
once every 24 hours plus up to 6 hours of jitter, including failed attempts; no GitHub API
polling is added. Local footer refreshes do not imply network requests. Scroll/completion
hints outrank the notice. The notice yields to the room: it shows in full only while the
member status keeps at least 40 cells, in its short form while it keeps 32, and otherwise not
at all. The status keeps the stick holder and compresses other members to `+N`. Copies that no
installer manages (Windows and hand-extracted archives) say `available · download from GitHub`
instead, never `installed`; download the next archive from
<https://github.com/mostlydev/talking-stick/releases>. Development checkouts linked with
`npm link` show no notice. `TT_NO_AUTO_UPDATE=1` also disables the running-chat check.

`tt self-update` on the standalone binary reruns the installer bundled with the current release,
keeping the `--install-dir` and `--bin-dir` it was installed with (recorded in
`<install-dir>/install-receipt`). For an npm-family install it explains the move to the standalone
binary, then detects how `tt` was installed (npm / pnpm / yarn / bun, including
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

### Herdr launch (`tt up`)

Experimental. In Herdr, `tt up` defaults to installed Claude, Codex, and Antigravity launchers
whose executable and Talking Stick skill are both present. The invoking pane becomes chat; agent
panes split to its right with equal shares of the side column. Grok and OpenCode launchers
require an explicit `--agents` list. `--print` previews the selected agents and any installed
experimental launchers; `--new-tab` or `--new-workspace` opens a separate tab or workspace.

- Each agent receives the skill bootstrap prompt, and its join to the exact room is verified.
  `--timeout 120s` bounds that join observation in addition to each startup timeout.
- Panes start in the directory you launch from and are pinned to one room (`TT_ROOM`, and
  `tt chat --in` for the console): the room an ordinary `tt join` there selects, or the one named
  with `--in`. A room that does not exist yet is created only after preflight passes.
  Reusing a pane whose inherited `TT_ROOM` points to a closed or deleted room falls back to
  the launch directory. An explicit `--in`, an ambiguous room name or a storage failure
  still stops the launch.
- Progress, including the created tab or workspace and the join wait, goes to stderr; JSON results
  stay on stdout. `--json`, redirected terminals, and harness tool calls report chat as ready and
  print a `tt chat --in` step instead of attaching chat. Current-tab splits keep focus; a requested
  new tab or workspace is shown after startup.
- Reruns are idempotent. Repeated launches in the current pane reopen chat there without
  duplicating confirmed agent panes. A new tab or workspace gets its own console, reusing a
  recorded one only after verifying its pane. If agents exist but their layout lacks a console,
  the command asks for inspection instead of creating a console-only tab. Verified members are
  reused; uncertain launches require inspection and are never blindly retried.
- After checking old panes and confirming exited agents, `--forget` discards this command's
  launch record without closing panes; `--print --forget` previews that fresh plan.
- Codex starts with `--no-daemon` so its tools and hooks keep the new pane's process identity for
  join verification. Escape in chat interrupts an active Codex turn in that pane through Herdr after
  matching its session and process. Grok stays unconfirmed when Herdr omits its session identity.
- Plain tmux works too: outside Herdr, `tt up` run in a tmux pane drives tmux instead. A Herdr
  workspace becomes a tmux session and a tab becomes a window; `--print` shows the same steps.
  Agents are started by typing their command line into a fresh pane, which tt labels with the
  `@tt_agent` pane option. tmux cannot detect agents, so a join is verified by the member's harness
  process (and its start time) being a foreground process of that pane's terminal. tmux has no
  busy/idle signal, so Escape in chat goes to a verified Codex pane without checking whether a turn
  is active. Showing a new session needs an attached client; otherwise select it yourself
  (`tmux switch-client -t <session>`). Requires tmux 3.1 or later.

### Rooms and paths

A workspace maps to a room, so two agents `cd`'d anywhere under the same repository join the
same room automatically. Resolution, first match wins:

1. `--in ROOM` or `TT_ROOM`.
2. An older nested room created with `--force-new` between your directory and the nearest
   declaration (or the checkout root), nearest first. Existing rooms keep their members and
   lease; `tt room adopt` turns one into a declared room without changing its id.
3. A declared room: the nearest directory, up to the checkout root, that contains
   `.talking-stick/room.toml`. Create one with `tt room create packages/api [--name api]`
   and commit the file so every checkout shares the layout. In a monorepo each declared
   package is its own room; undeclared directories use the repository's root room.
4. The repository's root room.

Inside Git a repository is its own root: a room above the checkout (for example at `~/dev`)
no longer absorbs it. Linked worktrees share the main checkout's rooms: a declared room is
keyed by the main checkout path plus its path inside the checkout, so
`<worktree>/packages/api` and `<main>/packages/api` are one room. A worktree whose branch
lacks the declaration uses the root room. Outside Git, a folder still joins the nearest
existing room above it, or the nearest project marker. Marker files directly in your home
directory are ignored for descendant paths, so scratch directories under `$HOME` do not
collapse into one home-scoped room unless you join home itself.

An agent is a member of one room per repository. Joining another room in the same repository
(child, parent, or sibling) moves it there: it leaves the others with a `leave` event
(`reason: "moved to <path>"`), and the join result warns `Left …`. The move is refused with
`holds_turn_elsewhere` while the agent holds or is next for the turn in a room it would leave;
release there first. Chat consoles are observers and are never moved.

`room.toml` accepts only `name = "..."` today. Any other content, including the reserved
`channels` and `default_channel` keys, still declares the room, and joins report it. A custom `name` is found by `--in` when the keyed path exists in the main
checkout; for a package that exists only on a linked worktree's branch, use its directory name,
a path suffix, or the room id. `tt room remove` refuses while agents are in the room. Otherwise
it deletes the room with its events and notes, as when the last agent leaves a room, detaching
any chat console, and later joins resolve to the parent room.

On the local host, members whose harness process has definitely ended and whose last `tt`
activity was over an hour ago are removed automatically, except the stick holder and reserved
recipient. Unknown or remote process liveness is preserved. For a stuck holder, follow the
takeover eligibility reported by `tt wait`; a single process-gone observation does not
immediately revoke a live lease.

### Observing rooms from outside

For a session whose whole job is watching rooms, such as a Claude Code or Codex session started
in your home folder, use the `talking-stick-rooms` skill: it never joins a room, and it teaches the
session to find a room, summarize it, and ask its agents.

Any agent or person on the host can see what each room is doing without joining it.
`tt room list --all` lists every room with a live agent or console, most recent room activity
first. Room activity includes lease renewals, so it means the room is in use, not that its
conversation moved. `tt room brief <room>` then shows one room: the stick holder (marked stale
once the lease has expired) or the reservation, members with their kind and whether each is
live, inactive, or gone, the latest handoff in full, the newest ten open notes with the real open
count, and the last 20 messages and handoffs. `--limit N` (up to 200) changes how many recent
events to show. Message bodies are cut at 1,000 characters and handoffs at 160; each clipped
event carries a `full` command that reads it whole. `older` pages back with `--before <seq>`, and
`updates_since` reads everything after the brief's cursor. A visitor's question carries its
`request_id`, and an answer carries `in_reply_to`; an answer goes to the visitor, so its `to` is
null like a room message. Name the room by short name, id, or
path suffix from any folder; a directory needs explicit path syntax (`.`, `./dir`, `../dir`, or an
absolute path), so a local folder never shadows a room name. Neither command joins a room or
refreshes anyone's presence.

A visitor can also ask a room's agents a question. `tt room ask <room> --to <agent|room>` takes
the question as arguments or with `--stdin`. `--to` names agents by id, or by harness name when
exactly one agent matches; `room` sends it to every live agent in the room (not gone, and either
running or recently present). A member asking its own room this way keeps its presence unchanged.
The recipients are fixed when the question is asked and are woken like any directed message.
Their envelope header reads `visitor <id>` and ends with the reply command. The visitor never
becomes a member, never holds the stick, and doesn't keep the room open. A member answers with
`tt msg reply <request-id>`; answers are room messages that wake nobody in the room. The visitor
reads them with `tt room replies <request-id>`, oldest first, 20 at a time (`--limit` up to 200),
with `recipient_status` reporting, per recipient, whether it is still in the room, the wake attempt
that dispatched this request (`delivery`, null once a later attempt replaced it), when its `tt`
received the request (`received_at`, null when no receipt is on record), and whether it replied:
separate facts, none proof of the next. Continue with `--after <cursor_event_seq>`. `--timeout`
(up to 60 seconds, as `30`, `30s`, or `500ms`) waits for a first answer. An empty result with `timed_out: true` means no answer yet; a
wait stopped by Ctrl-C reports `interrupted: true` and exits 130. `--request-key KEY` makes a
retry return the original request instead of asking twice, even after its recipients leave, and
a different question under the same key is refused. Questions and answers are kept as long as
their room: when the room closes, they are deleted with it, and later reads report
`request_not_found`.

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
tt msg send <recipient|room> "<body>" [--interrupt] [--stdin] [--attach IMAGE]...
tt wait --json
```

- `<recipient>` is a full `agent_id`, an unambiguous active display name (`codex`, `claude`), or
  the literal `room` for broadcast.
- `--interrupt` forces one native submission per message, even with a live listener or an earlier
  unread wake. Claude Code receives the urgent prompt in its active turn at the next tool boundary,
  so a working session is steered without stopping; a single long-running tool call finishes first.
  Codex uses native `turn/steer` for the exact active daemon-backed turn, with queue fallback
  only when no steer was accepted.
  Results report `interrupt_status: injected` for Claude or accepted Codex steering, and `unsupported` for transports that can't
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
- To watch a room live, run `tt events --follow --target any --json`. It starts at the current head,
  so nothing older is replayed, and prints one JSON event per line on stdout until interrupted. The
  last cursor goes to stderr as `cursor_event_seq=N` when you stop it. Pass `--after N` to catch up
  from a known sequence instead. `tt state --json` reports the room head as `cursor_event_seq`.
  While streaming, the default `--target self` shows only events routed to you and marks the
  messages it prints as delivered to you; `--target any` is a whole-room audit that changes nothing.
  Without `--follow` or `--wait`, `tt events` is a one-shot audit of the whole room. It hides
  much-older rows by default (`--all`, `--after` or `--limit` include them), and `--limit` keeps the
  oldest events after `--after`.
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
| Codex (CLI 0.163.0, daemon 0.164.0 live-tested) | `turn/steer` for operator and urgent input to the exact active turn; `codex queue --thread <id>` when idle or steering is definitely unavailable. Other peer events use trusted Stop hooks | `CODEX_THREAD_ID` |
| Any harness in cmux | `cmux send` plus Enter, only for parked standby or an explicit interrupt | `cmux identify` |

Grok Build receives events through active-turn hooks while its session is running, which is not an
idle wake; an idle Grok session still needs a live `tt wait` or a verified cmux wake. Gemini,
OpenCode, and Antigravity wake only through cmux.

- Endpoints register automatically on `tt join`, `tt wait`, and `tt standby`. They're tied to the
  harness session and host, and removed on leave, kick, or session change. The Claude token and
  socket path are stored owner-only and never appear in state, health, events, or errors.
- Native wakes carry complete attributed events in a bounded plain-text envelope. The agent acts on
  the supplied content and records exact-event receipt with `tt ack <delivery-token>`, without
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
  `codex queue` exited 0; Claude may still hold or refuse it per its inbound settings), `woken`
  when Codex accepted a queued submission as a new turn, `steered` when its active turn accepted input, `ambiguous`
  when a timeout or cut-off write left it unknown, and `failed` when every eligible transport
  definitely failed. A definite failure releases the batch so a later sender can retry. When a
  failure is this sender's own (a socket connect it was denied, or a `codex` it could not launch),
  the work stays pending, so the next `tt` command on this host, from any process, retries it
  without another message; the failing process never repeats the same attempt. An open `tt chat`
  delivers its room's pending wakes whenever a new event arrives, and at least once a minute, so a
  question sent from a desktop app that may not open the agents' sockets reaches them within
  a minute while a console is open, usually within seconds.
  Claude does not confirm that a turn started; a Codex `woken` result confirms turn creation,
  not that the agent read or acted on the message.
- A message coalesced behind an earlier wake reports `delivery_status: pending` without reusing that
  wake's `delivery_state`. This does not imply a new wake was submitted.
- `tt standby` reports `wake_transports`, such as `["claude_inbox"]`, and `can_self_wake`. Its
  `transport` field names only the cmux-or-manual fallback, so `transport: manual` with
  `can_self_wake: true` means a native wake route is registered and has not been ruled out by a
  definite missing-thread failure. A Codex endpoint whose latest attempt returned
  `codex_thread_not_found` is omitted until the endpoint changes or delivery succeeds; use one
  `tt wait --park --json` while `can_self_wake` is false. Sender-local permission failures do not
  disable the route, because another process on the host may deliver it.
- `tt health` shows a `Wake:` line with the last delivery status and a fixed error code.
  `last_error_detail` and `delivery_error_detail` add where it failed and the system's code, such as
  `connect:EPERM`, `write:EPIPE`, `spawn:ENOENT`, or `exit:1 rpc:-32603`; only known codes are
  shown, never transport output or message text.
- Limits: same machine and OS user only. Claude's `crossSessionInbound: refuse` setting drops the
  prompt silently. Codex needs a live local harness process for the app-server start attempt;
  unavailable or unloaded threads keep the queued message. The start call is an experimental
  Codex 0.157.1 API, so unsupported versions retain queue-only behavior.
- API users: service writes queue wakes, and `TalkingStickCommands.flushWakes()` or
  `sendMessageAndWake()` delivers them asynchronously.

An accepted steer is not a hard stop and is not proof that the agent acted. Explicit message-free
cancellation uses `turn/interrupt`; the daemon helper reports success only after the exact turn's
read-only turn listing (or a matching completion notification) says `interrupted`. An idle native
result never falls through to pane Escape; a pane-key fallback only confirms key delivery.
Native steering never resumes an unloaded thread or changes its model/settings. A disconnect or
unknown error after sending is `ambiguous`: the same batch stays held, including across old
chat processes' retry paths. While that exact target turn is active or unknown, it is not
blindly queued again after five minutes. Once its matching Stop hook runs, or read-only daemon
inspection proves that target ended, unread input can be recovered with the original token and
event numbers. This is at-least-once delivery: deduplicate work by room and event number, and
acknowledging either copy consumes both. Inspection is bounded and locally limited to once per
30 seconds per batch. There is no background watchdog: without Codex hooks, inspection runs
only when a later room write or flush happens. Recovery replays at most once. If the recovery
send is itself ambiguous, or the process dies while recovering, the batch stays held until the
agent reads or acknowledges it, or its session is replaced. A sender that dies mid-steer leaves
the batch reserved. If it had captured a target turn, recovery treats it as uncertain 30
seconds later. If it had not, no input was sent, and normal delivery retries after five minutes.
A cancellation readback that does not list the target keeps polling until the helper's
timeout; a missing row is not evidence that the turn stopped. Standby alone does not release
the hold or replay its input. An explicit urgent message
remains an independent route while a hold is outstanding. Later ordinary input coalesces until receipt; a new explicit urgent
message has an independent delivery reservation. `--no-daemon`, remote and desktop sessions
require a reachable matching control endpoint; queue fallback remains available when nothing
was sent. Steering latency during arbitrary long-running tools has not been established by
the same-turn marker probe.

## Native event delivery

`tt install codex` also installs turn hooks; review and trust the new entries in Codex `/hooks`.
Once a session's `UserPromptSubmit` hook has run, ordinary peer events stay in the unread store
while Codex is active. Operator messages and urgent prompts instead attempt native steering
against the daemon's live turn ID, independent of the activity-hook TTL. Their receipt batch is
reserved before sending, so Stop cannot race the initial attempt. An uncertain attempt may
be recovered at the matching target's Stop boundary with that original token. At `Stop`, the hook continues the turn with only events still unread and
unreserved; events already returned by `tt wait` do not produce stale queued prompts. A live
background wait is not model-awareness evidence: operator input still attempts same-turn
steering while that receiver is present. Queue fallback is suppressed when a live receiver or
trusted active Stop hook already owns delivery. A high-water
mark prevents repeated continuations for an unacknowledged envelope. `Interrupt` clears active
state. Hooks never join rooms, claim the stick, create a database, or migrate it.

Without trusted hooks, native queue delivery works as before. The session's own CLI calls refresh
active evidence; guardian heartbeats and other members' observations do not. Evidence expires after
five minutes without a hook or session command: a later dispatch can use the queue if a hook failed
or the session stopped reporting. A long tool call without CLI activity can still receive a queued
envelope. Unacknowledged Stop reservations also expire after five minutes; if a continuation was lost,
a later dispatch can retry those events. The hooks run at turn boundaries rather than on every tool
call. Explicit urgent delivery keeps its existing behavior. These hooks reduce duplicate delivery; they cannot retract a prompt that
was already submitted to Codex. Existing chats and harnesses need a restart after updating.

Claude Code and Codex native wakes carry complete, attributed room events in a bounded plain-text
envelope: a `[talking-stick] room <path> · ack: tt ack <token>` header, one
`#seq sender → you|room` line per event with its content indented two spaces beneath, and a closing
`[/talking-stick]` line. Indented text is always content, so a message body can never forge an event
header or the boundary. The recipient answers from the supplied content and runs
`tt ack <delivery-token>` to acknowledge the exact events, without fetching them again or
claiming a turn. Queuing a prompt is not acknowledgement: a refused or unprocessed prompt leaves the
durable message unread. Normal waits remain a recovery path. Acknowledged native events are excluded
from later self waits, while audit and history views retain them.

The token is bound to the receiving member, harness session, and host. Repeated acknowledgement is
safe; events arriving behind a pending normal batch are delivered after its acknowledgement.
Interrupt acknowledgement leaves any unrelated normal batch outstanding. New directed work rearms a
batch unaccepted for five minutes. A batch whose delivery was never confirmed (`ambiguous`, or its
sender died first) is also retried after five minutes by the next `tt` command on the host, if its
events are still unread; a delivered batch keeps waiting for the agent. Nothing retries on its own:
retries happen only when a `tt` command runs, and an open `tt chat` checks pending wakes at most
once a minute. The room path plus `#seq`
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
| `/interrupt [@agent] <message>`, `!@agent <message>`, or `!@ <message>` | Steer an agent now. A busy Claude Code session gets the prompt at its next tool step and changes course without stopping; Codex steers its active daemon-backed turn, or queues when steering is definitely unavailable. `!@` works anywhere a mention does, and any `!@` makes the whole message an interrupt |
| `/who` | Show members and the current stick holder |
| `/members` | Choose an exact member with ↑↓ and Enter, then message or remove it. Removal requires confirmation and does not stop the harness |
| `/kick [--force] <agent> [reason]` | Remove one exact ID or unique prefix from the room. Live or unconfirmed processes require `--force`; consoles cannot be kicked. Kicking only removes room membership: the harness keeps running, and its next `tt wait` can rejoin it |
| `/events` | Toggle turn and handoff events, hidden by default |
| `/help`, `/help keys` | Show chat commands, or keyboard shortcuts |
| `/older` | Print an earlier page of saved messages; in fullscreen, scroll into older history |
| `/clear` | Clear the pane and remember a resume marker for this human in this room |
| Ctrl+V, `/attach <file>` | Attach an image: Ctrl+V reads the clipboard (macOS `osascript`; Linux `wl-paste` or `xclip`), and a pasted or dragged-in image path does the same. The draft shows `[Image #N]`; delete the marker to drop the image. See [Images](#images) |
| `/roles` | Edit roles: arrows select, Space toggles, Tab switches room assignments / harness defaults, Enter applies, Esc closes (confirms a draft). `e` edits a role, `n` adds one, `i` edits project instructions, `p` previews, `v` lists notifications, `?` shows all keys. `/roles set <agent|harness> <roles|none|clear>` and `/roles default <harness> <roles|none|clear>` work as text |
| `/rooms [room]`, Ctrl+T | Open Folders, or open an exact room ID/name/path. Tab switches to the active room-only tree: `/` filters, `s` sorts, `a` toggles Active / All open. See [Room navigator](#room-navigator). Without a terminal, prints active host rooms |
| `/go` (↑↓ choose, Enter open; Tab fills) or Alt+←/→ | Switch to another open room, including one with no agents; Ctrl+PgUp/PgDn is a fallback when the terminal captures Alt+Arrow. Drafts and memberships are kept until chat exits. `/go <dir>` (relative to the active repository's checkout) opens a directory's room even if nobody has joined it yet, e.g. a committed declaration; `#name` never falls back to a directory |
| `/bottom` or Ctrl+End | Fullscreen: return to latest messages. Default mode: use the terminal's scroll-to-bottom shortcut |
| `/quit`, `/exit`, or Ctrl+D on an empty draft | Exit and remove this console's membership |
| Ctrl+C | Clear the draft without quitting |
| Escape | Clear a nonempty draft, including an open suggestion list. On an empty draft, request a message-free interrupt of a local active Codex turn, or stop a local Claude session at its next tool call. A repeat within one second is ignored |
| `//text` | Send a message beginning with `/` |

`/clear` also clears native terminal scrollback. Reopening the room shows only messages
after the saved marker; `/older` can still retrieve earlier messages. Earlier pins are hidden,
without acknowledging them. The room archive, other users' views and agents' receive cursors
are unchanged. It takes no arguments and does not reset any member harness's context.
Native APIs and terminal fallbacks for future member `/clear` or `/compact` controls are
tracked in the [harness control shim register](harness-control-shims.md).

### Delivery marks

The header of each message you send names its recipients, each followed by one mark: `…` not
delivered yet, `✓` delivered, `!` delivery failed. A room message lists everyone it went to, as in
`you → claude ✓, codex …, grok ✓`, and appears once no matter how many agents received it. A mark
changes to `✓` when the agent acknowledges the native envelope or its receiver returns your message.
Headers update while still on screen; older saved history shows `✓` where delivery was recorded.
Plain non-terminal output appends one status line per recipient instead. This is a delivery receipt,
not proof the model has acted.

### Display and navigation

Typing `/`, `@`, or `!@` shows suggestions above the room bar. The inline console reserves space
for the menu so opening and closing it does not move the room bar or prompt. Up/Down choose,
Tab or Enter accept, and Enter sends once the word is complete. Typing `/go` shows open rooms;
Up/Down then one Enter switches directly, while Tab fills the selected name for editing.
Escape clears a nonempty draft in one press, even while
suggestions are open. On an empty draft it attempts a message-free interrupt: Codex uses the local
app-server's active-turn cancellation, or sends Escape to its Herdr pane when that pane's session
and process match the room member. For a local Claude session, chat leaves a flag that the
installed interrupt hook (added by `tt install claude`) reads before and after each tool call: it
denies the pending tool and ends the turn with `continue: false`. Claude cannot be stopped mid-reply
or inside a running tool, and a flag no tool call claims within 60 seconds expires. The status bar
shows `claude stopping` while that flag is pending and briefly shows `codex interrupted` after an
accepted cancellation. Idle and unsupported peers show no indicator. When neither path is available,
the transient hint says `nothing to interrupt`. No interrupt result is added to the transcript, room,
or harness prompt. Holding Escape keeps sliding a one-second guard, so it arms only once until
released. Ctrl+C clears the draft. Neither quits.
Shift+Enter or Alt+Enter adds a new line. Chat asks the terminal for enhanced key reporting (the
kitty keyboard protocol, or xterm's modifyOtherKeys) so Shift+Enter is distinguishable from Enter, and
restores the terminal's keyboard mode when it exits, suspends, or opens an editor. Ghostty, kitty,
WezTerm, iTerm2 3.5+ and foot support this; inside tmux, set `extended-keys on`. Where Shift+Enter
still sends, map it to send `ESC Enter` (Ghostty: `keybind = shift+enter=text:\x1b\r`), or use
Alt+Enter. With suggestions closed, Up/Down move
through multiline drafts or recall single-line prompt history; Ctrl+P/Ctrl+N also recall prompts.
Pasted multiline text stays in the draft until Enter. The conversation remains in terminal scrollback
after exit.

### Images

A terminal paste carries only text, so chat reads images itself, as harness composers do. Ctrl+V
(or a paste with no text, which some terminals send when the clipboard holds only an image) reads
the clipboard's image. A pasted path to a PNG, JPEG, GIF, or WebP file, such as a file dragged into
the terminal, becomes an image too, as does `/attach <file>`. Each image is copied at once to
`<data dir>/attachments/<sha256>.<ext>`, the extension matching its actual bytes, and stands in the
draft as `[Image #N]`. On send, the markers are renumbered from 1 in message order, and every
recipient's prompt carries one line per image:

```text
Image #1 attached at /…/attachments/<sha256>.png (image/png, 415 KB). Read that file to see it.
```

Agents run on the same machine and open the file with their own image tools. Hook-based harnesses
such as Grok carry text only, so the explicit read request is what turns the path into pixels.
`tt msg send <recipient|room> [body] --attach <file>` (repeatable) sends the same thing from a
script. A message may name only stored images (at most 8, each up to 20 MB); the body may be empty
when it has one.

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

The Lantern house palette uses warm amber accents, lavender slash commands, and stable agent
identity colors. Highlighting updates while you type: exact command/member names are emphasized,
partial names are muted, and unknown names are underlined. This indicates token recognition,
not delivery or permission to act. Aliases that address several live members use the broadcast
color rather than the first member's identity color. `@everyone` and `@all` use that color too;
`!@name` also emphasizes the interrupt marker. Email addresses and backtick code do not look like
recipient selections. The completion menu shares these colors, bolds the matched prefix, and
paints the selected row. Accepting a completion with Tab leaves its recognized token highlighted.
Color never changes the draft text, cursor placement or wrapping. `COLORTERM=truecolor` (or
`24bit`) selects RGB colors; otherwise the palette uses 256-color fallbacks. Choose Lantern (warm amber, the default), Tide (cool teal), or Dusk (muted lavender)
with `tt chat --theme tide` or `TT_THEME=tide tt chat`. Startup precedence is `--theme`, then `TT_THEME`, then your saved choice, then Lantern. In chat, `/theme` shows the current choice and `/theme dusk` changes it immediately
and saves the choice for your next chat, including across room switches. `/theme` also shows
whether the current choice came from a flag, environment, saved preference, or the default. Agent identity hues stay the same in every
palette. Switching repaints the visible transcript and composer immediately. Older native
scrollback outside the visible viewport keeps its existing colors.
`NO_COLOR` disables color in all themes.

Menus and completion lists have a blank row separating them from the transcript.
Member choices use their agent colors; command results use a separate `│` gutter with
info, done, or error styling rather than an authored-message layout.

Messages explicitly addressed to your human identity have a subtle background at their
original position in the timeline. When unread messages leave the live viewport, one row on
that same background appears at the top, like a status bar:

    ▲ 2 unread · codex › Before I merge #180, can you confirm the operator… 4m · /unread

It names the sender of the oldest unread message, previews that message's first line, and
shows its age. On narrow terminals the `/unread` hint goes first, then the age, then the
preview; the count always stays. Only that one line is previewed. Message bodies are never
pinned or repeated above the conversation.

Activate the control to visit the oldest missed message in its original timeline. The view
places its header at the top, and the message you landed on takes the selected-row background.
The control then reads `▲ 1 of 2 · codex 4m · Enter next · Esc live`. Each activation
advances to the next missed message and records an acknowledgement only after that target is
drawn. Context messages are not acknowledged, and clicking them while reviewing does nothing.
While reading, Enter or Space advances; arrows and Page Up/Down browse; Escape returns to
the live tail with your draft intact. Incoming messages join the end of the queue. After the
last visit the control reads `✓ All caught up · Esc live` until you return live.

In Herdr, run `tt install herdr` once and restart chat, then **Ctrl-click** the unread
control. The native link handler reaches only the live console in the clicked pane.
This does not enable terminal mouse capture, so scrolling and selection keep working.
Outside Herdr, or without its plugin, use `/unread`. The history reader is managed by chat;
it does not reposition the terminal's own scrollback, whose public Herdr API only exposes
scroll observations. Explicit `--mouse` enables plain clicking, and captures wheel and drag
input too; inline selection then uses Shift-drag (Option-drag in iTerm2). `--no-mouse` wins
and does not disable Herdr Ctrl-click.

While every unread message is still on screen, inline output keeps flowing into native
scrollback as usual. The bar takes over the top of the pane only once an unread message has
scrolled off, and stays until nothing is unread.

Scrolling across an unread message reads it, durably, in fullscreen mode and in inline Herdr
chat where scroll position is known. Browsing during an unread review never does. In inline
Herdr chat, only rows written while the bar was showing can be placed in native scrollback;
a message that scrolled off before the bar appeared stays unread until you visit it. While native Herdr scrollback is away from the tail,
updates buffer without repainting what you are reading; returning flushes the full history.
Outside Herdr, native scroll position is unknown, so use the control, `/unread`, or `/ack`.
Typing alone never acknowledges a message.

`/ack` acknowledges visible highlighted messages, `/ack #123` one message, and `/ack all`
every pending message. Acknowledgements persist per room and local human across restarts,
and are separate from delivery receipts. `/clear` hides earlier messages without
acknowledging them. Broadcasts, visitor replies, messages to other humans, and your own
messages do not enter the missed-message queue.

Resizing the window reflows the live panel in place, rebuilding only the visible tail and keeping
native scrollback. Narrowing a terminal can leave repeated recent lines at the scrollback boundary,
and the redraw replaces any pre-chat shell output still in the visible area.

`tt chat --fullscreen` retains the alternate-screen layout, with a header pinned to the top and an
input/status area pinned below the transcript. In that mode, Page Up/Page Down and Shift+Up/Down
scroll the conversation; Ctrl+End or `/bottom` returns to live messages. Scrolling upward fetches
earlier saved entries. The live buffer retains up to 2,000 blocks; browsing older history can grow it
until returning to the bottom. Mouse capture remains opt-in with `--fullscreen --mouse`, which
enables pointer-based wheel scrolling but may prevent native selection. `--no-mouse` wins over
`--mouse`. In inline mode, `--mouse` enables click acknowledgement and captures native wheel
and drag input. Fullscreen exit restores the
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

### Role assignments and harness defaults

`/roles` opens a fixed-size keyboard grid. **This room** contains exact live
sessions. **Harness defaults · all rooms** (Tab) contains harnesses even when no
session is present. Defaults apply only when no room or session override exists;
`r` removes the selected override, restoring inheritance (or bundled defaults).
`u` undoes the draft. Enter applies both tabs together; Esc asks before discarding.

In This room, `e` edits the focused definition, `n` creates a role, and `i` edits
shared project instructions in `$VISUAL`, `$EDITOR`, or `vi`. Save and exit the
editor to return to the draft; no file or assignment changes until Enter. The
project file is `.talking-stick/instructions.md` at the repository root. Definitions
use this Markdown form (user definitions can also live in the user instructions):

```markdown
## Roles

### reviewer
Review independently. Reproduce material claims before agreeing.
```

Definitions resolve bundled → user → project by name. The defaults tab uses only
bundled/user definitions; project definitions are edited in This room. Existing
custom role names remain visible even if their definition is missing.

`p` previews the selected agent's instructions and `v` shows all pending chat
notifications. Assignment changes notify affected sessions; definition edits
notify holders; shared instructions notify all agents reading that project file.
Harness-default changes also notify inheriting sessions in other open rooms.
Explicit overrides are unchanged. Notifications are durable and apply from the
agent's next turn; roles never grant the stick. Conflicting file or assignment
changes keep the draft open with an error instead of overwriting newer work.

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

`tt install` installs or refreshes the bundled skills: `talking-stick`, which agents working in a
room use, and `talking-stick-rooms`, for a session that watches rooms from outside (see
[Observing rooms from outside](#observing-rooms-from-outside)). Both go to the same places, and an
update adds `talking-stick-rooms` beside any existing `talking-stick` install. Skill directory writes are
delegated to the `skiller` binary when available; package postinstall bootstraps skiller from the
published release and verifies `checksums.txt` before installation. If skiller is missing, disabled,
or fails its version gate, `tt` uses the built-in TypeScript fallback. Set
`TALKING_STICK_DISABLE_SKILLER_BOOTSTRAP=1` to skip the postinstall bootstrap, or
`TALKING_STICK_DISABLE_SKILLER=1` to force the TypeScript fallback.

- Claude Code: copied or linked into `~/.claude/skills/<skill>`, because Claude Code does not
  read `~/.agents/skills`
- Codex, Antigravity (`agy`), Grok Build, and OpenCode: copied or linked once into the shared
  `~/.agents/skills/<skill>`
- Codex: also merges lifecycle (`SessionStart`, `SessionEnd`) and turn (`UserPromptSubmit`, `Stop`,
  `Interrupt`) hooks into `~/.codex/hooks.json`, leaving other entries alone. Codex runs them only
  after you trust them in `/hooks`; see [Native event delivery](#native-event-delivery).
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

### The Herdr plugin

`tt install herdr` links a small Herdr plugin, `talking-stick.chat`, that turns a Ctrl-click on
the unread control into a history jump without mouse capture. It needs Herdr 0.7.0 or
newer. The manifest is generated under the data directory and runs `tt chat-link` by absolute
path (through `<install-dir>/current` for a release, so it survives updates). Each chat
inside Herdr links its unread control to `https://talking-stick.invalid/ack/<token>/<message>`; the token
names a private socket in `/tmp/tt-chat-<uid>` owned by that chat, which visits pending messages only in its own pane and acknowledges each after drawing it. Stale or foreign links do nothing.
`tt uninstall herdr` unlinks the plugin and removes the generated files.

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

- **Declared rooms.** An agent at any depth under `/repo/` joins the `/repo/` room automatically,
  unless a nearer directory declares its own room with `.talking-stick/room.toml`. A repository never
  joins a room above its checkout; linked worktrees share the main checkout's rooms.
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

### Member actions with the mouse

Run `tt chat --fullscreen --mouse` to right-click a visible member in the bottom status bar. The menu identifies the exact session; use ↑↓ and Enter to choose Message or Remove, and Escape to cancel. Removal asks for confirmation and leaves the harness running. `/members` opens the same picker in fullscreen or inline mode, including members that do not fit in the status bar.

In Herdr, choose **Send right-clicks to pane** from its pane menu, or run `herdr pane input --current --right-click pane` in the chat pane before starting chat. Right-click the pane frame to reach Herdr's menu. Alternatively configure `ui.right_click_passthrough_modifier = "ctrl"` and use Ctrl-right-click. Mouse capture remains opt-in; inline mode retains native selection.

### Room navigator

`/rooms` or **Ctrl+T** opens **Folders**. Press Tab for **Rooms**, a tree made from the shared
host database's room paths and necessary ancestor folders, without scanning the filesystem.
Shared prefixes appear once and single-child chains are compressed, preserving every known
room boundary. Unrelated top-level branches do not add a synthetic filesystem-root row.
Ancestor rooms excluded by the current filter remain dim and labelled as inactive or outside
the filter; `a` includes inactive rooms as selectable rooms.
It starts in **Active**, with open rooms that have a live agent or console;
press `a` for **All open**, including rooms with nobody in them. Rooms whose canonical
folder is missing are labelled unavailable; their saved room can still be opened by ID.
Use ↑↓ or Page Up/Down to select, ←→ to collapse/expand, and Backspace to select a parent.
Enter opens a room; on a pure branch it toggles expansion. A room that also has children
still opens with Enter; use arrows for its children. Collapsed branches roll up hidden
agents, consoles and unread counts. Up to 30 matching rooms are expanded initially;
larger sets initially expand the current room's ancestor chain.
`/` edits a case-insensitive substring
filter over room names and full paths; shortcut letters are literal text while filtering.
Search prunes the same hierarchy and keeps the matching paths expanded. Arrows select a match
and Enter opens it; Escape finishes filter editing. Siblings initially use folder-name order;
`s` cycles name, path, activity (latest descendant event) and total member-count sorting.
Agent and console counts are separate. Browsing never joins rooms
or refreshes members' presence. Enter joins the chosen room as this human console.

Tab switches between **Rooms** and **Folders**. Folders shows the full filesystem browser;
Rooms omits folders that do not lead to a matching room. In Folders, use → to expand or enter a child,
← to collapse or select the parent, and **Backspace** to raise the tree root one level.
← at a collapsed root also raises it. You can browse above the repository up to `/`, and
enter other repositories. Enter opens the directory's resolved room; Escape closes and
keeps your draft. Explicit host navigation reanchors the strip to the chosen repository;
`/go` and Alt+←/→ keep their repository-scoped behavior. Visited memberships, drafts and
per-room clear markers survive switching; exiting chat leaves its visited/subscribed rooms.

A room row shows `● N` agents, unread messages, and `*` for the current room. Collapsed folders show the total agents below them. The footer identifies the room a plain folder resolves to. Press `n` on a folder without its own room, then `y` to declare and open one (`n` or Escape cancels). This writes `.talking-stick/room.toml`, the same as `tt room create`.

Folders load one level at a time and are cached while the tree is open. Empty and untracked
folders are included; hidden or Git-ignored folders are omitted unless they contain a known
room or have a room declaration. Nested repositories are navigable. Counts refresh while
the panel stays open. Outside an interactive terminal, `/rooms` lists active host rooms;
`/rooms <room-id>` opens one explicitly.
