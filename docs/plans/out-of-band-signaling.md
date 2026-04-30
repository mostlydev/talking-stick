# Out-of-Band Signaling Between Harnesses

**Status:** Amended design — converged on 2026-04-30 between `codex:5c11d1e8` and `claude:9610b1fe` under operator framing. Implementation gated on PR review.
**Related:** [ambient-presence.md](../ambient-presence.md), [talking-stick-plan.md](../talking-stick-plan.md)
**Supersedes:** the original notes-with-severity proposal (commit `0e2bf58`, PR #12). Git history preserves the prior version.

## What changed from the original

The original proposal piggybacked transient signaling on the existing `notes` table by adding `severity` (info/page) and `target_agent_id` columns, and made a per-harness `tt events --follow` watcher subprocess the canonical delivery mechanism. After re-reading the design under the operator's chat-style framing ("a message pipe for conversation as long as they keep a process running, send messages back and forth with single commands"), the amended design makes three structural changes:

1. **Transient messages are not notes.** Notes stay durable, resolvable task artifacts, unchanged API. Messages are an event-only stream emitted directly into `room_events`, with no separate table and no impact on `list_notes`. The interrupt-class behavior lives on message events, not on notes.
2. **The substrate is a generic event payload, not narrow per-event columns.** Migration 5 adds a single `room_events.payload_json TEXT NULL` column. Specific event types (`message_sent`, future `member_joined`, `member_left`) discriminate via `event_type` and read event-specific keys out of JSON while still using common columns like `from_agent_id`, `to_agent_id`, `reason`, and `created_at` where they already fit. Cheaper than four narrow columns; extensible without further migrations.
3. **v1 ships a working agent-side path via the CLI; plugins are an optional future enhancement for richer harness-native UX.** The canonical v1 receive pattern is a long-running `tt msg recv --follow` child process whose stdout the harness, operator, or terminal can watch (Claude Code's Monitor today; tmux/terminal for humans; explicit between-turn polling where stdout-watch is unavailable). This repo ships the protocol substrate, the `tt msg` / `tt events --follow` CLI, the skill guidance, and a receive-consumer contract. Per-harness plugins (Claude Code, Codex, Gemini, OpenCode) are a *future* layer for harness owners that want ambient UX beyond what the CLI subprocess delivers; they live outside this repo and are not prerequisites for v1.

## Purpose

The talking stick today enforces **in-band, single-speaker** coordination: the holder is the only participant whose work mutates the workspace; others wait or observe. That is correct for write authority. It is too restrictive for *signaling*.

There are real situations where a non-holder needs to reach the holder — or where two non-holders need to coordinate — *without* taking the stick:

- A non-holder watching the holder's work notices a problem (wrong file, broken assumption, looming merge conflict). It should be able to say so without forcing a takeover.
- The holder wants a quick yes/no from a peer mid-edit and does not want to release the stick to ask.
- A new participant joins mid-turn. The holder may want to acknowledge, hand off, or just note the change in social shape.
- The operator drops a directive ("scope down — stop after the parser test passes"). The holder should see it before the next handoff boundary.
- Two agents want to discuss a design decision back and forth without paying the token cost of formal handoffs each round-trip.

The original design framed the dominant case as *guardian-style page* (non-holder → holder, single direction, interrupt-worthy). The chat-style framing makes it *bidirectional discussion* (holder ↔ non-holder, multiple round-trips, interrupt class is per-message, often not interrupt at all). Both cases sit on the same primitive; the amendment does not bifurcate them.

## Vision

Vignettes A–G are adapted from the original; H is new and is the case the amendment most cares about. Presence-focused vignettes assume the optional presence-event stage has shipped.

**Vignette A — guardian catches a wrong turn:**

1. Codex holds the stick, working on `src/auth/session.ts`.
2. Claude Code is acting as a non-holder guardian and sends `tt msg send codex --interrupt "You're editing session.ts but the bug is in token.ts — see line 84."`
3. Codex's receive process gets the `message_sent` event through `wait_for_events` with `target=self`.
4. Codex may correct immediately or defer until the next natural read point. The message does not grant Claude write authority and does not require a takeover.
5. At handoff, Codex can acknowledge the message in the structured `Handoff` if it affected the work.

**Vignette B — join awareness mid-turn:**

1. Claude Code holds the stick on a long refactor.
2. A human runs `tt join` from a second terminal.
3. A `member_joined` event lands on Claude's receive stream.
4. Claude's consumer policy says: `member_joined` is informational, not an interrupt — write it to the boundary buffer.
5. At handoff prep, Claude reads the buffered events and notes "Wojtek joined two minutes ago" in the handoff body.

**Vignette C — operator pages the active holder:**

1. The current holder is in the middle of a long edit.
2. The operator runs `tt msg send <holder-id> --interrupt "Scope down: stop after the parser test passes."`
3. The holder's receive process surfaces the message via the best available path, with the full body inline (no follow-up fetch).
4. The holder may act immediately or acknowledge at handoff. The message does not grant or revoke write authority.

**Vignette D — a participant leaves before handoff:**

1. Claude Code holds the stick and originally expected to pass to Gemini for review.
2. Gemini exits the room or is GC'd inactive.
3. Claude's receive process records `member_left` with `from_agent_id = gemini:...` and a reason.
4. At handoff prep, Claude sees the buffered leave event and does not `pass_stick` to Gemini.

**Vignette E — the holder pages a future recipient:**

1. Codex holds the stick and finds a regression Claude should address after.
2. Codex calls `tt msg send claude --interrupt "When I pass back, please start with tests/cli.test.ts; the install dry-run expectation is stale."`
3. Claude's receive process gets the message while Claude is still a non-holder. Claude may read and prepare, but still must not mutate the workspace until it owns the stick.
4. Codex later releases or passes with a handoff that may reference the message body inline.

**Vignette F — a third harness joins an existing pair:**

1. Codex and Claude have been alternating on a feature.
2. OpenCode joins the room.
3. Both active members see `member_joined`. Default consumer policy treats it as informational, not interrupt-worthy. The current holder may mention OpenCode in the next handoff.

**Vignette G — handoff as an early wake-up signal (deferred future work):**

`wait_for_turn` remains the authority on stick availability; using events as advisory wakeup is gated on a separate wait-intent design.

**Vignette H — NEW bidirectional design chat without stick churn:**

1. Codex holds the stick and is mid-implementation. He has a sharp question for Claude that is not blocking but matters.
2. Codex: `tt msg send claude "are we tying force_new behavior to canonical_path uniqueness or to room_id uniqueness?"` — a single CLI call, no flags beyond the recipient.
3. Claude (non-holder, idle in his wait loop) gets the message via his receive process and answers: `tt msg send codex "canonical_path. There's a UNIQUE constraint on it; sequence_index is fairness state, not recency."`
4. Three more round-trips of similar shape. Total: ~6 messages, no `pass_stick`, no `claim`, no formal handoff. Stick stays with Codex throughout.
5. Codex resolves the question and continues the edit. The exchange is in the event log for audit, but did not occupy a turn boundary.

This is the case the amendment most wants to make ergonomic. Today, agents in this room (turns 73–76 of room `b94f3d80`) ping-pong the stick to have exactly this kind of discussion — paying ~600 tokens of handoff structure per round-trip for ~80 tokens of real exchange. Vignette H eliminates the ping-pong without weakening the ownership model.

## Scope

In scope:

- A single new event type `message_sent` carried over the existing `event_seq` log via a generic `payload_json` column.
- Optional follow-up event types: `member_joined`, `member_left`, and `note_added` — all using the same `payload_json` substrate. `note_added` is bookkeeping for consumers that want to follow notes without polling `list_notes`; it does not change notes semantics.
- A `delivery_hint: "normal" | "interrupt"` discriminator on `message_sent` payloads. `interrupt` is consumer policy, not a server guarantee — the server delivers; the receiver decides whether and how to interrupt.
- `wait_for_events`: a non-mutating long-poll over the existing event stream with filters (`after_event_seq`, `event_type`, `target_agent_id`).
- `tt msg send` / `tt msg recv` ergonomic CLI wrappers around the underlying `send_message` / `wait_for_events` primitives.
- A documented receive-consumer contract so the long-running stdio process and future per-harness plugins share the same lifecycle, cursor, and backpressure rules.
- Skill prose updates explaining when to chat-message versus when to pass the stick.

Explicitly out of scope:

- Any new write authority for non-holders. Messages do not grant the stick. Takeover remains unchanged.
- Read receipts, acks, replies/threading, per-recipient mute, message resolution. v1 is one-shot fire-and-forget over the event log.
- Push transports (websockets, MCP resource subscriptions). Pull-based long-poll over SQLite is sufficient for v1.
- Any harness-specific notification format. Receive consumers use the same event payloads and decide their own UX.
- Server-side rate limiting. Deferred until real usage demonstrates need; v1 protections are body-size cap and harness-side replay coalescing.
- Event-driven stick claiming. `wait_for_turn` remains the authoritative wait/claim path until a separate wait-intent design exists.
- Treating `to_agent_id` as ACL/privacy. It is routing only; any room member can read any message.

## Architecture

Six layers. Each is independently shippable; together they deliver the chat UX.

### Layer 1 — Generic event payload

Today `room_events` has fixed columns: `event_seq`, `event_id`, `room_id`, `turn_id`, `event_type`, `from_agent_id`, `to_agent_id`, `handoff` (JSON), `reason`, `created_at`. Migration 5 adds:

```sql
ALTER TABLE room_events ADD COLUMN payload_json TEXT NULL;
```

The column is opaque JSON whose shape is discriminated by `event_type`. Existing event types (`claim`, `release`, `pass`, `takeover`, `close`, `kick`) write `NULL` and continue to use the typed columns they already populate. New event types put only event-specific fields in `payload_json`; routing and audit fields stay in the common columns when they fit. This keeps the migration trivial and avoids a parallel migration each time a new event type is added.

### Layer 2 — Message events

A new `event_type = "message_sent"`. Payload schema:

```json
{
  "body": "are we tying force_new to canonical_path or room_id?",
  "delivery_hint": "normal"
}
```

Fields:

- `body`: required string. Hard cap **4096 bytes** (UTF-8). Server rejects over-limit with typed error `message_too_large`. **No silent truncation.**
- `delivery_hint`: `"normal"` (default) or `"interrupt"`. Advisory only — the server delivers; the receiving consumer decides.

The event's existing `from_agent_id` column carries the sender; `to_agent_id` carries the recipient; `to_agent_id = NULL` means broadcast to the room. `event_id` doubles as the message id; `created_at` is the server-stamped timestamp. There is no separate `room_messages` table. Replay of historical chat uses the same `get_room_events` machinery already used for handoff replay.

`to_agent_id` is **not** a privacy boundary. Any room member reading the event log can see any message's body. Messages are routed, not encrypted. The skill must say so in plain words.

### Layer 3 — Notes (unchanged)

Notes API and semantics are not modified by this plan. Notes remain durable, resolvable task artifacts written via `add_note` and read via `list_notes`. Notes are *not* the chat surface. Skill guidance must reinforce the split:

- **Note** when the holder needs to consider something at the next handoff boundary, or when the artifact should outlive the conversation.
- **Message** when the exchange is conversational, ephemeral, and tied to two or more processes that are currently online.

Optional v1.1: emit a `note_added` event on `add_note` so consumers watching a single event stream can surface notes without separately polling `list_notes`. Pure bookkeeping; no schema change to the notes table.

### Layer 4 — Generic wait primitive

`wait_for_events` is the canonical long-poll over the event log. Non-mutating: no `touchWaitingMember`, no claim path, no waiter-grace bookkeeping.

```
wait_for_events(
  room_id,
  after_event_seq?,
  event_type?,            // single string or array
  target_agent_id?,       // 'self' | 'any' | <agent_id>
  max_wait_ms?            // bounded by server policy; default follows the existing long-poll config
) -> { events: RoomEvent[], cursor_event_seq }
```

`target_agent_id` semantics for filter:

- `'self'` (default): include events whose `to_agent_id` matches the caller's resolved agent identity, plus message events with `to_agent_id = NULL` (broadcast). This is the chat default.
- `'any'`: no filter on recipient. Used by debuggers, humans tailing the room, or consumers that need full visibility.
- `<agent_id>`: events targeted at a specific other agent. Used by humans watching directed chat.

`wait_for_events` returns the next event(s) past the cursor, up to the wait deadline, then closes. Callers re-call with the new `cursor_event_seq` to continue. Unlike `wait_for_turn`, this primitive is **observer-safe**: it never mutates room state or queue position.

`send_message` is a thin write that appends a `message_sent` event. It runs in `withImmediateTransaction` to maintain `event_seq` ordering and emits exactly one event per call:

```
send_message(
  room_id,
  body,
  to_agent_id?,
  delivery_hint?
) -> { event_seq, event_id, created_at }
```

There is no `wait_for_message` primitive. `tt msg recv` and any higher-level message UX are wrappers around `wait_for_events` with `event_type=message_sent` filter. Keeping a single wait primitive avoids duplicate filter logic and a second cursor concept.

### Layer 5 — CLI ergonomic surface

Three commands, all wrappers over Layers 2 and 4:

```
tt msg send <recipient> "<body>" [--interrupt] [--room]
tt msg recv [--from <agent>] [--wait|--follow] [--after <event_seq>] [--json|--text]
tt events [--wait|--follow] [--event <type[,type...]>] [--after <event_seq>] [--target self|any|<agent_id>] [--json|--text]
```

Resolution rules:

- `tt msg send <recipient>`: `<recipient>` may be a full `agent_id` (`codex:5c11d1e8`), a display name (`codex`), or the literal `room` for broadcast (`to_agent_id=null`). A bare display name resolves to the unique active member with that display name; ambiguity returns `ambiguous_recipient` listing candidates. No active member with that name returns `unknown_member`.
- `--interrupt`: sets `delivery_hint=interrupt`. Default is `normal`.
- `tt msg recv`: defaults to `target=self` (direct + broadcast). `--from <agent>` filters by sender. `--follow` long-polls until SIGTERM/SIGHUP, emitting one JSON-line event per stdout flush. `--wait` runs the same long-poll once, exits after the next matching batch, and is the portable path for harnesses that can observe process completion but not per-line output.
- `tt events --wait|--follow`: lower-level surface tailing arbitrary event types (not just messages). Output format follows identity (harness -> JSON lines, human -> text), per the `ambient-presence.md` contract.

**`tt msg recv --follow` is the canonical v1 agent-side receive path.** Any harness that can spawn a long-lived child process and watch its stdout (Claude Code's Monitor today, future Codex/Gemini/OpenCode equivalents) integrates by spawning `tt msg recv --follow` and routing the JSON-line stream into its own context-injection pipeline. No plugin code is required; the harness's existing subprocess mechanism IS the integration. For harnesses without that mechanism, two fallback v1 paths exist: (a) the operator runs `tt msg recv --follow` in a tmux pane and human-relays the message, or (b) the agent calls `wait_for_events` between turns via MCP. `tt events --follow` is for humans, debuggers, and tooling that wants the full event stream rather than just messages.

### Layer 6 — Receive-consumer contract

**v1 does not require any plugin work.** Layer 5's `tt msg recv --follow` subprocess pattern is the first receive consumer. A future plugin is just another consumer with richer routing. This layer documents the shared contract for both the CLI subprocess and later harness-native consumers — lifecycle, cursor persistence, replay, and backpressure.

The protocol guarantees: at-least-once event delivery via `wait_for_events`, with monotonic `event_seq` ordering and SIGTERM-clean wrappers. The CLI subprocess uses that primitive directly; plugins, when they exist, should do the same.

Consumer responsibilities:

1. **Receive loop.** Long-running task or subprocess that polls `wait_for_events` with `target=self`, persists `cursor_event_seq` across restarts, and routes incoming `message_sent` events to terminal output, app-level notification, or model-context injection.
2. **App-level versus model-context routing.** The consumer decides per `delivery_hint`. `interrupt` may inject directly into the active conversation where the harness supports that (Claude Code's Monitor model already does this for `tt msg recv --follow` lines); `normal` may write to terminal output, a status indicator, a counter, or a deferred-injection buffer that the model drains explicitly.
3. **Send invocation.** Expose a deliberate send path the model can invoke (skill, slash command, native tool). Should call the CLI or MCP tool, not reimplement the wire format.
4. **Cursor recovery.** Persist last-seen `event_seq` to a known location (under `~/.local/share/talking-stick` or a harness-specific equivalent) so process restart resumes cleanly. The protocol's at-least-once guarantee means duplicates are possible across restarts; consumers dedupe on `event_id`. `tt msg recv --follow` supports `--after <event_seq>` for the same purpose.
5. **Replay coalescing.** On reconnect with a far-behind cursor, the consumer should coalesce or summarize old messages rather than firehose them into the model context. Suggested policy: deliver the most recent N at full fidelity; older are summarized as a count.
6. **Backpressure.** If the downstream (Monitor, terminal, IDE, etc.) blocks, the consumer's reading from `wait_for_events` should not. Drop-with-warning or buffer to disk; do not let pressure propagate to the protocol layer.

### Delivery grades per harness (what to expect on day 1, no plugins required)

| Harness | v1 receive (no plugin) | v1 send | Plugin enhancement (later) |
|---------|------------------------|---------|----------------------------|
| **Claude Code** | mid-tool-loop injection via Monitor watching `tt msg recv --follow`; each JSON line becomes a system reminder | model-deliberate via skill prescription; CLI passthrough | richer routing (per-author mute, statusline, deferred-buffer for `normal`) |
| **Codex** | event delivery via operator-run `tt msg recv --follow` in a tmux pane, plus model-visible delivery only when Codex explicitly polls `wait_for_events` between turns | model-deliberate via tool call to MCP `send_message` or CLI passthrough | automatic mid-tool-loop injection if the harness eventually exposes a stdout-watch hook |
| **Gemini** | durable pipe via the same fallback paths as Codex | same as Codex | TBD with harness owner |
| **OpenCode** | durable pipe via the same fallback paths as Codex | same as Codex | TBD with harness owner |
| **Human (`tt msg recv --follow`)** | tmux pane / terminal output | bare CLI invocation | n/a |

The portable guarantee is: at-least-once event delivery with monotonic ordering. *Any* harness or operator that calls `wait_for_events` (directly, via MCP, or via the `tt msg recv --follow` subprocess) will eventually see every relevant event. The mid-tool-loop interrupt-class fast path is harness-by-harness; for v1, only Claude Code has it via Monitor + the CLI subprocess. Other harnesses get a functional pipe immediately, but model-visible delivery may be between-turn or human-relayed until those harnesses expose stdout-watch or plugin hooks.

## Wait pattern — not changed by this plan

This proposal does not replace `wait_for_turn` with event-driven notifications for stick availability.

`wait_for_turn` still updates `last_wait_at` and gates reservation behavior via `waiterGraceMs` (`src/service.ts:1689-1701`). A waiter that sleeps purely on `wait_for_events` for minutes can change reservation eligibility. The skill should continue to teach direct `wait_for_turn` long-polling for ownership; advisory event wakeups for waiters require explicit wait-intent state (e.g. `wait_intent_expires_at`), which is a separate design.

## Token-cost analysis

Concrete numbers, since this is the live concern.

**Idle cost: zero.** A backgrounded `wait_for_events` long-poll consumes no model tokens while running.

**Per-event cost: small and proportional.** A typical `message_sent` event in the chat use case is 60–300 tokens of body. A receive process that injects into model context spends roughly that per message. A terminal-only receive process costs no model tokens until an operator or model deliberately drains it. Under the v1 CLI-only path on Claude Code's Monitor, every JSON line is a system reminder by default, so `normal` and `interrupt` differ only once a consumer adds routing policy; v1 Claude Code treats both as immediate.

**Per-handoff replacement savings:** one skipped stick round-trip in our own dogfooding is ~600 tokens of handoff structure (`status`, `next_action`, `artifacts[]`, `open_questions[]`). A typical chat exchange of 4–6 messages totals 240–600 tokens of body. Net savings only materialize when the discussion is short enough to not justify a full handoff but long enough to span multiple round-trips. That's the sweet spot Vignette H targets.

**Where it gets expensive (still true from the original):**

- Receive processes inlining full bodies into context for `normal`-class messages without buffering. Mitigation under v1 CLI-only is best-effort: Monitor will inject every line; harnesses that want `normal`-vs-`interrupt` distinction need a smarter consumer (plugin, wrapper process, or operator-side filtering before injection).
- Receive processes not filtering. A holder doesn't need its own outbound messages echoed back. The CLI defaults to `target=self` which excludes the caller's own outbound, so this is mostly handled by the v1 default.
- Many idle agents all running receive subprocesses on the same room. Cost is per-agent context. With N agents, N receive contexts. Acceptable for small N (≤4 typical).
- Replay floods on subprocess/plugin restart. Use `--after <last_seen_event_seq>` to resume; the harness or plugin should coalesce per Layer 6 §5 if the gap is large.

## Concrete surface changes

### Service / DB

1. Migration 5: `ALTER TABLE room_events ADD COLUMN payload_json TEXT NULL`. Existing rows back-fill to `NULL`.
2. New service method `sendMessage({ agent_id, room_id, body, to_agent_id?, delivery_hint? })`. Validates body length (≤4096 bytes UTF-8), validates `to_agent_id` is null or a known room member id (loose check — this is routing, not auth), appends one `message_sent` event with `payload_json`. Returns `{ event_seq, event_id, created_at }`.
3. New service method `waitForEvents({ agent_id?, room_id, after_event_seq?, event_type?, target_agent_id?, max_wait_ms? })`. Non-mutating long-poll. Server policy bounds `max_wait_ms` using the same configurable long-poll defaults as the existing wait APIs; the design does not bake in a dogfooding timeout. Returns events past the cursor that match filters, plus a new `cursor_event_seq` for the next call.
4. Optional v1.1: emit `member_joined` / `member_left` / `note_added` events alongside their primary actions. Each writes its small `payload_json` describing reason/turn/etc.

`waitForEvents` does **not** call `touchWaitingMember`. It is observer-safe by design. (This addresses Codex's blocker #1 from the original review at issue #11.)

### MCP

1. New tool `send_message(room_id, body, to_agent_id?, delivery_hint?)` → `{ event_seq, event_id, created_at }`.
2. New tool `wait_for_events(room_id, after_event_seq?, event_type?, target_agent_id?, max_wait_ms?)` → `{ events, cursor_event_seq }`. Resolves caller identity from MCP transport when `target_agent_id='self'`.
3. `get_room_events` already exists and now returns events with their `payload_json` populated for new event types. No signature change.

### CLI

1. `tt msg send <recipient> <body> [--interrupt] [--room]` — resolves recipient, calls `send_message`. Passes `--room` for broadcast.
2. `tt msg recv [--from <agent>] [--follow] [--after <event_seq>] [--json|--text]` — wraps `wait_for_events` with `event_type=message_sent` and optional sender filter. Default `target=self`.
3. `tt events --follow [--event <type,...>] [--after <event_seq>] [--target self|any|<agent>] [--json|--text]` — generic event tailer. Output format follows identity per `ambient-presence.md`.

`tt msg recv --follow` is intended to be spawned as a long-lived child process by harnesses that watch subprocess stdout. SIGTERM and SIGHUP cause a final cursor flush and clean exit. The implementation should write each event as a single line of JSON (or human-readable text per identity), flushed immediately.

### Skill

The shipped `skills/talking-stick/SKILL.md` gets a new top-level section between §4 (While waiting) and §5 (While holding the stick), titled **"§4.5 Out-of-band messaging"**. Drafting deferred to the implementation pass; bullet-level content:

- Use `tt msg send` / `send_message` for transient conversational exchange. Use `add_note` for durable hints, observations, or pointers that should outlive the moment.
- `--interrupt` is for "the holder really should look at this now." Use it sparingly. The receiving harness or plugin decides what "interrupt" means; the protocol does not enforce attention.
- Messages are not private. Any room member can read any message via `get_room_events` or `tt events --follow --target any`. `to_agent_id` is routing, not ACL.
- Messages do not replace handoffs. `pass_stick` / `release_stick` with a structured `Handoff` is still required at turn boundaries. Use chat for *discussion*; use a handoff for *transfer of work*.
- The recommended v1 receive pattern is a `tt msg recv --follow` child process spawned by your harness (Claude Code) or operator (humans, Codex, Gemini, OpenCode in tmux). After releasing or passing, that subprocess keeps running and surfaces incoming messages between turns. Stay in the wait-for-turn loop in parallel.

### Plugins *(future enhancement, not v1)*

This repo owns the protocol substrate, the CLI, the skill prose, and the **receive-consumer contract** (Layer 6 above, formalized as `docs/receive-consumer-contract.md` or equivalent in a future implementation pass).

**v1 ships and works without any plugin.** After the v1 CLI surface lands, all of the following are usable without harness-owner plugin work:

- **Claude Code**: spawn `tt msg recv --follow` and let Monitor inject each JSON line as a system reminder. The skill teaches the model to send via `tt msg send` (or the MCP `send_message` tool).
- **Codex / Gemini / OpenCode**: the operator runs `tt msg recv --follow` in a tmux pane and relays interrupt-class messages, OR the agent calls `wait_for_events` between turns via MCP. Both are v1 paths; neither requires harness-owner integration work.
- **Human**: `tt msg send/recv` and `tt events --follow` are sufficient with no further setup.

Per-harness plugins are a **post-v1** layer for harness owners that want richer ambient UX (statusline indicators, per-author mute, smarter routing of `normal` vs `interrupt`). When they ship, they live in their respective ecosystems:

- **Claude Code** plugin: ships in `claude-code-plugins` (or equivalent) when there's appetite for behavior beyond Monitor + CLI.
- **Codex** plugin: ships from the Codex extension surface when stdout-watch or equivalent injection becomes available.
- **Gemini, OpenCode** plugins: deferred to harness-owner work.

A reference Claude Code plugin is **not** bundled in the npm tarball at any stage, to avoid coupling protocol releases to a single harness's UX.

## Tradeoffs and open questions

- **Why event-only messages instead of a `room_messages` table?** Storage parity with handoff state, single cursor, and append-only ordering match the use case. A messages table would duplicate the indexing and create a second resumable stream. Cost: messages share retention with events; if events are GC'd, so are old messages. v1 retention for events is "forever" (matches today); revisit if the room grows hot enough to need TTL.
- **Why `delivery_hint` instead of `priority`/`severity`/`page`?** "Hint" makes the protocol's actual guarantee explicit: it's a routing suggestion to the consumer, not a server-enforced behavior. "Page" carries on-call connotations that overstate the contract. "Priority" implies a ladder; we only have two levels.
- **Why no rate limit?** Agents are not chatbots; the design-discussion traffic pattern is single-digit messages per minute, well below anything that would burst SQLite. If usage demonstrates need (e.g. a buggy agent loops on `send_message`), we can add a per-author cap as a typed `rate_limited` error in v1.x. Documented threshold for revisiting: 30 messages / author / minute sustained.
- **Why no read receipts / acks / threading?** Each adds a primitive and a column. None are needed for the stated use case; all can be added later non-breakingly if proven necessary.
- **Authentication of message targeting.** Any member can target any other; matches notes today. If permissioning is ever needed, it is a separate concern.
- **Crash recovery.** Receive subprocess (or plugin) dies → harness or operator restarts it with `--after <last_seen_event_seq>`. The CLI's `tt msg recv --follow` accepts that flag directly. Cursor persistence is the harness's or plugin's responsibility — recommended path is `~/.local/share/talking-stick/cursor-<agent_id>.json` or a harness-specific equivalent. At-least-once is the contract; consumers dedupe on `event_id`.
- **Resolution semantics on chat.** No resolve concept for messages. The exchange is its own resolution; if action is required, it goes into a note (`add_note`) or a handoff. Notes still resolve.
- **Operator killability.** Each receive loop should be killable by SIGTERM with a final cursor flush. `tt msg recv --follow` should honor this; harness-side plugins should too.

## What this plan does NOT yet specify

Inputs to the implementation pass, not blockers for review:

1. **Exact migration 5 DDL and the `payload_json` schema sketch per event type.** Migration is one column; the discriminated payloads need a documented schema (probably a TypeScript discriminated union mirrored in `docs/event-payloads.md`).
2. **`member_left` / `member_joined` trigger sites and reason strings.** As in the original — explicit `leaveRoom` is straightforward; inactivity GC and `joinPath`-on-reactivation need defined emission rules to avoid noise.
3. **Recipient resolution corner cases for `tt msg send <name>`.** Display-name collisions across active members, short prefixes, exact-match on `agent_id`, broadcast typo guards.
4. **Cursor persistence format for consumers.** Recommended: a per-agent cursor file under `~/.local/share/talking-stick`, written by the receive loop on each batch.
5. **Skill prose, in full.** Drafted in the implementation pass; reviewed before merge.
6. **Test plan.** At minimum: migration 5 on a populated v0.1.x DB; `payload_json` round-trip; `wait_for_events` filter correctness for each `event_type` × `target` combination; `wait_for_events` resume across cursor; `send_message` body cap rejection; `send_message` of a `message_sent` event interleaved with a `release_stick` event ordering; CLI recipient resolution (full id, display name, ambiguous, room-broadcast, unknown).

## Staged rollout

Each stage is independently shippable. **Stages 1–3 are v1; users have a fully working message pipe after stage 3 with no plugin work required.**

1. **Substrate.** Migration 5 + service `sendMessage` / `waitForEvents` + tests. No CLI/MCP yet. Proves the wire format and the observer-safety claim.
2. **MCP surface.** `send_message` and `wait_for_events` MCP tools. `get_room_events` returns `payload_json`. Agents using MCP-only harnesses (Codex, Gemini, OpenCode) can already send and explicitly poll messages between turns at this stage.
3. **CLI surface.** `tt msg send` / `tt msg recv --follow` / `tt events --follow`. Recipient resolution. Skill update §4.5. Documentation pass. **End of v1.** Claude Code can now do mid-tool-loop chat by spawning `tt msg recv --follow` under Monitor; humans and other harnesses get the same durable pipe via terminal/tmux plus explicit between-turn polling.
4. **Optional: presence event emission.** `member_joined` / `member_left` / `note_added` so consumers can follow presence and notes through the same stream. Decoupled — receivers not depending on these events keep working.
5. **Optional: per-harness plugins.** The Layer 6 consumer contract is already load-bearing for `tt msg recv --follow`; plugins become relevant when harness owners want richer ambient UX. None required for v1.
6. **Optional: per-recipient mute, message resolution, threading.** Only if real usage demonstrates need.
7. **Optional: server-side rate limit.** Only if the documented threshold is hit.

## What we are not building

- No write authority changes. Messages are signals, not commands.
- No automatic takeover on interrupt. Takeover stays gated on `claim_expires_at`.
- No harness-specific notification format. Consumers use the same events; harnesses decide UX.
- No event-driven replacement for `wait_for_turn`. Stick availability remains governed by the existing wait/claim path.
- No second event log or cursor. `event_seq` is the cursor; `payload_json` is the discriminator.
- No `to_agent_id` privacy. Routing only.
- No bundled per-harness plugin in the npm tarball for v1.

## Summary

The amendment narrows the protocol surface and delivers a working chat path via the CLI subprocess pattern in v1. Per-harness plugins are a future enhancement, not a prerequisite. The stable substrate is:

- One new column (`room_events.payload_json`).
- One new event type (`message_sent`, with optional `member_joined` / `member_left` / `note_added` follow-ups).
- One new write tool (`send_message`).
- One new read tool (`wait_for_events`) — observer-safe, no waiter-grace mutation.
- Three CLI commands (`tt msg send`, `tt msg recv`, `tt events --follow`). `tt msg recv --follow` is the v1 canonical agent-side receive path: spawn it as a child process and watch its stdout.
- One receive-consumer contract document for the CLI subprocess and for harness owners who later want richer UX than the CLI subprocess pattern delivers.

In v1 with no plugin: Claude Code chats mid-tool-loop via Monitor watching `tt msg recv --follow`. Codex, Gemini, OpenCode get the same message pipe immediately, but model-visible delivery is explicit polling or operator relay until those harnesses grow stdout-watch integration. Humans chat with bare CLI invocations. Plugins later add per-harness polish (statusline, mute, smarter routing) without changing the protocol.

Vignette H is the case the design exists for: two agents talking through a question while one of them holds the stick, no formal handoff per round-trip, full audit trail in the event log. Everything else is in service of that.
