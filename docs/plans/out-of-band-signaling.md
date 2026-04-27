# Out-of-Band Signaling Between Harnesses

**Status:** Design proposal — not yet scheduled. Intended for cross-harness review (Codex + Claude Code).
**Related:** [ambient-presence.md](../ambient-presence.md), [talking-stick-plan.md](../talking-stick-plan.md)

## Purpose

The talking stick today enforces **in-band, single-speaker** coordination: the holder is the only participant whose work actually mutates the workspace, and other participants either wait or observe. That is correct for write authority. It is too restrictive for *signaling*.

There are real situations where a non-holder needs to reach the holder — or needs to be reached — *without* taking the stick:

- The non-holder is watching the holder's work and notices a problem (wrong file, broken assumption, looming merge conflict). It should be able to say so without forcing a takeover.
- A new participant joins the room mid-turn. The holder may want to greet, hand off, or just acknowledge. Today the holder finds out only when they next call `get_room_state`.
- An operator drops a note ("we're scoping down — stop after the test passes"). The holder should see it before the next handoff boundary.
- The watcher itself is an LLM ("guardian") spawned to keep the holder honest; its only job is to tail the room and raise its hand on specific conditions.

This document proposes the smallest primitive set that lets harnesses exchange these signals over the existing room-event log, plus the harness-side glue (background watcher + stdout-line notification) that makes them feel ambient instead of poll-driven.

It is a layer on top of [ambient-presence.md](../ambient-presence.md). Where ambient-presence proposes `tt events --follow` as a one-way *observer* stream for waiting agents, this document extends the same stream to be the channel for *directed* signals into an active turn, and defines what those signals look like.

## Vision

Vignette A — guardian catches a wrong turn:

1. Codex holds the stick, working on `src/auth/session.ts`.
2. Claude Code runs `tt events --follow` in the background under its Monitor tool. It is observer-only on the room.
3. A `note_added` event arrives with severity `page` and body *"You're editing session.ts but the bug is in token.ts — see line 84."*
4. Claude Code's harness surfaces the line to the user, who can choose to interrupt Codex or let it self-correct on next read of room notes.
5. Codex finishes, calls `release_stick`, picks up the note via existing `list_notes`, acknowledges, hands off.

Vignette B — join awareness mid-turn:

1. Claude Code holds the stick on a long refactor.
2. A human runs `tt join` from a second terminal to observe.
3. A `member_joined` event arrives on Claude's background watcher.
4. Claude's watcher rule says: *member_joined is informational, not an interrupt — buffer until next safe boundary.*
5. At next handoff prep, Claude reads the buffered events and notes "Wojtek joined two minutes ago" in the handoff body.

Vignette C — takeover-available paged to operator:

1. The current holder has gone silent (lease stale).
2. The watcher sees `takeover_available` synthesized from a stale `claim`.
3. The watcher's tier-rule says: page the operator's terminal but do not auto-takeover — that remains a deliberate act per [ambient-presence.md](../ambient-presence.md) and the existing protocol.

## Scope

In scope:

- Extending the `RoomEvent` taxonomy so the existing `event_seq` log carries presence and notes, not just stick mutations.
- Defining a "page" semantic on top of notes so harnesses can distinguish *interrupt-worthy* from *buffer-until-boundary*.
- Specifying the stdout-line watcher contract that lets a harness convert events into harness-native notifications.
- Quantifying the token cost of running such a watcher continuously.

Explicitly out of scope:

- Any new write authority for non-holders. Notes/pages do not grant the stick. Takeover remains the only way to seize write authority and is unchanged.
- A second event log, second cursor concept, or second identity model. Everything reuses `event_seq`, `agent_id`, and the existing room-resolution rules.
- Push transports (websockets, MCP resource subscriptions). Pull-based long-poll over SQLite is sufficient for v1; see *Tradeoffs*.
- Any harness-specific notification format. Output is JSON lines; each harness maps lines to its own notification system.

## Architecture

Four layers, building on what exists.

### Layer 1 — Extended event taxonomy

Today `RoomEvent.event_type` is `"claim" | "release" | "pass" | "takeover" | "close"`. Notes (`addNote`) live in a separate `notes` table and emit nothing into `room_events`. Member join/leave does not emit events at all. That means the long-poll stream has nothing to say about anything except stick handoffs.

Proposed additions to `event_type`:

| New event         | Emitted when                                       | Fields beyond the common ones                  |
|-------------------|----------------------------------------------------|------------------------------------------------|
| `member_joined`   | `joinPath` adds a member or reactivates one        | `to_agent_id` = joiner                         |
| `member_left`     | `leaveRoom` succeeds, or a member is GC'd inactive | `from_agent_id` = leaver, `reason`             |
| `note_added`      | `addNote` succeeds                                 | `note_id`, `severity`, `target_agent_id?`      |
| `note_resolved`   | A future `resolve_note` (or implicit on takeover)  | `note_id`                                      |

Rationale for putting notes into the event log rather than inventing a parallel notes-stream:

- Single cursor. Watchers already need `event_seq` to resume after disconnect; folding notes in means no second cursor and no race between two streams.
- Replay parity. Rebuilding room state from the event log already requires reading every mutation; adding notes to that stream means a fresh observer can reconstruct "what does the holder need to know?" without a second query.
- Audit shape. The event log is append-only and ordered. Notes already are too. The shapes match.

The `note_added` event carries only the metadata — `note_id`, `severity`, optional `target_agent_id`. The full body still lives in the `notes` table and is fetched via `list_notes`. This keeps event payloads small and lets watchers decide whether the body is worth pulling per-event.

### Layer 2 — Note severity and targeting

Notes today are flat: any member can post one, the holder reads them at handoff boundaries. To support out-of-band signaling we add two optional fields on `AddNoteInput`:

```ts
interface AddNoteInput {
  agent_id: AgentId;
  room_id: string;
  body: string;
  turn_id?: number;
  severity?: "info" | "page";        // NEW — defaults to "info"
  target_agent_id?: AgentId;          // NEW — null/undefined = whole room
}
```

Semantics:

- `severity: "info"` (default) — buffer until the recipient's next safe boundary. Watchers should NOT interrupt the active turn for these.
- `severity: "page"` — recipient's watcher SHOULD interrupt the active turn. Use sparingly. The protocol does not enforce attention; it provides the signal and lets the receiving harness decide.
- `target_agent_id` — addresses a specific member. If absent, the note is room-wide. The current holder is implicitly a target for any unaddressed page.

The protocol does **not** define what "interrupt" means in any specific harness. That is each harness's call. The protocol guarantees only: the event arrives, the severity is preserved, and the cursor advances.

### Layer 3 — `tt events --follow` as the harness channel

Already proposed in [ambient-presence.md](../ambient-presence.md) §`tt events --follow`. We adopt it verbatim and extend it with the new event types. Restating the contract for completeness:

```
tt events [path] --follow
              [--after <event_seq>]
              [--event <type[,type...]>]
              [--severity info|page]
              [--target self|any|<agent_id>]
              [--json|--pretty]
```

Stdout: one JSON object per line, one event per line, flushed after each write. Stderr: diagnostics only. Exit on `SIGTERM`/`SIGHUP` with a final flush.

The new `--severity` and `--target` flags filter `note_added` events specifically. A guardian-style watcher might run two streams in parallel:

```
# Tier 1 — interrupts. One line here means "page the user now."
tt events --follow --event note_added --severity page --target self

# Tier 2 — buffer. Surfaced at the next safe boundary.
tt events --follow --event member_joined,member_left,note_added --severity info
```

Why two streams instead of one with severity in the payload? Because the harness-side glue (Claude Code's Monitor tool, equivalents elsewhere) treats *every line* of a watched stream as a notification. Putting interrupts on their own stream lets the harness route them to a louder channel without parsing every line of the buffer stream first.

### Layer 4 — Harness-side: background process + stdout-line notification

The actual integration in Claude Code:

1. Foreground agent calls `Bash(command="tt events ...", run_in_background=true)`.
2. Foreground agent calls `Monitor(<bash_id>)`. Monitor surfaces each new stdout line as a notification injected into the conversation.
3. Foreground agent reads the notification, decides per its instructions whether to act (page → interrupt user) or buffer (info → remember for next handoff).

Equivalents in other harnesses:

- **Codex** — spawn `tt events --follow` as a child process; map stdout lines to `attach` events on the active task. Same shape, different transport name.
- **OpenCode / Gemini** — long-poll via shell subprocess; whatever the harness calls "background output" is the right hook.
- **Plain shell (human operator)** — `tt events --follow | jq -c .` in a tmux pane.

The protocol does not need to know which harness is on the other end. The contract is: line in, notification out.

## Token-cost analysis

Concrete numbers, since this was the explicit question.

**Idle cost: zero.** A backgrounded `tt events --follow` is a child process. It consumes no model tokens while running. The harness keeps a process handle, not a context-window slot.

**Per-event cost: small and proportional.** Each stdout line that Monitor surfaces becomes a notification message in the conversation. A typical event line is on the order of 100–300 tokens depending on whether the body is inlined. With the structure above (event log carries metadata only; bodies fetched on demand), each `note_added` line is closer to 100 tokens, each `member_joined` line under 80.

**Annual budget for a busy room:** at, say, 50 events per active hour (very high — typical rooms see far fewer), that is ~5 000 tokens per hour of room activity surfaced into the holder's context. By comparison, a single `get_room_state` call already costs several hundred tokens, and most agents call it on every turn. The watcher is cheap.

**Where it actually gets expensive:**

- If `note_added` events inline full bodies. Don't — keep bodies in `list_notes`.
- If watchers don't filter. A holder doesn't need its own `claim` events echoed back. Filter via `--event` and `--target`.
- If many idle agents all run watchers on the same room. The cost is per-agent-context, not per-room. With N agents, N watchers, N copies of each event in N contexts. Acceptable for small N (≤4 typical), worth revisiting if rooms grow.
- If the watcher is replaced with a polling loop that calls `get_room_events` every few seconds. That defeats the design — the foreground agent burns tokens making the polling decisions. The watcher's whole point is to push that decision to a child process and only spend tokens on actual events.

**On long-poll vs. push:** the watcher process can implement long-poll internally (block on SQLite for up to N seconds, emit on change, re-block). That makes the *process* efficient. But from the *foreground agent's* perspective, push and long-poll are identical — both surface as a stdout line when something happens. So the choice is a server-side performance question, not a token question. v1 can use a 1-second SQLite poll inside `tt events --follow` and still cost zero foreground tokens between events.

## Concrete surface changes

### Service / DB

1. Add `member_joined`, `member_left`, `note_added`, `note_resolved` to the `event_type` enum in `src/types.ts` and in the SQLite `room_events` schema (column is already a free-text string in SQLite, but the TypeScript discriminated union must be extended; runtime guards in `mapEvent` need updates).
2. `joinPath`, `leaveRoom`, `addNote` all call `appendEvent(...)` in their respective transactions. They already run inside the same transaction as the state mutation, so atomicity is free.
3. Add optional `severity: "info" | "page"` and `target_agent_id` columns to the `notes` table. Default severity `info`. Existing rows back-fill to `info`, no `target`.
4. New service method `resolveNote({ agent_id, room_id, note_id })` that flips `resolved_at` / `resolved_by_agent_id` and emits `note_resolved`. Optional for v1 but cheap.

### CLI

1. `tt notes add --severity page --target <agent_id> "body"` — pass-through of new fields.
2. `tt events --follow [--after N] [--event T,...] [--severity ...] [--target ...]` — per Layer 3.
3. `tt notes resolve <note_id>` — wraps `resolveNote`. Optional for v1.

### MCP

1. `add_note` tool gains optional `severity` and `target_agent_id` parameters.
2. `get_room_events` already accepts `after_event_seq` and `limit`; no signature change needed for the new event types — they are additive on the discriminated union.
3. New MCP tool `resolve_note` — optional for v1.

### Skill

The shipped `skills/talking-stick/SKILL.md` gets a section: *"While you hold the stick, you may receive `note_added` events with severity `page`. Read them with `list_notes`, decide whether to act now or at the next handoff boundary, and resolve them when addressed."* Include the mirror instruction for non-holders: *"To get the holder's attention without taking the stick, use `add_note` with severity `page`."*

## Tradeoffs and open questions

- **Why notes-with-severity instead of a separate `messages` primitive?** Notes already are durable, addressable, and resolvable. Adding two fields is cheaper than a parallel messaging table, and the harness-side UX is identical. The risk is conceptual creep: notes today are "things the holder should consider before handoff," and pages stretch that toward "things the holder must consider now." Worth naming explicitly so the skill reflects it.
- **Should `member_joined` be page-able by default?** No. Joins are too frequent (humans `cd` and out, harnesses restart). Default to `info`. A specific guardian setup can choose to elevate joins by spawning a second `tt events --follow --event member_joined` stream and rendering it loudly.
- **Heartbeat-stale and takeover-available as events.** Tempting — the watcher could fire one line when the current holder goes stale and another when takeover unlocks. But these are derived states, not log entries; if we synthesize them into the event stream we either need a separate "synthetic events" cursor or we mix derived and persisted events on the same `event_seq`. Recommendation for v1: do not synthesize. Watchers that care can long-poll `wait_for_turn` in parallel — it already returns `takeover_available`. A future `tt events --follow --derived` flag could synthesize cleanly.
- **Backpressure.** `tt events --follow` writes to stdout. If the harness Monitor stops draining (paused conversation, hit a tool error), the pipe will block. The watcher should use a small bounded write buffer and drop-with-warning rather than blocking forever; design parity with `tail -F`.
- **Authentication of `target_agent_id`.** Anyone in the room can post a note targeted at anyone else. That matches the existing notes contract (any member can post). If we ever need permissioning, it is a separate concern from this design.
- **Crash recovery.** Watcher process dies → harness restarts it with `--after <last_seen_event_seq>`. The harness must persist the last-seen seq across restarts; for Claude Code that means the agent writes it to a known location (a memory entry, or a `.talking-stick/` cursor file) before the watcher exits cleanly. Worth specifying in the skill.
- **Multiple watchers per harness.** Layer 4 suggests two parallel streams (page tier + buffer tier). That is two child processes per agent. Acceptable; combine into one if it ever becomes a constraint.
- **Resolution semantics.** Does a `pass`/`release` auto-resolve outstanding pages? Probably not — the next holder may still need them. But we should mark them as "delivered to holder X at turn Y" so the page does not re-page on every turn. Either a `delivered_at` column on notes, or a per-turn dedup at the harness side. v1 recommendation: dedup at the harness side using `note_id`, no schema change.

## Staged rollout

1. **Schema + service:** add new event types, emit on `joinPath`/`leaveRoom`/`addNote`. No CLI/MCP changes yet. Watchers that already follow the event log start seeing the new events immediately.
2. **`tt events --follow` extended:** add `--severity` and `--target` filters. CLI tests for filter shape and resume-after-cursor.
3. **`add_note` severity + targeting:** schema change to `notes`, plumbed through service, CLI, MCP. Skill updated.
4. **Skill rewrite:** holder-side and watcher-side guidance, including the "two-stream" pattern for harnesses with stdout-line notification.
5. **Optional: `resolve_note` + `note_resolved` event.** Lets pages stop re-paging across handoffs without harness-side dedup.
6. **Optional: derived-event synthesis** (`takeover_available`, `lease_stale`) as a follow-up document if observer demand justifies it.

## What we are not building

- No new transport. No websockets, no MCP resource subscriptions in v1 (see [ambient-presence.md](../ambient-presence.md) "Out of scope").
- No write authority changes. Pages are signals, not commands.
- No automatic takeover on page. Takeover stays a deliberate act gated on `claim_expires_at`.
- No harness-specific notification format. JSON lines in, harness decides how loud.

## Summary

The talking stick already has the right primitives for *what* coordinates (rooms, leases, handoffs) and the right primitives for *who* coordinates (agent identity, membership). It is missing primitives for *what flows alongside the work in progress*. This proposal closes that gap with the minimum viable additions:

- Four new event types so the existing log carries presence and notes.
- Two new fields on notes so non-holders can distinguish a hint from a page.
- One existing CLI surface (`tt events --follow`) extended with two filter flags.
- A documented harness pattern (background process + stdout-line notification) that costs zero idle tokens and proportional per-event tokens.

Everything else — transports, write-authority changes, derived events, push channels — is deferred until the simple version is in use and we know what is actually missing.
