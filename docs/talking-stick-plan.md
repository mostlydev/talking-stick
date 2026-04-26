# Talking Stick MCP Coordination Plan

## Purpose

Talking Stick is an MCP server that lets multiple agent harnesses coordinate work in a shared workspace without accidentally performing parallel work and without re-deriving context on every turn.

The core metaphor is simple:

- A workspace maps to a coordination room.
- Agents join the room by operating in a path that resolves to it.
- Exactly one agent may hold the talking stick for that room at a time.
- The holder may work, release the stick to the next agent in sequence, or explicitly pass it to a specific agent.
- Passing or releasing the stick requires a structured handoff. The handoff carries what was done, what remains, and where to look, so the next agent does not have to rediscover context.
- Normal release follows the member sequence. Explicit pass and timeout takeover are deliberate escape hatches.
- If the expected agent fails to respond, another active member may take over after a timeout. Timeout opens takeover eligibility; it does not revoke the expected agent until a takeover actually commits.

The goal is not a general chat system. The goal is a small, fault-tolerant coordination primitive that also serves as shared working memory for planning, code review, task handoff, and multi-agent turn-taking.

## Design Goals

- Resolve coordination scope to a workspace root, matching how developers already think about workspaces (git, `CLAUDE.md`, `package.json`).
- Keep the MVP to one default room per workspace path; multiple simultaneous topics can be added later if real workflows need them.
- Make the handoff between agents the primary state transfer, not an afterthought.
- Provide predictable ordered turn-taking without making fairness a hard concurrency invariant.
- Work safely when multiple MCP server processes run concurrently (multiple terminal tabs, split views, parallel sessions).
- Store state in a predictable per-user data directory under `~/.local/share` on Linux and macOS, with an override for tests and project isolation.
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

### Path Room and Workspace Resolution

A path room is the coordination scope for a workspace. In the MVP, room identity is the canonical room path, normally the workspace root.

Room resolution has three steps:

1. Resolve the request path to a preferred workspace root.
2. Search from the request path up to that workspace root for the deepest existing room.
3. If no room exists on that path, create a room at the preferred workspace root.

This avoids the common monorepo failure mode where one agent starts in `/repo/packages/foo/src/` and another starts in `/repo/packages/bar/`, creating separate rooms even though both are working in the same repo. If `/repo/` is the git worktree root, both agents resolve to `/repo/`. It also preserves explicit nested rooms: if an operator creates a room at `/repo/packages/foo/`, agents below that path join the nested room instead of the repo root.

Preferred workspace root resolution:

1. If the request path is inside a git worktree, use the git top-level path.
2. Otherwise, use the nearest ancestor containing a recognized workspace marker such as `CLAUDE.md`, `AGENTS.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`.
3. Otherwise, use the canonical request path.

Canonicalization applied before room lookup:

- If `context_path` points to a file, use its parent directory.
- Resolve symlinks.
- Normalize path separators.
- Normalize casing on case-insensitive filesystems.

**Nesting and conflict.** Creating a nested room inside an existing room requires explicit opt-in via `force_new = true`. The default behavior is to join the ancestor room. Because talking-stick coordination is operator-initiated, this default is safe: operators know when they are starting a nested conversation and can request one explicitly.

### Deferred Extension: Topics

The MVP intentionally has one default room per workspace path.

Optional topics may be added later if unrelated efforts in the same workspace need independent coordination, such as a `review` room and a `triage` room at the same repo root. Deferring topics keeps the initial protocol aligned with the simple "path chat" model and avoids making every tool carry an extra discriminator before the need is proven.

### Agent Identity

`agent_id` is derived by the MCP adapter at connection time, not supplied by the harness. Harnesses should not set or guess their own identity; the server knows more about which process is calling than the harness does about itself.

Derivation signals, in order of preference:

1. `clientInfo.name` and `clientInfo.version` from the MCP `initialize` handshake. Every MCP client sends these; Claude Code, Codex, and Gemini CLI all set distinctive values.
2. The MCP server's own parent process identity: `(parent_pid, parent_start_time)`. Together these uniquely identify the harness instance on a host. `parent_pid` alone is unsafe because PIDs are reused after exit.
3. Environment variables the harness exports, such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `TERM_PROGRAM`, `ITERM_SESSION_ID`, `TMUX`, `SSH_TTY`.

Composed identity, stable for the life of one harness instance:

```text
<harness-slug>:<short-hash>

e.g.
  claude-code:a3f1
  codex:9b22
  gemini:1c4e
```

The hash is a short digest over the signals above, so reconnects from the same harness instance land on the same `agent_id`. Distinct tabs, splits, or parallel spawns of the same harness get distinct hashes because their `parent_pid`/`parent_start_time` differ.

For the Human CLI (see deferred extension), the same idea applies with different signals: `$USER`, parent shell `(pid, start_time)`, and tty yield identities like:

```text
human:wojtek:s003
```

The derived string is the protocol-facing identity, but the server must also persist the source liveness facts behind it:

- `host_id`
- `pid`
- `process_started_at`
- `session_kind` (`mcp_harness`, `human_guardian`, later others)
- optional display metadata such as tty or client name

The digest alone is not enough for liveness decisions. If the system is going to say "that owner is really gone," it must be able to check whether the exact spawning process identified by `(host_id, pid, process_started_at)` still exists.

For the Human CLI, this implies a split between one-shot commands and holders:

- one-shot commands like `list`, `join`, `state`, and `events` are ordinary short-lived processes and do not own the room,
- indefinite human ownership uses an attached hold mode or a lightweight local guardian process, so the owner is still represented by one live process that can be checked and can exit cleanly.

The `join_path` response returns the assigned `agent_id` to the harness so it appears in logs, downstream handoffs, and event records. It also returns the effective policy for that room, including the server's expected heartbeat cadence, so harnesses and human-holder helpers can renew leases without guessing. An optional `agent_id_override` is accepted for tests and debugging and is flagged in the event stream.

No MCP tool input other than `join_path` carries `agent_id_override`. If `join_path` receives an override, that override becomes the connection's derived identity for subsequent calls on that same connection until disconnect. Otherwise, for every owner mutation the adapter injects the derived identity from the connection context, and the service layer continues to use `agent_id` internally for fencing and membership checks.

This keeps the protocol surface simple: `agent_id` is the session-scoped identity. The MVP still does not need a separate global participant/session abstraction, but it does need to persist process metadata alongside room membership so it can make exact local liveness checks.

### Membership Sequence

When an agent joins a room, the server appends it to the room's ordered member list if not already present. This order defines the default turn sequence.

```text
A joins
B joins
C joins

Default sequence: A -> B -> C -> A
```

An owner can follow the normal flow by releasing the stick. The server then chooses the fairest eligible waiter rather than blindly following join order. An owner can skip that flow by explicitly passing to a chosen agent.

### Ownership

At most one agent owns the stick for a room at any time.

Only the owner may perform owner actions:

- `heartbeat`
- `release_stick`
- `pass_stick`
- `close_room` if that optional later tool is implemented

Every owner action carries:

- `room_id`
- `lease_id`
- `expected_turn_id`

`agent_id` is derived by the MCP adapter from the connection rather than sent by the caller. The service layer still uses `(agent_id, lease_id, turn_id)` together for fencing; the caller just does not get to name themselves. Old actions from stale agents must be rejected.

### Turn ID Semantics

`turn_id` identifies the current ownership epoch. It increments only when an agent is granted ownership:

- an idle room is claimed,
- a reserved recipient claims the stick,
- a timeout takeover succeeds.

`release_stick` and `pass_stick` end the current ownership epoch and invalidate the current lease, but they do not grant ownership to the next agent by themselves. They create a pending reservation that the next eligible agent must claim.

### Default Turn Order

The room maintains an ordered member list, `sequence_index`, and waiter timestamps. Normal release reserves the stick for the fairest recent waiter: prefer members that have never held the stick, then the member whose last ownership is oldest, with sequence order as a deterministic tie-breaker.

This gives the common case a round-robin shape without pinning the room to exact join order:

```text
A releases -> B gets first right of refusal
B releases -> C gets first right of refusal
C releases -> A gets first right of refusal
```

The sequence is not a hard fairness lock:

- An owner may explicitly pass to any active member.
- If the fairest known candidate is between wait polls, release may leave the room idle with a pending handoff for a short grace window instead of reserving a less-fair recent waiter.
- If a reserved recipient misses `claim_ttl`, another active member may take over, but the immediately prior owner should not be the takeover winner while any other active member can take it.
- If an owner misses `owner_lease_ttl`, another active member may take over.

This is intentionally lightweight fairness. The protocol still prioritizes preventing accidental parallel ownership; the fairness policy only decides who gets first claim opportunity in the normal release path.

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
  | "owner_gone"
  | "recipient_gone"
  | "dormant"
  | "closed";

interface PathRoom {
  room_id: string;                            // server-generated
  canonical_path: string;

  members: AgentId[];
  sequence_index: number;

  owner: AgentId | null;
  reserved_for: AgentId | null;
  pending_handoff_event_seq: number | null;

  turn_id: number;
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
  last_wait_at: string | null;
  status: "active" | "inactive";              // derived from last_seen_at and presence_ttl
}
```

State meanings:

- `idle`: no current owner and no specific reserved recipient. It may still have a pending handoff from the previous release.
- `owned`: one agent has a live lease and may work.
- `reserved`: the stick has been released or passed to a specific agent, which has a limited time to claim it.
- `stale_owner`: derived state indicating the owner missed its lease heartbeat and takeover is available. The owner is not revoked until a takeover commits.
- `owner_gone`: derived state indicating the exact owning process is known to have exited. Takeover is immediately available; no lease timeout wait is required.
- `recipient_gone`: derived state indicating the reserved recipient's exact process is known to have exited. Takeover is immediately available; no claim timeout wait is required.
- `dormant`: derived state indicating no member is currently live or recently present, but the room was not explicitly closed. In implementation, takeover-relevant states such as `owner_gone`, `recipient_gone`, and `stale_owner` take precedence over `dormant`; the room should report the most actionable recovery state first.
- `closed`: no further turns are expected.

An active member is one whose `last_seen_at` is within `presence_ttl` and whose exact spawning process is still alive when liveness metadata is available. Death beats timeout for the current owner and reserved recipient: if the server can prove either exact process is gone, recovery opens immediately rather than waiting for `presence_ttl`.

As with lease expiry, activity can be derived lazily on reads and writes rather than maintained by a background process. Process liveness checks must use `pid + process_started_at`; `kill(pid, 0)` or pid-only lookup is not sufficient because PIDs are reused. To keep write transactions short, the MVP uses exact process checks for owner/reserved recovery and recent presence for broader sequence scans; timeout recovery remains the fallback for a stale sequence target.

### Room Termination vs Dormancy

The protocol model reserves a `closed` state for an optional later `close_room` tool. The MVP implementation does not provide that tool and therefore never enters `closed`; rooms remain resumable unless they become dormant. This still matters because "no live processes currently point at this room" is a common state during normal work — an operator steps away, or all harnesses exit between turns — and it must not be confused with "this conversation is over."

The MVP therefore distinguishes three situations, not two:

- **Active:** at least one member has recent presence within `presence_ttl`. Normal operation.
- **Dormant:** no member has recent presence or a currently live process, and no optional later close mechanism has been invoked. The room persists, its event log stays readable, and any member returning later can resume. Dormancy is a derived condition, not a stored state; `get_room_state` is the authoritative projection and may use persisted process metadata when available, while `list_rooms` may use a cheaper summary projection based on room ownership fields and recent presence so it does not need to probe every room holder.
- **Closed:** reserved for a future `close_room` extension. If that tool is added later, the room becomes terminal and no further owner mutations are accepted. The event log remains for inspection.

Retention policy for long-dormant rooms (archive, prune, purge after N days with no activity) is out of scope for MVP and is expected to be a separate administrative concern, not a protocol state transition. This prevents surprise deletions and keeps the protocol's responsibilities narrow.

## Default Lifecycle

### Discover

An agent enumerates rooms reachable from a path:

```ts
list_rooms({ context_path? }) -> Room[]
```

Rooms are returned for the ancestor chain from `context_path` to the resolved workspace root, keyed by `room_id` and annotated with `canonical_path` and current state. This lets a harness show "here is what is happening in this workspace" in one call.

### Join

```ts
join_path({
  context_path,
  force_new?,           // defaults to false
  agent_id_override?    // optional; tests and debugging only
})
```

`agent_id` is not an input. It is derived server-side from the MCP connection and returned in the response so the harness can surface it in logs.

Resolution:

1. Canonicalize `context_path`.
2. Resolve the preferred workspace root.
3. Walk up from the canonical `context_path` to the preferred workspace root looking for an existing room.
4. If found and `force_new = false`: join the deepest existing ancestor room.
5. If found and `force_new = true`: create a nested room at the canonical `context_path`, returning a warning that an ancestor room exists. If a room already exists at that exact path, join it.
6. If not found: create a new room at the preferred workspace root.

The response includes the resolved `room_id`, the `canonical_path` the agent actually joined (which may differ from the request path when workspace root resolution or ancestor lookup redirected the call), the effective room policy (including `heartbeat_interval_ms`), and a `handoff_template` hint describing the expected handoff shape. For the MVP this template is static server-wide; room-specific prompting can be added later if real workflows need it.

Effects:

- Adds `agent_id` to the ordered member list if absent.
- Updates the agent presence timestamp.
- Returns the current room state.

### Wait

```ts
wait_for_turn({
  room_id,
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
      handoff: Handoff | null;       // null for open claim or already_owner
      from_agent_id: AgentId | null;
      reason: "direct_pass" | "sequence" | "open_claim" | "already_owner";
    }
  | {
      status: "not_yet";
      room_state: RoomState;
      turn_id: number;
      current_owner?: AgentId;
      reserved_for?: AgentId;
      lease_expires_at?: string;
      claim_expires_at?: string;
    }
  | {
      status: "takeover_available";
      room_id: string;
      turn_id: number;
      room_state:
        | "owned"
        | "reserved"
        | "stale_owner"
        | "owner_gone"
        | "recipient_gone";
      reason:
        | "claim_timeout"
        | "owner_timeout"
        | "owner_gone"
        | "recipient_gone";
      current_owner?: AgentId;
      reserved_for?: AgentId;
    }
  | {
      status: "closed";
      room_id: string;
    };
```

`wait_for_turn` may claim the stick when the caller is directly eligible:

- If the room is `idle`, any active member may claim unless a just-released handoff is inside the short waiter grace window and a fairer known candidate has not had a chance to poll yet.
- If the room is `reserved`, `reserved_for` may claim as long as no takeover has committed, even after `claim_expires_at`.

Each `wait_for_turn` call updates the caller's `last_seen_at` and `last_wait_at`, so polling agents remain active and visible to fair release selection.

As part of each read/write operation, the server may also refresh derived liveness for the current owner and reserved recipient. If the exact spawning process for either is proven absent, the room moves to `owner_gone` or `recipient_gone` as a derived condition and `takeover_available` is returned immediately to other eligible members.

`wait_for_turn` does not perform takeover for a non-reserved caller. If timeout has made takeover possible, it returns `takeover_available`; the caller must then invoke `takeover_stick` with an explicit reason.

`max_wait_ms = 0` is a valid non-blocking call. It still performs one atomic read/claim attempt before returning `your_turn`, `takeover_available`, `closed`, or `not_yet`.

When a claim succeeds, the server atomically:

- increments `turn_id`,
- issues a new `lease_id`,
- sets `owner = agent_id`,
- clears `reserved_for`,
- clears `pending_handoff_event_seq`,
- sets `lease_expires_at`,
- appends a claim event,
- returns `your_turn` with the prior handoff attached.

### Work

While holding the stick, an agent should call:

```ts
heartbeat({ room_id, lease_id, expected_turn_id })
```

The heartbeat extends the owner lease and updates the owner's `last_seen_at`. A `stale_lease` response means another agent has taken over or otherwise invalidated the lease; the caller must stop acting as owner and re-read the room state.

Lease expiry opens takeover eligibility. It does not invalidate the owner's lease by itself. If an expired owner heartbeats before another agent successfully takes over, the heartbeat may renew the lease.

By contrast, exact process death is definitive. If the server can prove that the owning process is gone, the owner may not renew; takeover is immediately available to other eligible members.

### Release

The owner may release the stick without naming a recipient:

```ts
release_stick({
  room_id,
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
- Stores that event's `event_seq` as `pending_handoff_event_seq`.
- Updates the releasing owner's `last_seen_at`.
- Clears current owner and invalidates the current lease.
- Advances `sequence_index` to the reserved member when one is selected.
- Sets `reserved_for` to the fairest recent waiter, if one exists.
- Sets `claim_expires_at` when a recipient is reserved, otherwise clears it.
- Changes state to `reserved`, or `idle` if no fair recent waiter exists. The pending handoff remains available to the next successful claimant.

### Explicit Pass

```ts
pass_stick({
  room_id,
  lease_id,
  expected_turn_id,
  to_agent_id,
  handoff
})
```

Same handoff validation as `release_stick`. In the MVP, `to_agent_id` must already be an active member of the room. Passing to non-members is deferred until there is an explicit invite or discovery story.

Effects:

- Appends a pass event containing the full `handoff`.
- Stores that event's `event_seq` as `pending_handoff_event_seq`.
- Updates the passing owner's `last_seen_at`.
- Clears current owner and invalidates the current lease.
- Sets `reserved_for = to_agent_id`.
- Sets `sequence_index` to the target agent's ordinal, so the default sequence resumes from the passed-to agent after they release.
- Sets `claim_expires_at`.
- Changes state to `reserved`.

If the target misses the claim timeout, another active member may take over. The immediately prior owner should not be the takeover winner while any other active member can take it.

### Takeover

Another active member may take over when the expected owner or reserved recipient has failed to respond:

```ts
takeover_stick({
  room_id,
  expected_turn_id,
  reason
})
```

The takeover call itself refreshes the caller's presence before eligibility is checked. Other members' activity is still evaluated from their existing `last_seen_at` values. This lets a returning active harness recover a timed-out room with one explicit operation, while the prior-owner guard still depends on whether some other member has been active recently.

Allowed when:

- room is `reserved` and `claim_expires_at` has passed, or
- room is `owned` and `lease_expires_at` has passed, or
- room is `reserved` and the reserved recipient's exact process is known gone, or
- room is `owned` and the owner's exact process is known gone, or
- room is `stale_owner`.

In timeout cases, an active member other than the current owner or reserved recipient may attempt takeover. The previous owner or reserved recipient is not revoked merely because a timeout elapsed; they are revoked only if another agent's `takeover_stick` transaction commits first.

In process-gone cases, the server has positive evidence that the exact spawning process has exited. The dead owner or dead reserved recipient is therefore immediately ineligible to reclaim, heartbeat, release, or pass. Ownership still transfers only by explicit `takeover_stick`; the server never auto-promotes another member in the background.

For claim timeouts, there is one additional anti-monopoly guard: the immediately prior owner, identified by the pending handoff event's `from_agent_id`, is not eligible to take over while any other active member is eligible. If no other active member is available, the prior owner may take over rather than deadlocking the room. This preserves the important "do not immediately grab the stick back" behavior without adding full round-fairness state.

Effects:

- Atomically re-reads the room and verifies timeout eligibility.
- Atomically increments `turn_id`.
- Issues a new `lease_id`.
- Sets `owner = agent_id`.
- Updates the caller's `last_seen_at`.
- Clears `reserved_for`.
- Clears `pending_handoff_event_seq`.
- Records the previous owner or reserved recipient as revoked for that turn.
- Appends a takeover event with `reason`.

The result includes the new `turn_id` and `lease_id`. It does not include a handoff; the prior owner or reserved recipient never produced one. The new owner relies on `get_room_events` to reconstruct context from the most recent handoffs.

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
  wait_for_turn by any active member
    -> owned

owned
  heartbeat by owner
    -> owned

owned
  release_stick by owner (with valid Handoff)
    -> reserved, if another active member exists
    -> idle, if no other active member exists

owned
  pass_stick by owner to an active member (with valid Handoff)
    -> reserved

owned
  lease expires
    -> stale_owner/takeover_available as derived state

owned
  owning process is known gone
    -> owner_gone/takeover_available as derived state

reserved
  reserved_for calls wait_for_turn before any takeover commits
    -> owned

reserved
  claim timeout expires
    -> reserved, but takeover_available is returned to other active members

reserved
  reserved recipient process is known gone
    -> recipient_gone/takeover_available as derived state

reserved
  takeover_stick by another active member after claim timeout
    prior owner is skipped if another candidate exists
    -> owned

stale_owner
  owner heartbeat/release/pass before takeover commits
    -> owned/reserved

stale_owner
  takeover_stick by another active member
    -> owned

owner_gone/recipient_gone
  takeover_stick by another active member
    -> owned

owned/reserved/idle/stale_owner/owner_gone/recipient_gone/dormant
  optional later close_room
    -> closed

owned/reserved/idle/stale_owner/owner_gone/recipient_gone
  all members inactive or gone and no explicit close
    -> dormant as derived state
```

## Race Condition Prevention

The server is the only authority for ownership.

Required safety rules:

- Store room state in a transactional database.
- Use row-level locking or a single atomic compare-and-swap update for each room mutation.
- Require `room_id` for all owner mutations. `agent_id` is derived by the MCP adapter from the connection and supplied to the service layer; it is not a tool input.
- Require `lease_id` for all owner mutations.
- Require `expected_turn_id` for all owner mutations.
- Persist enough process metadata to identify the exact spawning process for each member (`pid` plus `process_started_at`, and preferably `host_id`).
- Increment `turn_id` whenever an agent is granted ownership.
- Never reuse `lease_id`.
- Treat `lease_id` as a fencing token.
- Treat `lease_expires_at` as takeover eligibility, not automatic lease revocation. A lease becomes stale only when the room's current `(lease_id, turn_id)` no longer matches the caller's values.
- Treat exact process death as stronger than timeout. If the exact owner or reserved-recipient process is known absent, expose immediate takeover eligibility and mark that member inactive.
- Never infer process death from `pid` alone.
- On claim-timeout takeover, reject the immediately prior owner when another active takeover candidate exists.
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

Handoff and membership errors use the same structured form:

```json
{
  "error": "invalid_handoff",
  "message": "handoff.next_action must be non-empty",
  "field": "next_action"
}
```

```json
{
  "error": "unknown_member",
  "message": "pass_stick target must be an active room member in the MVP.",
  "to_agent_id": "gemini:session-1"
}
```

Owner mutation error precedence is deterministic:

1. If `expected_turn_id` does not match the room's current `turn_id`, return `turn_mismatch`.
2. If the turn matches but `owner`, `agent_id`, or `lease_id` does not match the current owner epoch, return `stale_lease`.

This keeps "I am writing against the wrong epoch" distinct from "I am in the current epoch but do not hold the current fencing token."

## Deadlock Prevention

The protocol avoids permanent deadlock by combining:

- finite claim timeouts for reserved recipients,
- renewable leases for active owners,
- exact process-gone detection for owners and reserved recipients when metadata is available,
- takeover after missed claim or missed lease,
- prior-owner takeover fallback when no other active candidate exists,
- explicit stale state,
- read-only room inspection via `get_room_state` and `get_room_events`.

The server does not silently auto-transfer ownership when a lease expires. It marks the state recoverable and requires an explicit `takeover_stick` call. This keeps recovery auditable and prevents surprise parallel work.

Because the MVP has no daemon, expiry is evaluated lazily on reads and writes. A room row may still store `state = 'owned'` after `lease_expires_at`; `get_room_state` and `wait_for_turn` should report the derived state as `stale_owner` or `takeover_available`. The next successful heartbeat, release, pass, or takeover transaction writes the new projected state.

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

Every mutation re-reads the relevant room row inside its transaction and verifies fencing conditions (`lease_id`, `expected_turn_id`, membership, timeout eligibility) before committing. This makes the "two processes see stale state and both try to claim" race impossible: one commits, the other re-reads and returns `not_yet`.

### wait_for_turn across processes

`wait_for_turn` is implemented as bounded polling. Each server process polls `path_rooms` and `room_events` for the requested room at a short interval (250 ms recommended) up to `max_wait_ms`. Changes made by any other process become visible on the next poll.

Earlier design sketches included a cursor over the most recent monotonic `event_seq`, but the implementation did not consume it. The MVP keeps `wait_for_turn` cursor-free; resumable event replay belongs to `get_room_events` / future `tt events --follow`.

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

Recommended defaults (product scale, sized for real agent work rather than chat turns):

```ts
owner_lease_ttl_ms         = 45 * 60 * 1000;       // 45 minutes
heartbeat_interval_ms      =  5 * 60 * 1000;       // 5 minutes
claim_ttl_ms               = 20 * 60 * 1000;       // 20 minutes
wait_for_turn_max_wait_ms  = 30 * 1000;            // 30 seconds
wait_for_turn_poll_ms      = 250;                  // transport polling cadence
presence_ttl_ms            =  4 * 60 * 60 * 1000;  // 4 hours
waiter_grace_ms            = 10 * 1000;            // 10 seconds
```

Timeout meanings:

- `wait_for_turn` max wait is only a polling budget. The client should call again if it returns `not_yet`.
- `wait_for_turn_poll_ms` is how often a waiting process re-reads room state during a single long poll.
- `claim_ttl` is how long a reserved recipient has exclusive first right of refusal before others may take over.
- `owner_lease_ttl` is how long an owner may remain silent before takeover becomes possible.
- `presence_ttl` determines whether a member is active for sequence selection and takeover eligibility.
- `waiter_grace_ms` is the short window used to identify recent waiters and to avoid immediately recycling the turn while a fairer known member is between wait polls.

Rationale for these defaults: a real agent turn often runs 20-30 minutes (plan-and-edit, build-and-verify, review-and-respond), and a human collaborator walking through a few rooms may easily be idle for an hour without being "gone." Earlier drafts inherited chat-scale defaults (5-minute lease, 10-minute presence) which would silently open takeover windows mid-turn. The selected values accept a slower takeover response in exchange for not interrupting legitimate long work; operators who want faster response can shorten them via per-room policy once that ships.

These timers are fallback recovery, not the only recovery path. When the server can prove that the exact spawning process is gone, it should expose `owner_gone` or `recipient_gone` immediately instead of waiting for timeout. Ownership timings (lease, claim, presence) are the product-facing knobs; transport timings (wait max, poll cadence) are unchanged because they only affect polling efficiency, not ownership semantics.

Per-room policy is expected to become a first-class need quickly (batch workflows want longer TTLs; interactive workflows want shorter claims). Storing timeouts on the room record rather than as global server defaults is the recommended near-term extension, enabled via `set_room_policy`.

Even before per-room policy ships, the effective policy must be part of the `join_path` response so holders can schedule heartbeats from server truth rather than from compiled-in defaults.

## Persistence Model

### File Layout

State lives in a single SQLite database at a predictable per-user data directory:

- **Linux and macOS**: `$XDG_DATA_HOME/talking-stick/rooms.sqlite` if `XDG_DATA_HOME` is set, otherwise `~/.local/share/talking-stick/rooms.sqlite`.
- **Windows**: `%APPDATA%\talking-stick\rooms.sqlite`.

For this tool, the shared Linux/macOS default is intentional. Talking Stick is a CLI/MCP developer utility, and using `~/.local/share` on both Unix-like platforms keeps scripts, docs, backups, and troubleshooting consistent across machines.

Override:

- `TALKING_STICK_DATA_DIR` sets an explicit directory. If set, the database lives at `$TALKING_STICK_DATA_DIR/rooms.sqlite`. This is the recommended way to isolate test databases and to keep per-project state when that is desired.

The server creates the directory on first run if it does not exist. All rooms (across all workspaces on the host) share the single database file — keeping them together is what makes ancestor lookup a simple indexed query rather than a filesystem traversal.

### Schema

```sql
CREATE TABLE path_rooms (
  room_id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  sequence_index INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  reserved_for TEXT,
  pending_handoff_event_seq INTEGER,
  turn_id INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  claim_expires_at TEXT,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canonical_path)
);

CREATE INDEX path_rooms_canonical_path_idx
  ON path_rooms (canonical_path);

CREATE TABLE room_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_wait_at TEXT,
  status TEXT NOT NULL,
  host_id TEXT,
  pid INTEGER,
  process_started_at TEXT,
  session_kind TEXT NOT NULL,
  display_name TEXT,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
);

CREATE TABLE room_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,   -- claim | release | pass | takeover | close
  from_agent_id TEXT,
  to_agent_id TEXT,
  handoff_json TEXT,          -- NULL for claim | takeover | close
  reason TEXT,                -- populated on takeover events
  created_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id)
);

CREATE INDEX room_events_room_seq_idx
  ON room_events (room_id, event_seq);

CREATE INDEX room_events_room_turn_idx
  ON room_events (room_id, turn_id);
```

Ancestor lookup uses the `canonical_path` index: given a request path `P` and resolved workspace root `W`, generate ancestor paths from `P` up to `W` in code and issue a single `IN` query against `canonical_path`, picking the longest match. At small scale this is microsecond-fast; at very large scale consider materialized paths.

`room_events` is append-only. `path_rooms` is a projection of the event stream for fast reads. The event log is also the takeover recovery context: a new owner after `takeover_stick` reads recent events to reconstruct what was happening before the prior owner went silent.

`room_members` stores the process metadata needed for exact local liveness checks. If `pid` and `process_started_at` are unavailable on a platform, those columns may be null and the server falls back to timeout-based recovery for that member rather than making unsafe pid-only guesses.

Heartbeats update `path_rooms.lease_expires_at` and `updated_at`; they are not written to `room_events` by default. Otherwise waiters would wake up on routine heartbeat traffic.

`path_rooms.pending_handoff_event_seq` points at the release or pass event that should be returned to the next successful claimant. It is cleared when a claim or takeover succeeds.

## Agent Operating Instructions

Harnesses using this MCP server should follow these rules:

1. Before joining, call `list_rooms` to see what is already happening in the workspace.
2. Join using `join_path`. Accept the resolved `room_id` and `canonical_path` the server returns, even if they differ from what you asked for, because workspace root resolution or ancestor lookup may have attached you to a parent room.
3. Do not perform shared task work unless `wait_for_turn` returns `your_turn`.
4. When you receive `your_turn`, read the attached `handoff` before doing anything else. Load `artifacts[]` entries directly rather than re-exploring the workspace.
5. While working, heartbeat periodically.
6. Include `room_id`, `lease_id`, and `expected_turn_id` on every owner mutation. Do not send an `agent_id`; the server derives it from the MCP connection.
7. If any owner mutation returns `stale_lease`, `turn_mismatch`, or `unknown_member`, stop working and read current state.
8. To release the stick, construct a `Handoff` with a truthful `status` and an actionable `next_action`. Include `artifacts[]` entries when the next agent needs to load specific files or line ranges.
9. Use `release_stick` to continue the default sequence.
10. Use `pass_stick` to choose a specific active member.
11. Use `takeover_stick` only after `wait_for_turn` or `get_room_state` reports timeout eligibility. Include a reason. After a successful takeover, call `get_room_events` to reconstruct context from the most recent handoffs.

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
gemini extends section 2 and releases.
room reserves for codex, continuing the member sequence.
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

The room reserves the next turn for gemini, skipping claude. After gemini releases, the default sequence resumes from gemini's position in the member list.

## Example: Missed Recipient

```text
codex holds, then releases; reserved for claude.
claude does not claim before claim_ttl.
wait_for_turn now returns takeover_available to other active members.
codex attempts takeover -- REJECTED while gemini is active, because codex was
  the immediately prior owner.
gemini calls takeover_stick(reason = "claim timeout expired") -- ACCEPTED.
server grants gemini a fresh lease and increments turn_id.
gemini calls get_room_events to read codex's original handoff.
claude wakes up late and tries to claim -- REJECTED (stale turn).
```

## Example: Crashed Owner

```text
claude owns the stick.
claude stops heartbeating.
owner_lease_ttl expires.
get_room_state reports stale_owner.
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
Process B's client polls again and correctly sees claude as owner.
```

## Design Rationale

This section records the reasoning behind the load-bearing choices in this plan. Future maintainers should read it before proposing structural changes.

### Why workspace root plus ancestor lookup

An earlier draft resolved each request path to a canonical string and looked up rooms by exact match. That failed the common monorepo case: two agents running in `/repo/packages/foo/` and `/repo/packages/bar/` would create separate rooms and never coordinate, even when they were doing related work for the same repo.

Resolving to a workspace root before lookup matches the mental model developers already use for `.git`, `CLAUDE.md`, `package.json`, and every other workspace marker in common use. An agent at any depth under `/repo/` automatically joins the `/repo/` room if `/repo/` is the resolved workspace root, and no explicit room identifiers need to be coordinated out of band.

Because coordination is operator-initiated, the server does not actively prevent nested rooms. Operators know when they are starting a nested conversation and can request one explicitly via `force_new`.

### Why topics are deferred

Multiple concurrent conversations at the same path may become useful, for example a review in flight and a triage in parallel. But topics also weaken the central simplicity of the tool: "agents in this workspace share this room."

The MVP keeps one default room per workspace path. That makes the agent instructions shorter, avoids accidental topic mismatch, and keeps path membership as the primary mental model. If real usage needs concurrent rooms, topics can be added as an extension without changing the ownership and lease protocol.

### Why the handoff is structured and mandatory

The protocol's original shape treated ownership transfer as metadata about the lock with a free-text note attached. But in practice the expensive operation in a multi-agent handoff is not the lock transfer — it is context reconstruction by the new owner. Every agent that takes the stick starts by asking "what was happening before I got here?"

Making the handoff a structured artifact (`status`, `next_action`, `artifacts[]`) turns ownership transfer into state transfer. The `artifacts[]` entries map directly onto how LLMs consume code — path and optional line range — so the next owner can load exactly the relevant context without rediscovering it.

Requiring `status` and `next_action` to be non-empty is a small amount of server-side validation that prevents a large class of low-quality handoffs. Handoff quality still depends on harness behavior, which the protocol cannot enforce, so `join_path` returns a `handoff_template` hint that harnesses can surface to their models. The MVP keeps that template static across rooms to avoid turning prompting policy into room configuration before a concrete need exists.

### Why takeovers do not carry a handoff

A takeover happens precisely because the expected owner did not produce one. Requiring a handoff from the new owner would ask them to speak for the failed owner, which they cannot do truthfully.

Instead, the event log is the recovery context. `get_room_events` returns recent handoffs, including the one the failed owner received when they took the stick. This is also why `get_room_events` is MVP rather than optional — without it, the takeover recovery story is broken.

### Why `turn_id` increments on grant, not on release

Incrementing on grant keeps fencing math trivial: the current `(lease_id, turn_id)` pair always matches exactly one epoch, and release merely ends that epoch without starting a new one. A pending reservation is not a new epoch; it is a waiting room. Incrementing on release would create a window where a slow releaser and a fast new claimant disagree about the current epoch.

### Why fairness is lightweight

Strict round fairness sounds attractive, but it adds state and policy complexity to the part of the system that must stay easiest to trust. It also creates awkward edge cases: a missed recipient, a single active member, a stale owner, or a deliberate explicit pass can all look like fairness violations even when continuing is the useful behavior.

The implementation uses a lightweight release policy instead: recent waiters are ranked by "never held the stick" first, then oldest prior ownership, then sequence order. If the fairest known member is not currently inside a wait poll, a short grace window gives them a chance to reappear before a less-fair member can claim. This covers the important anti-monopoly case without turning explicit pass, recovery, or single-member rooms into fairness violations.

### Why takeover is explicit rather than automatic

The server could auto-transfer ownership the moment a lease expired. It does not, because silent promotions are the source of most "surprise parallel work" incidents in real coordination systems. An explicit `takeover_stick` call requires an agent to name a reason and produces an auditable event, making recovery visible in the log.

### Why shared SQLite instead of a daemon

Agent harnesses in this ecosystem spawn MCP servers as subprocesses, typically one per harness invocation. A daemon-based coordination server would require lifecycle management (who starts it, when it shuts down, how it recovers from crashes) that adds operational complexity with little benefit at a single-host, single-user scale.

SQLite in WAL mode handles concurrent readers and a single writer at low latency without any additional process. Multiple MCP server processes can share the database file without coordination beyond what SQLite already provides. The cost is polling — `wait_for_turn` cannot be push-notified across processes — but a 250 ms poll interval is well within the latency budget for agent-to-agent handoffs.

A daemon mode remains open as a future optimization if polling becomes a bottleneck. It is not needed for the typical multi-tab workflow the MVP targets.

### Why `~/.local/share` on Linux and macOS

Writing coordination state to `~/.talking-stick/` would litter the home directory. Sending macOS to `~/Library/Application Support`, however, makes a CLI-first developer tool harder to script and explain consistently across Unix-like machines.

The MVP therefore uses the XDG-style location on both Linux and macOS: `$XDG_DATA_HOME/talking-stick` when set, otherwise `~/.local/share/talking-stick`. Windows uses `%APPDATA%\talking-stick`. The `TALKING_STICK_DATA_DIR` override exists for users who want per-project isolation, test databases, or a different local disk.

Centralizing all rooms in a single SQLite file (rather than one file per room) makes ancestor lookup a simple indexed query rather than a filesystem walk. It also means backups and migrations move a single file.

## Open Design Questions

The following questions are worth revisiting once the MVP has seen real use:

- Should non-owners be able to append notes, or would that encourage side-channel work that bypasses the handoff discipline?
- Should human/operator override remain a CLI-only escape hatch, or should MCP expose a separate admin tool with distinct audit semantics?

## Implementation Plan

1. Build a local TypeScript MCP server using the Node MCP SDK.
2. Use SQLite (via `better-sqlite3` or `libsql`) with WAL mode, resolving the database path to `~/.local/share/talking-stick` on Linux/macOS, `%APPDATA%\talking-stick` on Windows, and honoring `TALKING_STICK_DATA_DIR`.
3. Apply required pragmas on every connection; use `BEGIN IMMEDIATE` for all write transactions.
4. Detect non-local filesystems at startup and fail fast with a clear error.
5. Implement canonical path resolution, workspace root detection, and deepest-ancestor room lookup.
6. Implement `list_rooms`, `join_path` (with `force_new`), `get_room_state`, and member sequencing.
7. Implement the `Handoff` type with server-side validation of required fields.
8. Implement `wait_for_turn` as bounded polling with atomic claiming; attach the prior handoff to `your_turn` responses.
9. Implement `takeover_available` responses without auto-taking the stick.
10. Implement lease issuing, heartbeat, release (with handoff), explicit pass (with handoff), and takeover.
11. Implement `get_room_events` for both audit and takeover recovery.
12. Add tests for:
    - ancestor lookup (including nested rooms and `force_new`),
    - handoff validation errors,
    - stale leases,
    - simultaneous claims within one process,
    - **simultaneous claims across multiple concurrent processes** (spawn N processes, have them claim/release under contention, verify no state corruption),
    - explicit pass,
    - pass to unknown or inactive member rejection,
    - release sequence,
    - claim timeout and takeover,
    - prior owner rejected on claim-timeout takeover when another active candidate exists,
    - prior owner allowed on claim-timeout takeover when no other active candidate exists,
    - owner timeout and takeover,
    - owner process gone yields immediate `owner_gone` takeover availability,
    - reserved recipient process gone yields immediate `recipient_gone` takeover availability,
    - original reserved recipient claiming after claim timeout but before takeover,
    - expired owner heartbeating after lease timeout but before takeover,
    - dead owner or dead reserved recipient cannot reclaim after exact process-gone detection,
    - dormant rooms remain readable and resumable, rather than auto-closing,
    - event log reconstruction after takeover,
    - database path resolution across platforms and with `TALKING_STICK_DATA_DIR` set.
13. Add a small CLI or script for manual inspection during development.

Current first-slice test coverage:

- happy path: `join_path` -> idle `wait_for_turn` claim -> `release_stick` with handoff -> reserved recipient claim,
- handoff validation,
- stale lease rejection,
- turn mismatch rejection,
- deepest ancestor lookup,
- workspace-root room creation,
- `wait_for_turn` returns `takeover_available` after claim timeout,
- reserved recipient may still claim after `claim_ttl` until takeover commits,
- `wait_for_turn` returns `takeover_available` after owner lease timeout,
- expired owner may heartbeat before takeover commits,
- owner-timeout takeover fences stale owner writes,
- owner process death yields immediate `owner_gone`,
- reserved recipient process death yields immediate `recipient_gone`,
- dormant rooms stay readable and resumable,
- prior-owner takeover guard after claim timeout,
- multi-process contention against an idle room.

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
path_rooms       (with canonical_path unique key, current ownership projection,
                  and pending_handoff_event_seq)
room_members    (with join order and presence timestamps)
room_events     (with handoff_json payload on release and pass events)
```

MVP policy:

```text
data directory:          ~/.local/share/talking-stick on Linux and macOS
                         (or $XDG_DATA_HOME/talking-stick when set);
                         %APPDATA%\talking-stick on Windows;
                         override via TALKING_STICK_DATA_DIR
database file:           <data_dir>/rooms.sqlite, WAL mode, synchronous=NORMAL, busy_timeout=5s
concurrency:             shared database across server processes; BEGIN IMMEDIATE for writes;
                         wait_for_turn polls at 250 ms across processes
filesystem requirement:  local filesystem; NFS/SMB rejected at startup
room identity:           canonical workspace path, resolved via workspace root detection
                         plus deepest-ancestor lookup
room creation default:   attach to ancestor when one exists; require force_new to nest
topics:                  deferred extension, not MVP
release behavior:        reserve next active member in sequence
explicit pass behavior:  reserve active target member
takeover behavior:       another active member after timeout; timeout itself does not revoke
                         claim-timeout takeover skips the prior owner when another
                         active candidate exists
                         exact owner/recipient process death yields immediate
                         takeover availability without waiting for timeout
handoff requirement:     release_stick and pass_stick require non-empty status and next_action
recovery context:        get_room_events supplies prior handoffs to takeover winner
owner lease TTL:         45 minutes
heartbeat interval:      5 minutes
claim TTL:               20 minutes
presence TTL:            4 hours
close semantics:         no `close_room` tool in the MVP implementation;
                         rooms remain resumable and can become dormant
                         when nobody is live
wait_for_turn max wait:  30 seconds, polled at 250 ms
```
