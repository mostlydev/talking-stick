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
3. A `note_added` event arrives with severity `page` plus a capped body preview: *"You're editing session.ts but the bug is in token.ts — see line 84."*
4. Claude Code's harness surfaces the line to the user, who can choose to interrupt Codex or let it self-correct on next read of room notes.
5. Codex finishes, calls `release_stick`, picks up the note via existing `list_notes`, acknowledges, hands off.

Vignette B — join awareness mid-turn:

1. Claude Code holds the stick on a long refactor.
2. A human runs `tt join` from a second terminal to observe.
3. A `member_joined` event arrives on Claude's background watcher.
4. Claude's watcher rule says: *member_joined is informational, not an interrupt — write it to the boundary buffer, not the loud Monitor stream.*
5. At next handoff prep, Claude reads the buffered events and notes "Wojtek joined two minutes ago" in the handoff body.

Vignette C — operator pages the active holder:

1. The current holder is in the middle of a long edit.
2. The operator posts `tt notes add --severity page --target <holder> "Scope down: stop after the parser test passes."`
3. The holder's page channel emits one loud JSON line with the note id, author, severity, and capped preview.
4. The holder may act immediately or acknowledge at handoff. The page does not grant or revoke write authority.

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
- Event-driven stick claiming. `wait_for_turn` remains the authoritative wait/claim path in v1; using the event stream to wake waiters is deferred until wait intent is modeled explicitly.

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

The persisted `note_added` event carries metadata: `note_id`, `severity`, optional `target_agent_id`, and a capped `body_preview` for page delivery. The full body still lives in the `notes` table and is fetched via `list_notes`. This keeps persisted event payloads bounded while making a page line actionable without a second foreground tool call.

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

The new `--severity` and `--target` flags filter `note_added` events specifically. A guardian-style harness uses two logical channels:

```
# Page channel — loud. One line here means "interrupt the holder now."
tt events --follow --event note_added --severity page --target self

# Buffer channel — quiet. Write to a local cursor/log and read at the next safe boundary.
tt events --follow --event member_joined,member_left,note_added --severity info --target any
```

The distinction is not just severity in the JSON payload. Some harness glue, notably Claude Code's Monitor tool, treats *every stdout line* from a watched process as a conversation notification. Page output is suitable for that loud path. Buffer output is not; it should be drained into a local cursor/log and summarized by the foreground agent at handoff or another safe boundary.

### Wait pattern — not changed by this plan

This proposal does **not** replace `wait_for_turn` with event-stream notifications for stick availability.

The current queue mechanics rely on `wait_for_turn` as both the claim authority and the wait-intent heartbeat. In the service today, `wait_for_turn` updates `last_wait_at`, and normal `release_stick` only reserves the stick for a candidate whose wait is recent according to `waiterGraceMs`. A participant that probes once and then sleeps only on event lines for minutes can therefore change the normal reservation behavior.

The v1 skill should continue to teach direct `wait_for_turn` long-polls. A future event-driven wait helper can use the same event stream as an advisory wakeup channel, but it first needs an explicit wait-intent design, for example `waiting_since` / `wait_intent_expires_at` renewed by a helper. That follow-up helper would still run `wait_for_turn` to claim; event lines would be a bell, not the lock.

### Layer 4 — Harness-side: background process + stdout-line notification

The actual integration in Claude Code:

1. Foreground agent starts the page channel in the background and attaches Monitor to that process only.
2. Foreground agent starts the buffer channel separately, without Monitor, writing JSON lines plus the last seen `event_seq` to a local cursor/log.
3. Page lines are injected into the conversation immediately. Buffer lines are read deliberately at handoff prep or another safe boundary.
4. The agent still uses `wait_for_turn` for turn ownership; these channels are notification surfaces only.

Equivalents in other harnesses:

- **Codex** — spawn `tt events --follow` as a child process; map stdout lines to `attach` events on the active task. Same shape, different transport name.
- **OpenCode / Gemini** — long-poll via shell subprocess; whatever the harness calls "background output" is the right hook.
- **Plain shell (human operator)** — `tt events --follow | jq -c .` in a tmux pane.

The protocol does not need to know which harness is on the other end. The contract is: line in, notification out.

## Token-cost analysis

Concrete numbers, since this was the explicit question.

**Idle cost: zero.** A backgrounded `tt events --follow` is a child process. It consumes no model tokens while running. The harness keeps a process handle, not a context-window slot.

**Per-event cost: small and proportional.** Each page line that Monitor surfaces becomes a notification message in the conversation. A typical page line is on the order of 100–300 tokens with a capped body preview; each `member_joined` buffer line is under 80 tokens and should not enter the conversation until the agent chooses to summarize buffered context.

**Annual budget for a busy room:** at, say, 50 events per active hour (very high — typical rooms see far fewer), that is ~5 000 tokens per hour of room activity surfaced into the holder's context. By comparison, a single `get_room_state` call already costs several hundred tokens, and most agents call it on every turn. The watcher is cheap.

**Where it actually gets expensive:**

- If `note_added` events inline full bodies. Don't — keep full bodies in `list_notes`; page output gets only a capped preview.
- If watchers don't filter. A holder doesn't need its own `claim` events echoed back. Filter via `--event` and `--target`.
- If many idle agents all run watchers on the same room. The cost is per-agent-context, not per-room. With N agents, N watchers, N copies of each event in N contexts. Acceptable for small N (≤4 typical), worth revisiting if rooms grow.
- If the watcher is replaced with a polling loop that calls `get_room_events` every few seconds. That defeats the design — the foreground agent burns tokens making the polling decisions. The watcher's whole point is to push that decision to a child process and only spend tokens on actual events.

**On long-poll vs. push:** the watcher process can implement long-poll internally (block on SQLite for up to N seconds, emit on change, re-block). That makes the *process* efficient. But from the *foreground agent's* perspective, push and long-poll are identical — both surface as a stdout line when something happens. So the choice is a server-side performance question, not a token question. v1 can use a 1-second SQLite poll inside `tt events --follow` and still cost zero foreground tokens between events.

## Concrete surface changes

### Service / DB

1. Add `member_joined`, `member_left`, `note_added`, `note_resolved` to the `event_type` enum in `src/types.ts`. The SQLite `room_events.event_type` column is already free text, but migration 5 should add nullable metadata columns for note events: `note_id`, `severity`, `target_agent_id`, and `body_preview`.
2. `joinPath`, `leaveRoom`, `addNote` all call `appendEvent(...)` in their respective transactions. They already run inside the same transaction as the state mutation, so atomicity is free.
3. Add optional `severity: "info" | "page"` and `target_agent_id` columns to the `notes` table. Default severity `info`. Existing rows back-fill to `info`, no `target`.
4. New service method `resolveNote({ agent_id, room_id, note_id })` that flips `resolved_at` / `resolved_by_agent_id` and emits `note_resolved`. Optional for v1 but cheap.

### CLI

1. `tt notes add --severity page --target <agent_id> "body"` — pass-through of new fields.
2. `tt events --follow [--after N] [--event T,...] [--severity ...] [--target ...]` — per Layer 3. `--target self` requires participant identity; observer-only shells must use `--target any` or an explicit agent id.
3. `tt notes resolve <note_id>` — wraps `resolveNote`. Optional for v1.

### MCP

1. `add_note` tool gains optional `severity` and `target_agent_id` parameters.
2. `get_room_events` already accepts `after_event_seq` and `limit`; no signature change needed for the new event types — they are additive on the discriminated union.
3. New MCP tool `resolve_note` — optional for v1.

### Skill

The shipped `skills/talking-stick/SKILL.md` gets a section: *"While you hold the stick, you may receive `note_added` events with severity `page`. Read the page preview, call `list_notes` if you need the full body, decide whether to act now or at the next handoff boundary, and resolve it when addressed."* Include the mirror instruction for non-holders: *"To get the holder's attention without taking the stick, use `add_note` with severity `page`."*

The skill's wait guidance should remain direct `wait_for_turn` long-polling. Event-stream wakeups for stick availability are future work and require explicit wait-intent state before they can replace the current polling cadence.

## Tradeoffs and open questions

- **Why notes-with-severity instead of a separate `messages` primitive?** Notes already are durable, addressable, and resolvable. Adding two fields is cheaper than a parallel messaging table, and the harness-side UX is identical. The risk is conceptual creep: notes today are "things the holder should consider before handoff," and pages stretch that toward "things the holder must consider now." Worth naming explicitly so the skill reflects it.
- **Should `member_joined` be page-able by default?** No. Joins are too frequent (humans `cd` and out, harnesses restart). Default to `info`. A specific guardian setup can choose to elevate joins by spawning a second `tt events --follow --event member_joined` stream and rendering it loudly.
- **Heartbeat-stale and takeover-available as events.** Tempting — the watcher could fire one line when the current holder goes stale and another when takeover unlocks. But these are derived states, not log entries; if we synthesize them into the event stream we either need a separate "synthetic events" cursor or we mix derived and persisted events on the same `event_seq`. Recommendation for v1: do not synthesize. Agents that care should continue to long-poll `wait_for_turn`; a future event-driven wait helper can handle derived deadlines after wait intent is modeled explicitly.
- **Backpressure.** `tt events --follow` writes to stdout. If the harness Monitor stops draining (paused conversation, hit a tool error), the pipe will block. The watcher should use a small bounded write buffer and drop-with-warning rather than blocking forever; design parity with `tail -F`.
- **Authentication of `target_agent_id`.** Anyone in the room can post a note targeted at anyone else. That matches the existing notes contract (any member can post). If we ever need permissioning, it is a separate concern from this design.
- **Crash recovery.** Watcher process dies → harness restarts it with `--after <last_seen_event_seq>`. The harness must persist the last-seen seq across restarts; for Claude Code that means the agent writes it to a known location (a memory entry, or a `.talking-stick/` cursor file) before the watcher exits cleanly. Worth specifying in the skill.
- **Multiple watchers per harness.** Layer 4 suggests two logical streams (page channel + buffer channel). That can be two child processes per agent, or one wrapper process that routes output to separate destinations. The important invariant is routing: page can be Monitor-injected; buffer should not be.
- **Resolution semantics.** Does a `pass`/`release` auto-resolve outstanding pages? Probably not — the next holder may still need them. But we should mark them as "delivered to holder X at turn Y" so the page does not re-page on every turn. Either a `delivered_at` column on notes, or a per-turn dedup at the harness side. v1 recommendation: dedup at the harness side using `note_id`, no schema change.

## What this plan does NOT yet specify

This document is a design proposal for review, not an implementation specification. The following decisions are deliberately deferred to post-review so that reviewer pushback can shape them. Treat each as a real gap an implementer would hit on day one:

1. **Exact migration 5 DDL.** The repo already has a `schema_migrations` runner in `src/db.ts`. Implementation still needs the exact `ALTER TABLE` sequence for `notes` and `room_events`, plus downgrade expectations for older binaries that see unknown event types.
2. **`member_left` trigger sites.** Explicit `leaveRoom` is straightforward. Inactivity/GC is not: members can become inactive through liveness checks and opportunistic cleanup. Implementation must decide which transitions emit a durable `member_left`, which reason strings are valid (`"left"`, `"inactive"`, `"gc"`), and how to avoid repeated leave/reactivate noise.
3. **Skill prose, in full.** The "Skill" subsection above paraphrases the addition. The actual shipped skill text is what every harness reads on every relevant turn, so it needs to be drafted, reviewed, and kept as tight as the rest of `skills/talking-stick/SKILL.md`.
4. **Page dedup persistence.** The plan recommends harness-side dedup of pages by `note_id` plus a cursor file for crash recovery. But the dedup set itself is in-memory; after a watcher restart the dedup set is empty, and a still-unresolved page can re-fire on the next event from the buffered tail. Either the cursor file must persist the dedup set too, or the server must offer a "since last delivery to <agent_id>" filter. Pick one before relying on dedup.
5. **Test plan.** Not enumerated. At minimum: schema migration on a populated v0.1.x database, event ordering when `addNote` and `release_stick` race, filter correctness on `tt events --follow` for each `--event` / `--severity` / `--target` combination, resume-after-cursor with new event types interleaved with existing ones, and behavior when a watcher's stdout is blocked.

These are not blockers for the design discussion — they are inputs to the implementation pass. The architectural decision to keep stick waiting on `wait_for_turn` is intentional; event-driven waiting belongs in a separate wait-intent design.

## Staged rollout

1. **Schema + service:** add new event types, emit on `joinPath`/`leaveRoom`/`addNote`. No CLI/MCP changes yet. Watchers that already follow the event log start seeing the new events immediately.
2. **`tt events --follow` extended:** add `--severity` and `--target` filters. CLI tests for filter shape and resume-after-cursor.
3. **`add_note` severity + targeting:** schema change to `notes`, plumbed through service, CLI, MCP. Skill updated.
4. **Skill rewrite:** holder-side and watcher-side guidance, including page-vs-buffer routing and the reminder that `wait_for_turn` remains the ownership path.
5. **Optional: `resolve_note` + `note_resolved` event.** Lets pages stop re-paging across handoffs without harness-side dedup.
6. **Optional: derived-event synthesis** (`takeover_available`, `lease_stale`) as a follow-up document if observer demand justifies it.

## What we are not building

- No new transport. No websockets, no MCP resource subscriptions in v1 (see [ambient-presence.md](../ambient-presence.md) "Out of scope").
- No write authority changes. Pages are signals, not commands.
- No automatic takeover on page. Takeover stays a deliberate act gated on `claim_expires_at`.
- No harness-specific notification format. JSON lines in, harness decides how loud.
- No event-driven replacement for `wait_for_turn`. Stick availability remains governed by the existing wait/claim path until a separate wait-intent design exists.

## Summary

The talking stick already has the right primitives for *what* coordinates (rooms, leases, handoffs) and the right primitives for *who* coordinates (agent identity, membership). It is missing primitives for *what flows alongside the work in progress*. This proposal closes that gap with the minimum viable additions:

- Four new event types so the existing log carries presence and notes.
- Two new fields on notes so non-holders can distinguish a hint from a page.
- One existing CLI surface (`tt events --follow`) extended with two filter flags.
- A documented harness pattern (page channel + quiet buffer channel) that costs zero idle tokens and proportional per-event tokens.

Everything else — transports, write-authority changes, derived events, push channels — is deferred until the simple version is in use and we know what is actually missing.
