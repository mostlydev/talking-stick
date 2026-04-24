# Non-owner Notes

Status: design proposal, under review

## Problem

Today the only async channel between room members is the `handoff` attached to
`release_stick` / `pass_stick` / `takeover_stick`. A member who is NOT holding
the stick has no way to communicate observations to the current owner or to
successors:

- I see you're about to touch `src/service.ts:1400` — there's a subtle
  invariant there you might miss.
- While you were working I found a related bug in the linked repo.
- Heads-up: the CI pipeline for this repo rejects lowercase-only commit
  subjects; I just learned that the hard way.

These observations are real, actionable, and time-sensitive, but the only place
to put them today is in the *next* handoff — which means you have to wait for a
turn transition to say them. That discourages cooperation and pushes agents
toward either (a) interrupting via wait_for_turn contention, or (b) silent
parallel work that duplicates effort.

## Goal

Append-only notes scoped to a room, authored by any active member (owner or
not), readable by the current owner and by successors. Minimal API surface;
reuse the existing membership model for authorization.

## Non-goals (v1)

- Editing notes. Append-only.
- Threading / replies. Notes are flat.
- File attachments or rich payloads. Plain-text body with a size cap.
- Cross-room notes.
- Push transport / real-time notifications. Explicit reads only.

## Data model

New table `notes`, migration-added alongside the existing schema:

```sql
CREATE TABLE notes (
  note_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  turn_id INTEGER,
  author_agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_agent_id TEXT,
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id) ON DELETE CASCADE
);
CREATE INDEX notes_by_room ON notes (room_id, created_at);
```

- `turn_id` is **nullable**. If set, the note is advisory for that specific
  turn (e.g. "heads-up for whoever is working turn 7 right now"). If null, the
  note is room-scoped — always visible regardless of current turn.
- `resolved_at` / `resolved_by_agent_id` are optional and set by a future
  `resolve_note` RPC (stretch; not v1).
- Body is plain text. Cap at 16 KB at the service boundary. Longer content
  belongs in an artifact referenced by the handoff.

## RPC surface

Two new service methods:

### `addNote(input)`

```ts
interface AddNoteInput {
  agent_id: AgentId;         // must be an active room member
  room_id: string;
  body: string;              // non-empty, trimmed, max 16 KB
  turn_id?: number;          // optional; if set, must equal current turn_id
                             // or a closed historical turn_id for that room
}

interface AddNoteResult {
  note_id: string;
  room_id: string;
  turn_id: number | null;
  author_agent_id: AgentId;
  created_at: string;
}
```

Authorization:
- `agent_id` must be an active member of the room. Enforced via the same
  membership table already used for `wait_for_turn` / `heartbeat`.
- The owner CAN author notes (self-notes are useful for "remember for next
  turn") — no role check beyond membership.
- Closed rooms reject new notes with a `room_closed` protocol error.

Validation:
- `body` non-empty after trim.
- `body` length ≤ 16 384 bytes.
- If `turn_id` is provided, it must be ≤ the current `room.turn_id`. Future
  turn_ids are rejected (`invalid_turn_id`).

### `listNotes(input)`

```ts
interface ListNotesInput {
  agent_id?: AgentId;        // optional; refreshes last_seen_at if a member
  room_id: string;
  after_note_id?: string;    // pagination cursor — return notes with
                             // created_at strictly greater than the cursor's
  include_resolved?: boolean; // default false
  limit?: number;            // default 50, max 200
}

interface ListNotesResult {
  notes: Note[];
}

interface Note {
  note_id: string;
  room_id: string;
  turn_id: number | null;
  author_agent_id: AgentId;
  body: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_agent_id: AgentId | null;
}
```

- Returns notes ordered by `created_at` ascending, then `note_id` as a
  tiebreaker.
- Non-member callers are allowed to read (matches the existing permissive read
  model for `get_room_state` / `get_room_events`) but do not get a presence
  refresh.
- `include_resolved` defaults to false to keep the default view clean. Set to
  true to audit.

### `resolve_note` — stretch, NOT v1

Defer. A simple "mark handled" flag is useful but not necessary for the first
slice. If included later, body stays immutable; only `resolved_at` and
`resolved_by_agent_id` are set.

## MCP tool surface

Two new tools in `src/mcp-server.ts`:

- `add_note` — maps to `addNote`, derives `agent_id` from MCP caller identity
  (same pattern as `wait_for_turn`).
- `list_notes` — maps to `listNotes`, derives `agent_id` for presence refresh.

No changes to any existing tool's schema.

## CLI surface

Three subcommands under a new `tt notes` namespace:

```
tt notes add <body>          # body via positional; if absent, read from stdin
tt notes add --turn <N> ...  # explicitly target a turn
tt notes list                # list unresolved notes for the current room
tt notes list --all          # include resolved
tt notes list --json         # machine format
```

Identity resolved via the existing `deriveCliIdentity` chain. Room derived
from the current working directory (same as `tt join` / `tt wait`).

Text output for `tt notes list`:

```
<note_id_short>  <author>  <created_at>  turn=<n|-->  <body-first-line>
```

Full body shown in JSON mode only, or via `tt notes get <note_id>` (also
stretch).

## Interaction with `wait_for_turn`

Out of scope for v1. Codex asked whether an unread-count hint should piggyback
on `wait_for_turn` responses. My read: skip for v1. Rationale:

- `wait_for_turn` is on the hot path and is long-polled. Every field we add is
  evaluated per-call and widens the contract.
- Owners can run `tt notes` once at turn start, or the skill can be updated
  to recommend it after `your_turn`.
- If telemetry shows owners systematically missing notes, we can add a cheap
  `unread_notes_count: number` field to `your_turn` in a future slice without
  a wire break.

## Security / boundaries

- Only active members can author notes.
- Anyone can read (matches the existing permissive read model for room state).
- Closed rooms accept no new notes; existing notes remain readable.
- Room deletion (via future admin path, not yet implemented) cascades to
  notes.
- No content filtering beyond length. Agents can write whatever they want; it
  is plain text.

## Tests

Service-level (in `tests/talking-stick.test.ts` or a new `tests/notes.test.ts`):

1. Active member can add a note while another member holds the stick.
2. Non-member cannot add a note (`not_a_member` protocol error).
3. Owner can add a self-note while holding the stick.
4. `body` empty after trim rejected (`invalid_body`).
5. `body` over 16 KB rejected (`body_too_large`).
6. `turn_id` greater than current rejected (`invalid_turn_id`).
7. `turn_id` null persists as null and is returned as null on read.
8. `listNotes` returns notes in `created_at` ascending order across multiple
   authors.
9. `listNotes` honors `after_note_id` for pagination.
10. `listNotes` with `include_resolved: false` skips resolved notes (even
    before the resolve RPC exists, test by direct DB fixture or a manually
    inserted row with `resolved_at` set).
11. Closed room rejects new notes (`room_closed`).
12. Presence refresh: `listNotes` called with `agent_id` of a joined member
    updates `last_seen_at`; without `agent_id` it does not.

MCP-smoke:

13. `add_note` / `list_notes` round-trip through the MCP adapter with
    derived identity.

CLI:

14. `tt notes add "hello"` adds a note attributed to the derived identity for
    the current room.
15. `tt notes list --json` returns the expected shape.

## Open questions

1. **Body size cap.** 16 KB is a soft guess. Too small means notes can't hold
   a stack trace; too big invites abuse. I would ship 16 KB and widen if
   asked. Alternative: 8 KB body + optional `artifacts` array (mirroring
   Handoff artifacts) for pointer payloads. Defer artifacts to v2 unless you
   see an immediate need.

2. **Visibility of old turn-scoped notes.** A note scoped to `turn_id = 5` is
   still returned by `listNotes` after the room moves on. Expected? My read:
   yes, because the UI filter is the reader's job. The `turn_id` column tells
   the reader whether the note is historical.

3. **Who can resolve (future).** Stretch question, but deciding now would keep
   the API forward-compatible. My proposal: only the author or the current
   owner can resolve a note. That matches the stick/membership authority
   model.

4. **Event log integration.** Should `add_note` append to the `room_events`
   log as an `event_type = "note"`? Benefit: single audit stream. Downside:
   notes can be chatty, and the event log is currently about turn transitions
   only. My default: keep them separate. The `notes` table IS the audit log
   for notes.

5. **Migration ordering.** New migration has to land before any RPC is
   added. Straightforward additive migration to `src/db.ts`. No back-fill.

## Build sequence

1. Migration + `notes` table in `src/db.ts`.
2. `addNote` / `listNotes` in `src/service.ts`, with membership check via the
   existing `touchMember` infrastructure.
3. Types + commands layer (`src/types.ts`, `src/commands.ts`) exposing the
   new RPCs; reuse the `agent_id?` read pattern for `listNotes`.
4. MCP tools in `src/mcp-server.ts` — derive identity the same way
   `wait_for_turn` does.
5. CLI subcommand `tt notes` in `src/cli.ts`, identity via
   `deriveCliIdentity`, room via `deriveCliRoomForContext`.
6. Tests 1-15 above.
7. Update `README.md` "What it gives your agent" section to mention
   `add_note` / `list_notes`.
8. Update `skills/talking-stick/SKILL.md` with a short section on when to
   leave a note instead of waiting for a turn.

Estimated size: small-to-medium. The database and service layers are the
bulk; the MCP / CLI / skill plumbing is short once the shape is fixed.
