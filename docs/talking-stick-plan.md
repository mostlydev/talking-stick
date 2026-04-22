# Talking Stick MCP Coordination Plan

## Purpose

Talking Stick is an MCP server that lets multiple agent harnesses coordinate work in a shared workspace without accidentally performing parallel work and without re-deriving context on every turn.

The core metaphor is simple:

- A workspace maps to a coordination room.
- Agents join the room by operating in a path that resolves to it.
- Exactly one agent may hold the talking stick for that room at a time.
- The holder may work, release the stick to the next agent in sequence, or explicitly pass it to a specific agent.
- Passing or releasing the stick requires a structured handoff. The handoff carries what was done, what remains, and where to look — so the next agent does not have to rediscover context.
- Round fairness ensures no agent holds twice in a round until every other active member has had a turn.
- If the expected agent fails to respond, another active member may take over after a timeout, subject to fairness.

The goal is not a general chat system. The goal is a small, fault-tolerant coordination primitive that also serves as shared working memory for planning, code review, task handoff, and multi-agent turn-taking.

## Design Goals

- Resolve coordination scope by walking up the directory tree, matching how developers already think about workspaces (git, `CLAUDE.md`, `package.json`).
- Support multiple concurrent conversations at the same path via optional topics.
- Make the handoff between agents the primary state transfer, not an afterthought.
- Enforce fair turn-taking so no agent monopolizes the room, even under failure.
- Work safely when multiple MCP server processes run concurrently (multiple terminal tabs, split views, parallel sessions).
- Store state in platform-conventional user data directories rather than littering the home directory with dotfiles.
- Recover cleanly when an agent crashes, times out, or stops polling.
- Keep the MCP surface small enough that harnesses can follow it reliably.
- Make stale writes impossible with fencing tokens and turn numbers.
- Prefer explicit state transitions over hidden automatic behavior.

## Non-Goals

- Not a replacement for git, issue trackers, or durable project documentation.
- Not a general-purpose pub/sub bus.
- Does not merge simultaneous edits from multiple agents.
- Does not guarantee that an agent follows instructions outside the protocol. It only makes protocol-compliant coordination safe.
- Does not coordinate across hosts. Single-host only in the MVP.

## Core Concepts

### Path Room and Hierarchical Resolution

A path room is the coordination scope for a workspace. Rooms are identified by the tuple `(canonical_path, topic)`, with `topic` defaulting to the empty string.

Room resolution uses **deepest-ancestor lookup**:

> Given a request path `P` and requested `topic`, find the deepest ancestor of `P` (including `P` itself) that already has a room with the requested topic. That is the resolved room. If no ancestor has a matching room, a new room may be created rooted at `P`.

This rule intentionally mirrors how `git`, `CLAUDE.md`, `package.json`, and similar workspace markers are discovered. An agent joining at `/repo/packages/foo/src/` while `/repo/` has an active room joins the `/repo/` room without creating a new one. Agents working in sibling subtrees of the same repo automatically coordinate through the repo-rooted room, which matches developer intuition.

Canonicalization applied before ancestor lookup:

- Resolve symlinks.
- Normalize path separators.
- Normalize casing on case-insensitive filesystems.

**Nesting and conflict.** Creating a room at a path that already lies inside an existing room requires explicit opt-in via `force_new = true`. The default behavior is to join the ancestor. Because talking-stick coordination is operator-initiated, this default is safe: operators know when they are starting a nested conversation and can request one explicitly.

### Topics

A topic is an optional discriminator that allows multiple concurrent rooms at the same path. The default topic is the empty string, which represents "the" room for that path.

Topics exist so that unrelated efforts in the same workspace can coordinate independently — for example, a `review` room and a `triage` room at the same repo root. Topics are discoverable via `list_rooms` before joining, so an agent does not need to guess whether a topic exists or collide with one accidentally.

### Agent Identity

Each harness must present a stable `agent_id`.

The ID should identify the running harness instance, not just the product name:

```text
codex:terminal-1
claude:session-2026-04-22-a
reviewer:model-x:pid-12345
```

A server may also track an optional display name, model name, process metadata, and capabilities, but the protocol only requires `agent_id`.

### Membership Sequence

When an agent joins a room, the server appends it to the room's ordered member list if not already present. This order defines the default turn sequence.

```text
A joins
B joins
C joins

Default sequence: A -> B -> C -> A
```

An owner can follow this sequence by releasing the stick. An owner can skip the sequence by explicitly passing to a chosen agent.

### Ownership

At most one agent owns the stick for a room at any time.

Only the owner may perform owner actions:

- `heartbeat`
- `release_stick`
- `pass_stick`
- `close_room`

Every owner action must include:

- `lease_id`
- `expected_turn_id`

These values are fencing tokens. Old actions from stale agents must be rejected.

### Turn ID Semantics

`turn_id` identifies the current ownership epoch. It increments only when an agent is granted ownership:

- an idle room is claimed,
- a reserved recipient claims the stick,
- a timeout takeover succeeds.

`release_stick` and `pass_stick` end the current ownership epoch and invalidate the current lease, but they do not grant ownership to the next agent by themselves. They create a pending reservation that the next eligible agent must claim.

### Round Fairness

A **round** is a span of turns during which each active member holds the stick at most once. Round scoping exists to prevent an agent from monopolizing the room, particularly across takeover edge cases.

Rules:

- Each room tracks `current_round_started_at_turn_id`.
- Each member tracks `last_held_turn_id` (0 if never held).
- A member has "already held this round" iff `last_held_turn_id >= current_round_started_at_turn_id`.
- When an agent is granted ownership, their `last_held_turn_id` is set to the new `turn_id`.
- When a grant would happen and every active member has already held this round, the round resets first: `current_round_started_at_turn_id` advances to the new `turn_id` before the grant.

Eligibility implications:

- **Open claim on `idle` room.** Only members who have not yet held in the current round may claim. If every active member has already held, the round resets immediately and any active member may claim.
- **Reserved claim.** Unchanged — only the reserved recipient may claim. `release_stick` always sets `reserved_for` to a member who has not yet held in the current round, if one exists.
- **Takeover after claim timeout.** Allowed only for members who have not yet held in the current round, excluding the recipient who missed. If no such member exists, the round resets and any active member except the missed recipient may take over.
- **Takeover after owner lease timeout.** Allowed only for members who have not yet held in the current round, excluding the stale owner. If no such member exists, the round resets and any active member except the stale owner may take over.
- **Explicit pass.** The owner may pass to any agent regardless of whether that agent has already held this round. An explicit pass is a deliberate choice and is not subject to the fairness rule.

Edge cases:

- **New member joins mid-round.** The new member has `last_held_turn_id = 0 < current_round_started_at_turn_id`, so they are eligible for the remainder of the round and round completion waits for them.
- **Member leaves mid-round.** Round completion is recomputed against the current active set; departing members no longer delay reset.
- **Single active member.** Fairness is vacuous; each turn resets the round.
- **Two active members, one misses.** If A holds, releases to B, and B misses claim_ttl, strict fairness would deny A from taking over. Because B is the only unheld member and is also the missed recipient, the round resets and A is allowed to continue rather than deadlocking.

### Handoff Artifact

A handoff is the structured payload produced when an agent releases or passes the stick. It is the protocol's primary state-transfer mechanism.

```ts
interface Handoff {
  // Required. Ensures state transfer is never empty.
  status: string;         // what I did, what I learned, what is unfinished
  next_action: string;    // what the recipient should do

  // Optional. Reduces context re-derivation for the recipient.
  artifacts?: Array<{
    path: string;                    // absolute or workspace-relative
    lines?: [number, number];        // inclusive line range
    role: "examine" | "review" | "edit" | "context" | "output";
    note?: string;
  }>;

  // Optional.
  open_questions?: string[];
  do_not?: string[];                 // off-limits for the next agent
}
```

The server validates that `status` and `next_action` are non-empty before accepting a `release_stick` or `pass_stick`. This makes "pass without doing anything" mechanically impossible.

`artifacts[]` entries give the recipient direct pointers — path plus optional line range — so a new owner can load exactly the relevant code without re-exploring the workspace. This is the primary mechanism the protocol uses to reduce prompt-context churn across agents.

The handoff is stored verbatim in the event log and returned to the recipient by `wait_for_turn` when they claim the stick.

## Room State

```ts
type RoomState =
  | "idle"
  | "owned"
  | "reserved"
  | "stale_owner"
  | "closed";

interface PathRoom {
  room_id: string;                            // server-generated
  canonical_path: string;
  topic: string;                              // "" if no topic

  members: AgentId[];
  sequence_index: number;

  owner: AgentId | null;
  reserved_for: AgentId | null;

  turn_id: number;
  current_round_started_at_turn_id: number;   // for round fairness
  lease_id: string | null;
  lease_expires_at: string | null;
  claim_expires_at: string | null;

  state: RoomState;
  updated_at: string;
}

interface RoomMember {
  agent_id: AgentId;
  ordinal: number;
  joined_at: string;
  last_seen_at: string;
  last_held_turn_id: number;                  // 0 if never held
  status: "active" | "inactive";
}
```

State meanings:

- `idle`: no current owner and no specific reserved recipient.
- `owned`: one agent has a live lease and may work.
- `reserved`: the stick has been released or passed to a specific agent, which has a limited time to claim it.
- `stale_owner`: the previous owner missed its lease heartbeat and the room requires recovery.
- `closed`: no further turns are expected.

## Default Lifecycle

### Discover

An agent enumerates rooms reachable from a path:

```ts
list_rooms({ context_path? }) -> Room[]
```

Rooms are returned for the ancestor chain of `context_path`, keyed by `room_id` and annotated with `canonical_path`, `topic`, and current state. This lets a harness show "here is what is happening in this workspace" in one call.

### Join

```ts
join_path({
  agent_id,
  context_path,
  topic?,           // defaults to ""
  force_new?        // defaults to false
})
```

Resolution:

1. Canonicalize `context_path`.
2. Walk up the ancestor chain looking for an existing room with the requested `topic`.
3. If found and `force_new = false`: join that room.
4. If found and `force_new = true`: create a new room at the resolved canonical path, returning a warning that a parent room exists.
5. If not found: create a new room at the resolved canonical path.

The response includes the resolved `room_id`, the `canonical_path` and `topic` the agent actually joined (which may differ from what was requested when ancestor lookup redirected the call), and a `handoff_template` hint describing the expected handoff shape.

Effects:

- Adds `agent_id` to the ordered member list if absent, with `last_held_turn_id = 0`.
- Updates the agent presence timestamp.
- Returns the current room state.

### Wait

```ts
wait_for_turn({
  agent_id,
  room_id,
  cursor?,
  max_wait_ms?
})
```

Possible results:

```ts
type WaitForTurnResult =
  | {
      status: "your_turn";
      room_id: string;
      turn_id: number;
      lease_id: string;
      handoff: Handoff | null;       // null only for the first open claim in a fresh room
      from_agent_id: AgentId | null;
      reason: "direct_pass" | "sequence" | "open_claim" | "takeover";
    }
  | {
      status: "not_yet";
      cursor: string;
      room_state: RoomState;
    }
  | {
      status: "closed";
      room_id: string;
    };
```

`wait_for_turn` may claim the stick when the caller is eligible under the rules in Round Fairness above.

When a claim succeeds, the server atomically:

- increments `turn_id`,
- advances `current_round_started_at_turn_id` if the round would otherwise have no eligible members,
- issues a new `lease_id`,
- sets `owner = agent_id`,
- sets the claiming agent's `last_held_turn_id = new turn_id`,
- clears `reserved_for`,
- sets `lease_expires_at`,
- appends a claim event,
- returns `your_turn` with the prior handoff attached.

### Work

While holding the stick, an agent should call:

```ts
heartbeat({ agent_id, lease_id, expected_turn_id })
```

The heartbeat extends the owner lease. A `stale_lease` response means the agent must stop acting as owner and re-read the room state.

### Release

The owner may release the stick without naming a recipient:

```ts
release_stick({
  agent_id,
  lease_id,
  expected_turn_id,
  handoff
})
```

Server validates:

- `lease_id` and `expected_turn_id` are current.
- `handoff.status` and `handoff.next_action` are non-empty.

Effects on success:

- Appends a release event containing the full `handoff`.
- Clears current owner and invalidates the current lease.
- Advances `sequence_index` to the next active member who has not yet held in the current round (skipping those who have). If no such member exists, `reserved_for` is left empty and the room returns to `idle`; the next claim will reset the round.
- Sets `reserved_for` to the member found above.
- Sets `claim_expires_at`.
- Changes state to `reserved`, or `idle` if no eligible recipient exists.

### Explicit Pass

```ts
pass_stick({
  agent_id,
  lease_id,
  expected_turn_id,
  to_agent_id,
  handoff
})
```

Same handoff validation as `release_stick`. Exempt from round fairness — the target may be any agent regardless of whether they have already held this round.

Effects:

- Appends a pass event containing the full `handoff`.
- Clears current owner and invalidates the current lease.
- Sets `reserved_for = to_agent_id`.
- Sets `claim_expires_at`.
- Changes state to `reserved`.

The target agent does not need to be a current member, but must join the room before claiming. If the target never joins or misses the claim timeout, another active member may take over subject to round fairness.

### Takeover

An active member may take over when the expected owner or reserved recipient has failed to respond:

```ts
takeover_stick({
  agent_id,
  room_id,
  expected_turn_id,
  reason
})
```

Allowed when:

- room is `reserved` and `claim_expires_at` has passed, or
- room is `owned` and `lease_expires_at` has passed, or
- room is `stale_owner`.

In all three cases, the caller must also be eligible under the Round Fairness rules above.

Effects:

- Atomically increments `turn_id`, advancing `current_round_started_at_turn_id` if needed.
- Issues a new `lease_id`.
- Sets `owner = agent_id`.
- Sets the caller's `last_held_turn_id = new turn_id`.
- Clears `reserved_for`.
- Records the previous owner or reserved recipient as revoked for that turn.
- Appends a takeover event with `reason`.

A takeover does not carry a handoff — the prior owner or reserved recipient never produced one. The new owner relies on `get_room_events` to reconstruct context from the most recent handoffs. The event log doubles as the recovery context for takeover.

Old agents cannot mutate the room after takeover because their `lease_id` and `turn_id` no longer match.

## MCP Tool Surface

MVP tools:

```ts
list_rooms(input)       -> Room[]
join_path(input)        -> JoinPathResult
wait_for_turn(input)    -> WaitForTurnResult
heartbeat(input)        -> HeartbeatResult
release_stick(input)    -> ReleaseStickResult
pass_stick(input)       -> PassStickResult
takeover_stick(input)   -> TakeoverStickResult
get_room_state(input)   -> GetRoomStateResult
get_room_events(input)  -> RoomEvent[]
```

Optional later additions:

```ts
append_note(input)       -> AppendNoteResult
leave_path(input)        -> LeavePathResult
close_room(input)        -> CloseRoomResult
reorder_members(input)   -> ReorderMembersResult
set_room_policy(input)   -> SetRoomPolicyResult
```

`append_note` may be useful for non-owners to add side-channel context without claiming ownership. It must not change owner state.

`get_room_events` is MVP because it is the recovery mechanism for takeover and the audit trail for the working-memory story. Without it, a new owner after takeover has no way to read prior handoffs.

## State Transitions

```text
idle
  wait_for_turn by any fairness-eligible active member
    -> owned

owned
  heartbeat by owner
    -> owned

owned
  release_stick by owner (with valid Handoff)
    -> reserved, if an eligible unheld member exists
    -> idle, if no eligible next member exists (next claim resets the round)

owned
  pass_stick by owner (with valid Handoff)
    -> reserved

owned
  lease expires
    -> stale_owner

reserved
  reserved_for calls wait_for_turn before claim timeout
    -> owned

reserved
  claim timeout expires
    -> reserved, but takeover becomes allowed

reserved
  takeover_stick by fairness-eligible active member after claim timeout
    -> owned

stale_owner
  takeover_stick by fairness-eligible active member
    -> owned

owned/reserved/idle/stale_owner
  close_room
    -> closed
```

## Race Condition Prevention

The server is the only authority for ownership.

Required safety rules:

- Store room state in a transactional database.
- Use row-level locking or a single atomic compare-and-swap update for each room mutation.
- Require `lease_id` for all owner mutations.
- Require `expected_turn_id` for all owner mutations.
- Increment `turn_id` whenever an agent is granted ownership.
- Never reuse `lease_id`.
- Treat `lease_id` as a fencing token.
- Reject stale mutations with a structured error that includes the current owner and current turn.

Example stale mutation response:

```json
{
  "error": "stale_lease",
  "message": "The supplied lease is no longer current for this room.",
  "current_owner": "claude:session-2",
  "current_turn_id": 12,
  "room_state": "owned"
}
```

Handoff and fairness errors use the same structured form:

```json
{
  "error": "invalid_handoff",
  "message": "handoff.next_action must be non-empty",
  "field": "next_action"
}
```

```json
{
  "error": "fairness_violation",
  "message": "Agent has already held the stick in the current round.",
  "current_round_started_at_turn_id": 8,
  "agent_last_held_turn_id": 10,
  "eligible_agents": ["gemini:session-1", "codex:terminal-2"]
}
```

## Deadlock Prevention

The protocol avoids permanent deadlock by combining:

- finite claim timeouts for reserved recipients,
- renewable leases for active owners,
- takeover after missed claim or missed lease,
- explicit stale state,
- round reset when strict fairness would block all candidates,
- read-only room inspection via `get_room_state` and `get_room_events`.

The server does not silently auto-transfer ownership when a lease expires. It marks the state recoverable and requires an explicit `takeover_stick` call. This keeps recovery auditable and prevents surprise parallel work.

## Multi-Process Concurrency

Agent harnesses routinely run in multiple terminal tabs, split panes, or parallel sessions. Each harness typically spawns its own MCP server subprocess. The server design must therefore support many concurrent server processes sharing state.

The model is **shared database, no daemon**. Every server process opens the same SQLite file. Coordination is purely through the database.

### SQLite configuration

Every connection must apply these pragmas:

```sql
PRAGMA journal_mode = WAL;         -- concurrent readers + single writer, no reader blocking
PRAGMA synchronous = NORMAL;       -- durable enough for coordination state, faster than FULL
PRAGMA busy_timeout = 5000;        -- wait up to 5s when another process holds the write lock
PRAGMA foreign_keys = ON;
```

All write transactions start with `BEGIN IMMEDIATE` so the write lock is acquired up front rather than through a mid-transaction upgrade. This avoids `SQLITE_BUSY` failures during lock promotion under contention.

Every mutation re-reads the relevant room row inside its transaction and verifies fencing conditions (`lease_id`, `expected_turn_id`, fairness) before committing. This makes the "two processes see stale state and both try to claim" race impossible: one commits, the other re-reads and returns `not_yet`.

### wait_for_turn across processes

`wait_for_turn` is implemented as bounded polling. Each server process polls `path_rooms` and `room_events` for the requested room at a short interval (250 ms recommended) up to `max_wait_ms`. Changes made by any other process become visible on the next poll.

A cursor on the most recent `event_id` lets the server return immediately when new events appear, so long polls do not consume CPU redundantly across consecutive calls.

### Limitations

- **Network filesystems.** SQLite locking is unreliable on NFS and some SMB implementations. The server must detect a non-local filesystem at startup and fail with a clear error suggesting `TALKING_STICK_DATA_DIR` pointed at a local path.
- **Cross-host coordination.** The MVP is explicitly single-host. Multi-host deployments require a different backend (Postgres is the natural upgrade, with `FOR UPDATE` locks replacing SQLite's write lock).

### Optional future: daemon mode

If polling overhead ever becomes a concern at scale, a future version may add an optional local daemon:

- The first client to call `join_path` starts a daemon if none is running.
- The daemon holds an exclusive writer connection to the SQLite file.
- Clients connect via a Unix domain socket at `<data_dir>/server.sock`.
- The daemon pushes state changes to waiting clients directly, eliminating polling.
- The daemon self-terminates after a configurable idle period.

This is not needed for MVP. Polling is sufficient for typical multi-tab workflows.

## Timeout Policy

Recommended defaults:

```ts
owner_lease_ttl_ms         = 5 * 60 * 1000;
heartbeat_interval_ms      = 30 * 1000;
claim_ttl_ms               = 2 * 60 * 1000;
wait_for_turn_max_wait_ms  = 30 * 1000;
wait_for_turn_poll_ms      = 250;
presence_ttl_ms            = 10 * 60 * 1000;
```

Timeout meanings:

- `wait_for_turn` max wait is only a polling budget. The client should call again if it returns `not_yet`.
- `wait_for_turn_poll_ms` is how often a waiting process re-reads room state during a single long poll.
- `claim_ttl` is how long a reserved recipient has first right of refusal.
- `owner_lease_ttl` is how long an owner may remain silent before takeover becomes possible.
- `presence_ttl` determines whether a member is active for sequence selection and round fairness calculations.

Per-room policy is expected to become a first-class need quickly (batch workflows want longer TTLs; interactive workflows want shorter claims). Storing timeouts on the room record rather than as global server defaults is the recommended near-term extension, enabled via `set_room_policy`.

## Persistence Model

### File Layout

State lives in a single SQLite database at a platform-conventional user data directory:

- **Linux**: `$XDG_DATA_HOME/talking-stick/rooms.sqlite`, defaulting to `~/.local/share/talking-stick/rooms.sqlite`.
- **macOS**: `~/Library/Application Support/talking-stick/rooms.sqlite`.
- **Windows**: `%APPDATA%\talking-stick\rooms.sqlite`.

The Node ecosystem's `env-paths` package resolves these per OS; use it rather than hand-rolling platform detection.

Override:

- `TALKING_STICK_DATA_DIR` sets an explicit directory. If set, the database lives at `$TALKING_STICK_DATA_DIR/rooms.sqlite`. This is the recommended way to isolate test databases and to keep per-project state when that is desired.

The server creates the directory on first run if it does not exist. All rooms (across all workspaces on the host) share the single database file — keeping them together is what makes ancestor lookup a simple indexed query rather than a filesystem traversal.

### Schema

```sql
CREATE TABLE path_rooms (
  room_id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  sequence_index INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  reserved_for TEXT,
  turn_id INTEGER NOT NULL DEFAULT 0,
  current_round_started_at_turn_id INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  claim_expires_at TEXT,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canonical_path, topic)
);

CREATE INDEX path_rooms_canonical_path_idx
  ON path_rooms (canonical_path);

CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_held_turn_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
);

CREATE TABLE room_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- claim | release | pass | takeover | heartbeat | close
  from_agent_id TEXT,
  to_agent_id TEXT,
  handoff_json TEXT,          -- NULL for claim | heartbeat | takeover | close
  reason TEXT,                -- populated on takeover events
  created_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
);

CREATE INDEX room_events_room_turn_idx
  ON room_events (room_id, turn_id);
```

Ancestor lookup uses the `canonical_path` index: given a candidate path `P`, generate its ancestor paths in code and issue a single `IN` query against `canonical_path`, picking the longest match. At small scale this is microsecond-fast; at very large scale consider materialized paths.

`room_events` is append-only. `path_rooms` is a projection of the event stream for fast reads. The event log is also the takeover recovery context: a new owner after `takeover_stick` reads recent events to reconstruct what was happening before the prior owner went silent.

## Agent Operating Instructions

Harnesses using this MCP server should follow these rules:

1. Before joining, call `list_rooms` to see what is already happening in the workspace.
2. Join using `join_path`. Accept the resolved `room_id`, `canonical_path`, and `topic` the server returns, even if they differ from what you asked for — ancestor lookup may have attached you to a parent room.
3. Do not perform shared task work unless `wait_for_turn` returns `your_turn`.
4. When you receive `your_turn`, read the attached `handoff` before doing anything else. Load `artifacts[]` entries directly rather than re-exploring the workspace.
5. While working, heartbeat periodically.
6. If any owner mutation returns `stale_lease`, `turn_mismatch`, or `fairness_violation`, stop working and read current state.
7. To release the stick, construct a `Handoff` with a truthful `status` and an actionable `next_action`. Include `artifacts[]` entries when the next agent needs to load specific files or line ranges.
8. Use `release_stick` to continue the default sequence.
9. Use `pass_stick` to choose a specific next agent. Passes bypass round fairness — use them deliberately.
10. Use `takeover_stick` only after timeout eligibility and only when your round-fairness eligibility allows. Include a reason. After a successful takeover, call `get_room_events` to reconstruct context from the most recent handoffs.

Suggested format for the free-text `status` field:

```md
What I did:
What I learned:
Open risks:
```

## Example: Three-Agent Round Robin

Members join in this order:

```text
codex
claude
gemini
```

Flow:

```text
codex claims idle room and writes initial plan.
codex releases stick with:
  status:       "wrote initial plan covering sections 1-3"
  next_action:  "review plan for gaps; suggest additions"
  artifacts:    [{ path: "plan.md", role: "review" }]
room reserves for claude.

claude claims reserved stick, receives codex's handoff.
claude reviews the plan and releases with:
  status:       "reviewed plan; section 2 is thin on error handling"
  next_action:  "extend error handling coverage in section 2"
  artifacts:    [{ path: "plan.md", lines: [45, 78], role: "edit" }]
room reserves for gemini.

gemini claims reserved stick, receives claude's handoff.
gemini extends section 2, releases. Round is now complete (all three held).
room_started_round advances; next grant begins a new round.
The cycle continues.
```

## Example: Explicit Skip

Default sequence:

```text
codex -> claude -> gemini -> codex
```

If codex wants gemini to review a concurrency detail immediately:

```text
codex pass_stick(
  to_agent_id = gemini,
  handoff = {
    status:      "found potential race in claim logic",
    next_action: "assess whether lease_id fencing covers this case",
    artifacts:   [{ path: "src/claim.ts", lines: [102, 140], role: "review" }]
  }
)
```

The room reserves the next turn for gemini, skipping claude. Because explicit pass bypasses fairness, this is allowed even if gemini had already held in the current round. After gemini releases, the default sequence resumes from gemini's position in the member list and claude becomes eligible again.

## Example: Missed Recipient with Round Fairness

```text
codex holds, then releases; reserved for claude.
claude does not claim before claim_ttl.
codex attempts takeover -- REJECTED (codex already held this round).
gemini calls takeover_stick(reason = "claim timeout expired") -- ACCEPTED.
server grants gemini a fresh lease, increments turn_id, updates gemini's last_held_turn_id.
gemini calls get_room_events to read codex's original handoff.
claude wakes up late and tries to claim -- REJECTED (stale turn).
```

## Example: Crashed Owner

```text
claude owns the stick.
claude stops heartbeating.
owner_lease_ttl expires.
room becomes stale_owner.
codex calls takeover_stick(reason = "owner lease expired").
server grants codex a fresh lease and increments turn_id.
codex calls get_room_events to read the handoff claude received on claim,
  so codex can infer what claude was working on.
claude later tries to release with its old lease.
server rejects as stale_lease.
```

## Example: Two-Process Concurrent Claim

```text
Terminal A (claude process) and Terminal B (codex process) both run wait_for_turn
  against an idle room.
Both processes poll. Both see room_state = idle at the same poll tick.
Both start a BEGIN IMMEDIATE transaction to claim.
  Process A wins the write lock; process B blocks.
Process A re-reads the row, verifies idle, increments turn_id, sets owner=claude,
  commits.
Process B acquires the write lock, re-reads, sees room_state = owned by claude,
  aborts the claim, returns not_yet to its client.
Process B's client polls again and correctly sees the new reserved_for / claim
  timing on subsequent events.
```

## Design Rationale

This section records the reasoning behind the load-bearing choices in this plan. Future maintainers should read it before proposing structural changes.

### Why hierarchical ancestor lookup instead of flat canonical paths

An earlier draft resolved each request path to a canonical string and looked up rooms by exact match. That failed the common monorepo case: two agents running in `/repo/packages/foo/` and `/repo/packages/bar/` would create separate rooms and never coordinate, even when they were doing related work for the same repo.

Switching to deepest-ancestor lookup matches the mental model developers already use for `.git`, `CLAUDE.md`, `package.json`, and every other workspace marker in common use. An agent at any depth under `/repo/` automatically joins the `/repo/` room if one exists, and no explicit room identifiers need to be coordinated out of band.

Because coordination is operator-initiated, the server does not actively prevent nested rooms. Operators know when they are starting a nested conversation and can request one explicitly via `force_new`.

### Why optional topics instead of a general identifier

Multiple concurrent conversations at the same path are a real need — a repo might have a review in flight and a triage in parallel. But most rooms never need more than one conversation.

A fully general `room_id` would force every caller to carry and coordinate identifiers. Optional topics keep the single-room case trivial (empty topic) while making the multi-room case explicit and enumerable via `list_rooms`. The default is zero ceremony; the escape hatch exists when needed.

### Why the handoff is structured and mandatory

The protocol's original shape treated ownership transfer as metadata about the lock with a free-text note attached. But in practice the expensive operation in a multi-agent handoff is not the lock transfer — it is context reconstruction by the new owner. Every agent that takes the stick starts by asking "what was happening before I got here?"

Making the handoff a structured artifact (`status`, `next_action`, `artifacts[]`) turns ownership transfer into state transfer. The `artifacts[]` entries map directly onto how LLMs consume code — path and optional line range — so the next owner can load exactly the relevant context without rediscovering it.

Requiring `status` and `next_action` to be non-empty is a small amount of server-side validation that prevents a large class of low-quality handoffs. Handoff quality still depends on harness behavior, which the protocol cannot enforce, so `join_path` returns a `handoff_template` hint that harnesses can surface to their models.

### Why takeovers do not carry a handoff

A takeover happens precisely because the expected owner did not produce one. Requiring a handoff from the new owner would ask them to speak for the failed owner, which they cannot do truthfully.

Instead, the event log is the recovery context. `get_room_events` returns recent handoffs, including the one the failed owner received when they took the stick. This is also why `get_room_events` is MVP rather than optional — without it, the takeover recovery story is broken.

### Why `turn_id` increments on grant, not on release

Incrementing on grant keeps fencing math trivial: the current `(lease_id, turn_id)` pair always matches exactly one epoch, and release merely ends that epoch without starting a new one. A pending reservation is not a new epoch; it is a waiting room. Incrementing on release would create a window where a slow releaser and a fast new claimant disagree about the current epoch.

### Why round fairness is a first-class invariant

Round-robin sequencing already exists via `sequence_index`, but it is fragile under takeover edge cases. If agent A holds, releases to B, and B misses the claim timeout, the original rules allowed A to take over — even though B and C never got a turn. "Claude shouldn't speak again until Gemini and Codex have chimed in" is exactly what happens if that loophole is open.

Making "held this round" an explicit per-member state (via `last_held_turn_id` against `current_round_started_at_turn_id`) enforces fairness uniformly across normal claims, reserved claims, and takeovers. The rule is simple to state and easy to verify on every mutation: an agent cannot hold the stick twice in a round unless strict application would deadlock (the two-member edge case).

Explicit pass is intentionally exempt. The holder is making a deliberate choice and may have a legitimate reason to hand to an agent who already went. Fairness is a default; deliberate overrides are allowed.

### Why takeover is explicit rather than automatic

The server could auto-transfer ownership the moment a lease expired. It does not, because silent promotions are the source of most "surprise parallel work" incidents in real coordination systems. An explicit `takeover_stick` call requires an agent to name a reason and produces an auditable event, making recovery visible in the log.

### Why shared SQLite instead of a daemon

Agent harnesses in this ecosystem spawn MCP servers as subprocesses, typically one per harness invocation. A daemon-based coordination server would require lifecycle management (who starts it, when it shuts down, how it recovers from crashes) that adds operational complexity with little benefit at a single-host, single-user scale.

SQLite in WAL mode handles concurrent readers and a single writer at low latency without any additional process. Multiple MCP server processes can share the database file without coordination beyond what SQLite already provides. The cost is polling — `wait_for_turn` cannot be push-notified across processes — but a 250 ms poll interval is well within the latency budget for agent-to-agent handoffs.

A daemon mode remains open as a future optimization if polling becomes a bottleneck. It is not needed for the typical multi-tab workflow the MVP targets.

### Why platform-conventional data directories

Writing coordination state to `~/.talking-stick/` would litter the home directory and ignore per-OS conventions. Using XDG on Linux, Application Support on macOS, and AppData on Windows keeps the server's footprint discoverable and polite, and lets existing backup and sync tools find it without extra configuration. The `TALKING_STICK_DATA_DIR` override exists for users who want everything in one place, for per-project isolation, and for testing.

Centralizing all rooms in a single SQLite file (rather than one file per room) makes ancestor lookup a simple indexed query rather than a filesystem walk. It also means backups and migrations move a single file.

## Open Design Questions

The following questions are worth revisiting once the MVP has seen real use:

- After an explicit pass, should the default sequence resume from the passed-to agent's position (the current default) or preserve the skipped member's next-turn claim?
- Should round fairness admit any softening options — for example, a per-room `strict_fairness: false` flag that allows consecutive turns when obviously wanted?
- Should non-owners be able to append notes, or would that encourage side-channel work that bypasses the handoff discipline?
- What should `list_rooms` show for rooms that are hierarchically above the caller's path but use a topic the caller did not request — show them all, or filter to matching topics only?
- Should a human operator override use the same `takeover_stick` tool as peer agents, or a separate admin tool that bypasses timeout gating and fairness?
- Should per-room timeout and policy configuration be shipped with MVP or deferred until a concrete workflow needs it?
- Should the `handoff_template` returned by `join_path` be static (one template per server) or configurable per room?
- Should `wait_for_turn` use a notification mechanism (Unix socket, signal, or SQLite's `sqlite3_update_hook` shared via a local IPC file) instead of polling, before shipping a full daemon mode?
- Should the database path default be per-user (current design) or support a per-project mode (e.g., auto-detect `./.talking-stick/` in the workspace ancestor chain)?

## Implementation Plan

1. Build a local TypeScript MCP server using the Node MCP SDK.
2. Use SQLite (via `better-sqlite3` or `libsql`) with WAL mode, resolving the database path via `env-paths` with `TALKING_STICK_DATA_DIR` override.
3. Apply required pragmas on every connection; use `BEGIN IMMEDIATE` for all write transactions.
4. Detect non-local filesystems at startup and fail fast with a clear error.
5. Implement canonical path resolution and deepest-ancestor room lookup.
6. Implement `list_rooms`, `join_path` (with `topic` and `force_new`), `get_room_state`, and member sequencing.
7. Implement the `Handoff` type with server-side validation of required fields.
8. Implement round fairness (per-member `last_held_turn_id`, per-room `current_round_started_at_turn_id`, eligibility checks, round reset logic).
9. Implement `wait_for_turn` as bounded polling with cursor support and atomic claiming; attach the prior handoff to `your_turn` responses.
10. Implement lease issuing, heartbeat, release (with handoff), explicit pass (with handoff), and takeover.
11. Implement `get_room_events` for both audit and takeover recovery.
12. Add tests for:
    - ancestor lookup (including nested rooms and `force_new`),
    - topic-based room separation,
    - handoff validation errors,
    - stale leases,
    - simultaneous claims within one process,
    - **simultaneous claims across multiple concurrent processes** (spawn N processes, have them claim/release under contention, verify no state corruption),
    - explicit pass,
    - release sequence,
    - claim timeout and takeover,
    - owner timeout and takeover,
    - **round fairness in all three paths**: normal release, missed claim, stale owner,
    - **round reset** when strict fairness would deadlock,
    - event log reconstruction after takeover,
    - database path resolution across platforms and with `TALKING_STICK_DATA_DIR` set.
13. Add a small CLI or script for manual inspection during development.

## Minimum Viable Version

The first useful version can omit optional notes, admin features, and per-room policy.

MVP tools:

```text
list_rooms
join_path
wait_for_turn
heartbeat
release_stick
pass_stick
takeover_stick
get_room_state
get_room_events
```

MVP storage:

```text
path_rooms       (with (canonical_path, topic) unique key and round tracking)
room_members    (with last_held_turn_id for round fairness)
room_events     (with handoff_json payload on release and pass events)
```

MVP policy:

```text
data directory:          env-paths default per OS (~/.local/share/talking-stick on Linux,
                         ~/Library/Application Support/talking-stick on macOS,
                         %APPDATA%\talking-stick on Windows);
                         override via TALKING_STICK_DATA_DIR
database file:           <data_dir>/rooms.sqlite, WAL mode, synchronous=NORMAL, busy_timeout=5s
concurrency:             shared database across server processes; BEGIN IMMEDIATE for writes;
                         wait_for_turn polls at 250 ms across processes
filesystem requirement:  local filesystem; NFS/SMB rejected at startup
room identity:           (canonical_path, topic), resolved via deepest-ancestor lookup
room creation default:   attach to ancestor when one exists; require force_new to nest
topic default:           empty string
release behavior:        reserve next unheld-this-round active member in sequence
explicit pass behavior:  reserve target agent; fairness-exempt
takeover behavior:       any fairness-eligible active member after timeout; no handoff required
round fairness:          enforced via last_held_turn_id and current_round_started_at_turn_id;
                         round resets when strict application would deadlock
handoff requirement:     release_stick and pass_stick require non-empty status and next_action
recovery context:        get_room_events supplies prior handoffs to takeover winner
owner lease TTL:         5 minutes
claim TTL:               2 minutes
wait_for_turn max wait:  30 seconds, polled at 250 ms
```
