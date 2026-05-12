# Zombie Session Eviction (`/clear` Stale Stick Fix)

## Problem

When a harness like Codex or Claude Code runs `/clear`, the in-process
session resets but the host harness process keeps running. The room sees:

- old `agent_id` (derived from the prior `CODEX_THREAD_ID` /
  `CLAUDE_CODE_SESSION_ID`) still listed as owner or recipient
- liveness check via the stored `(pid, process_started_at)` still reports
  "alive" — because the harness process is in fact alive
- new session joins with a different `agent_id`, sees the room owned, and
  has no way to make progress

The old session can never reply (its thread is gone), so the room is
permanently stuck until an operator forces a takeover.

## Predicate

A member M in a room is **superseded** when, on `tt join` by a new member
M', all of the following hold:

- `M.harness_name == M'.harness_name`
- `M.harness_host_id == M'.harness_host_id`
- `M.harness_pid == M'.harness_pid`
- `M.harness_process_started_at == M'.harness_process_started_at`
- `M.harness_session_id != M'.harness_session_id`
- both members have non-null harness-instance metadata (legacy rows with
  NULL fields are skipped — safe migration)
- M is currently the room owner or reserved recipient

Non-owner, non-reserved members are not evaluated. They are harmless
(they cannot block coordination) and age out through the existing
presence TTL.

## Identity Capture

`(harness_pid, harness_process_started_at)` is the **harness root**
process identity — the user-launched Codex/Claude process, not any
guardian subprocess or the current MCP child. Codex and Claude both keep
this process alive across `/clear`, so it is the durable fingerprint.

`identity.ts` walks the process ancestry from the `tt` invocation back to
the deepest ancestor whose command matches a known harness name and
records that process's PID + start time as the harness root. The current
in-process session id (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, or
the ancestry-derived fallback) is recorded as `harness_session_id`.

These fields are written to `room_members` on join. They are independent
from the existing `pid` / `process_started_at` columns, which continue
to track the *currently active* process (initially the harness, later
the guardian once `tt wait` succeeds).

## Schema

Migration 6 (`src/db.ts`) adds five nullable columns to `room_members`:

- `harness_name TEXT`
- `harness_session_id TEXT`
- `harness_host_id TEXT`
- `harness_pid INTEGER`
- `harness_process_started_at TEXT`

All columns are nullable so the migration is safe for existing rows.
Rows with NULL fields are excluded from the supersession predicate.

## Guardian Propagation

`tt wait` and `tt take` spawn a `tt guard` subprocess that holds the
lease and rejoins the room with `session_kind: human_guardian`. The
guardian must carry forward the original harness-instance fields, not
its own (it is not a harness). This is done by passing
`--harness-name`, `--harness-session-id`, `--harness-host-id`,
`--harness-pid`, and `--harness-process-started-at` to `tt guard` on
spawn. The guardian merges them into its derived identity before
rejoining.

The result: the member row's `pid` / `process_started_at` columns get
overwritten with the guardian's process (correct for liveness), but the
`harness_*` columns stay pinned to the original harness root.

## Eviction Action

On a qualifying join, in one transaction:

1. `DELETE FROM room_members WHERE room_id = ? AND agent_id = ?` for each
   superseded member.
2. Append a `session_superseded` event with
   `from_agent_id = incoming`, `to_agent_id = superseded`, and a reason
   string identifying the harness.
3. If the superseded member was the room owner, clear
   `owner`, `lease_id`, `lease_expires_at`, and
   `pending_handoff_event_seq`.
4. If the superseded member was the reserved recipient, clear
   `reserved_for` and `claim_expires_at`. **Preserve**
   `pending_handoff_event_seq` so the next claimant still receives the
   original handoff.
5. Recompute `state` to `owned`, `reserved`, `idle`, or `closed` as
   appropriate.

The `joinPath` response includes a `warning` listing the superseded
agent ids.

## Event Type Choice: `session_superseded`

A new event type rather than reusing `kick`. Rationale:

- `kick` is operator-coded — humans reading `tt events` interpret a kick
  as an explicit intervention.
- A supersession is automatic, not operator-driven, and never blocks the
  new session.
- A dedicated type lets skill text instruct harnesses to treat it as
  informational, distinct from `takeover_available`.

The CLI's default event formatter renders `session_superseded` the same
way as any other event (timestamp, type, from→to, reason) — no special
display logic needed.

## What Stays Out

- No notification to the old session before eviction. By construction
  the old session cannot read or reply.
- No silent retention of a deactivated member row. The append-only event
  log is the audit record; member rows are operational state.
- No change to `tt take` / `takeover_available` semantics. The
  supersession path runs strictly on `tt join`, before any takeover
  decision.
- No change to plain human sessions. A `human_guardian` row is only
  subject to supersession when it carries harness-instance metadata from
  a harness-launched guardian; standalone human CLI rows have NULL
  harness fields and are skipped.

## Tests

`tests/talking-stick.test.ts` covers:

1. **Owner supersession.** Same-process new session joins, prior owner
   is deleted, `session_superseded` event recorded, room returns to
   `idle`, new session's `tt wait` immediately grants the turn with
   `reason: open_claim`.
2. **Different-process non-supersession.** A different Codex process
   joins; the existing owner is untouched; the new joiner gets
   `not_yet` and sees the original owner.
3. **Recipient supersession preserves handoff.** Prior recipient is
   evicted, but the handoff event remains pending; the new session's
   `tt wait` returns `reason: sequence` with the original handoff
   intact.

## Open Questions

None blocking. Possible follow-ups:

- Surface superseded events in `tt state --json` as a recent-history
  field for operators inspecting why ownership changed.
- Consider supersession during `tt wait` as a defensive sweep (currently
  join-only; depends on whether real-world failure modes show join
  being skipped).
