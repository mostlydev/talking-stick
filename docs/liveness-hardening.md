# Liveness Check Hardening

Status: design proposal, under review

## Problem

The current liveness check in `createDefaultProcessLivenessChecker` (`src/service.ts:1405`) is too aggressive and produces false `gone` verdicts under three interacting conditions:

1. **Exact-string comparison on `process_started_at`.** The check is
   `inspection.startTime === metadata.process_started_at`. Any whitespace drift
   or format difference yields `"gone"` even when the pid is alive and is the
   correct process.
2. **Code-version skew between concurrent MCP server processes.** Two harnesses
   writing to the same SQLite DB can run different dist builds and therefore
   different parsing logic. One server writes `"u Apr 23 18:10:55 2026"` (pre-fix
   slice bug); another writes `"Thu Apr 23 18:10:55 2026"` (post-fix regex). The
   reader sees a mismatch and declares `"gone"` against a live process.
3. **No grace window.** A single failed `inspect()` call immediately flips the
   room state to `owner_gone` or `recipient_gone`. A transient `ps` failure, a
   pid-reuse blip, or an in-progress startup can all void an active lease.

Observed consequences in the 2026-04-23 session:

- `codex:f522db2a` held a fresh lease; another reader's server reported
  `owner_gone` within 60 s of the claim. This triggered an unwanted takeover.
- `claude:4d685f30` had a truncated stored `process_started_at` ("u Apr…") and
  was still marked `active` in that same server's view — proving the verdict
  depends on which server is evaluating, not just on the data.

## Goals

- `owner_gone` / `recipient_gone` only fires when the member is actually gone.
- Liveness is robust against format drift and code-version skew.
- Minimal API surface change; internal refactor preferred.
- Tested against the specific scenarios observed.

## Non-goals (this iteration)

- Storing `process_started_at` as epoch ms. Nice eventually; not needed if the
  string comparison is made tolerant. Defer unless P1–P4 prove insufficient.
- Heartbeat redesign. The existing `heartbeat` RPC stays. P3 only verifies that
  reads refresh `last_seen_at`.
- Session-kind-aware dispatch in the liveness checker. Considered and deferred:
  adds branching without clear benefit once P1 and P2 are in place.

## Plan

### P1 — Conservative liveness defaults

File: `src/service.ts:1405-1443` (`createDefaultProcessLivenessChecker`).

Current verdict table:

| pid present? | inspect() result | startTime match? | verdict |
|---|---|---|---|
| no | — | — | `unknown` |
| yes | `undefined` (cache miss) | — | `unknown` |
| yes | `null` or no startTime | — | `gone` |
| yes | exact equal | — | `alive` |
| yes | mismatch | — | `gone` |

Proposed:

| pid present? | inspect() result | startTime normalized match? | verdict |
|---|---|---|---|
| no | — | — | `unknown` |
| yes | `undefined` | — | `unknown` |
| yes | `null` (ESRCH or ps failure) | — | `gone` |
| yes | inspection succeeded, startTime trims equal | — | `alive` |
| yes | inspection succeeded, startTime mismatch | — | `unknown` *(was `gone`)* |

Rationale: a live pid whose startTime string drifts is far more likely to be the
original process with a format-drift bug than a distinct re-used pid. Treating
the mismatch as `unknown` defers the decision to the silence-grace layer (P2).
We only return `gone` when we *know* the pid is dead (ESRCH).

Implementation detail: normalize by `.trim()` on both sides; optionally also
collapse internal whitespace. Length mismatch after trim is the format-drift
signal — route to `unknown` rather than `gone`.

### P2 — Silence-grace gate for gone-state transitions

Files: `src/service.ts:1212-1253` (`inspectRoom`), and the symmetric
`inspectRoomForMutation` at `1255-1296`.

Currently:

```ts
state = ownerLiveness === "gone" ? "owner_gone" : …
```

Proposed:

```ts
const silenceMs = now.getTime() - Date.parse(ownerMember.last_seen_at);
const gonePersistent = ownerLiveness === "gone" && silenceMs > this.goneGraceMs();
state = gonePersistent ? "owner_gone" : (hasExpired(lease) ? "stale_owner" : "owned");
```

A momentary `gone` reading does not void an active lease; we require the member
to have been silent across the grace window too. Recommendation: derive the
grace from existing policy (`2 * heartbeatIntervalMs`) rather than add a new
public `gonePersistenceMs` field immediately. That keeps the behavior aligned
with the lease-renew cadence while avoiding a public surface expansion during
the hardening pass. Apply the same gate to the `recipient_gone` branch — see
open question below.

### P3 — Verify presence self-refresh on reads

Files: whatever currently calls `touchMember`. Audit required.

Sanity check: does every MCP request that identifies the caller refresh
`last_seen_at` as a side effect? Read paths like `get_room_state` must refresh
the caller even though they do not mutate the room. Without this, P2's silence
gate cannot protect a legitimately-busy owner who is reading but not writing.

Audit finding: this is not just a service-level check. Today `wait_for_turn`,
`heartbeat`, `release_stick`, `pass_stick`, and `takeover_stick` call
`touchMember`, but pure reads do not. `get_room_state` and `get_room_events`
currently have no caller identity in their service signatures, so P3 requires a
small API-plumbing pass through:

- `src/types.ts` / `src/commands.ts` to accept an optional caller identity on
  room-scoped reads
- `src/mcp-server.ts` to resolve the MCP caller and pass it through
- `src/cli.ts` `state` / `events` to derive identity and pass it through

`list_rooms` can stay a pure read for now; it is path-scoped rather than a
joined-room action.

### P4 — Regression tests

New suite (likely `tests/liveness.test.ts`, or extend `tests/talking-stick.test.ts`):

1. **Format drift stays alive.** Pre-load a member row with
   `process_started_at = "u Apr 23 18:10:55 2026"`; configure the inspector to
   return `"Thu Apr 23 18:10:55 2026"`. Liveness → `unknown`; room state stays
   `owned` (not `owner_gone`). Prevents regression of the exact bug we debugged.
2. **Transient inspection failure inside grace.** Owner claims; immediately the
   inspector returns `null` for one call then recovers. Room state must not flip
   to `owner_gone` during the grace window. After grace + sustained failure,
   state *does* flip.
3. **Recipient grace.** Reserved recipient has `last_seen_at` from an old join;
   process is gone. Before `claim_expires_at`, room state stays `reserved`;
   after `claim_expires_at`, takeover opens via claim-timeout, and any
   `recipient_gone` labeling is diagnostic only.
4. **Read activity refreshes presence.** Owner claims, then only performs
   `get_room_state` / `get_room_events` reads while the inspector reports
   ambiguous or failing liveness. The refreshed `last_seen_at` must keep the
   room out of `owner_gone` until the grace window is actually exceeded.

## Open questions

1. **Grace source of truth.** Dedicated `gonePersistenceMs` policy knob, or
   derive as `2 * heartbeatIntervalMs`? Recommendation: derive it first. That
   keeps this pass internal and API-light. Promote it to a named policy field
   later only if real deployments need independent tuning.
2. **Recipient-gone grace.** For a reserved-but-never-claimed recipient, the
   `last_seen_at` may legitimately be stale before they ever show up. Do we:
   (a) apply the same grace as owner-gone (simple, but means takeover takes
   10 min even when the recipient is obviously gone); or
   (b) keep recipient-gone fast-path based on process-check alone; or
   (c) use claim_expires_at as the grace boundary for recipients — takeover
   available when the claim itself has expired, regardless of pid liveness?
   Recommendation: (c). `claim_expires_at` is already the social patience window
   for a reserved turn. Before it expires, stay `reserved`; after it expires,
   takeover is available from claim-timeout regardless of pid liveness, and any
   `recipient_gone` labeling can become diagnostic rather than gating.
3. **Fragile pid-check retirement path.** Once P1+P2 are in place, the
   exact-string startTime check only serves as a weak anti-reuse signal. Do we
   keep it for defense-in-depth, or drop it in favor of pure pid-exists +
   silence-grace? Defer to a follow-up; keep it for now.
4. **Version-skew across concurrent servers.** Even with P1, two servers writing
   different normalized forms could still diverge. Mitigation: normalize on
   *write* as well (in `joinPath` and anywhere `process_started_at` is persisted),
   not just on compare. That way future rows are consistent. Existing rows get
   normalized on next refresh.

## Rollout

1. Land P1 behind tests (no behavior change unless a startTime mismatch happens
   on a live pid — which the current tests may not cover; add one for the new
   `unknown` path).
2. Land P2 with a derived grace helper (`2 * heartbeatIntervalMs`) and tests
   for grace / post-grace transitions.
3. Land P3 alongside the required caller-identity plumbing for room-scoped
   reads.
4. P4 tests as part of each step, not a separate final step.

No migration required; existing member rows are compatible. Rebuild `dist/` so
linked consumers pick up the fix (see CLAUDE.md "Runtime & Dogfooding Notes").

## Resolved decisions (from review iteration)

- **Q1 (visibility of `recipient_gone` after `claim_expires_at`):** Keep
  `recipient_gone` as a *diagnostic label* that continues to surface in the room
  projection when the recipient's process is gone. Do not gate behavior on it —
  `claim_expires_at` is the authority for when takeover opens. This preserves
  operator-visible signal about *why* a reservation went stale without letting
  the label drive policy.
- **Q2 (batch `wait_for_turn` owner-idempotency with P1-P4?):** Defer to a
  separate patch set. The P1-P4 drop is already three layers of change
  (liveness logic + state-machine gate + read-path identity plumbing + tests);
  bundling a protocol-behavior change on top inflates the review surface. Ship
  liveness-correctness first, then recovery-UX.

## Related Follow-up: Make `wait_for_turn` the single recovery entrypoint

Status: landed. Ships on top of the P1-P4 liveness drop as a separate slice so
the protocol-behavior change stays reviewable on its own.

Audit gap that drove this: harnesses were over-calling `get_room_state` because
`wait_for_turn` did not tell them enough. Two specific holes:

- If the caller already owned the live lease, `wait_for_turn` fell through to
  `not_yet` instead of returning the current turn/lease.
- `not_yet` only returned `cursor` + `room_state`, so harnesses needed an
  immediate `get_room_state` call to explain who owns the room.

What shipped:

1. **Owner-idempotent `your_turn`.** When `room.owner === caller.agent_id` and
   the caller's lease is still valid (`lease_expires_at` in the future),
   `wait_for_turn` returns `your_turn` immediately with the existing `turn_id`
   and `lease_id`, new reason `already_owner`, and `handoff: null` (the initial
   handoff was already consumed on the first claim). No new claim event is
   appended. If the owner's lease has already expired, the call does not
   short-circuit — the caller falls through to the normal takeover / not_yet
   logic so they cannot accidentally keep mutating with a stale lease.

2. **Enriched `not_yet` payload.** Returns `turn_id` unconditionally, plus
   optional `current_owner`, `reserved_for`, `lease_expires_at`, and
   `claim_expires_at` when they exist on the room. Harnesses and the CLI can
   now explain state without a follow-up `get_room_state`.

3. **CLI consequences.** `tt wait` no longer double-spawns a guardian when the
   same human runs `tt wait` twice: if `wait_for_turn` returns `already_owner`,
   the CLI reuses the existing session (and its guardian pid) and prints
   "Already holding the stick (turn N). Guardian <pid> is still active." The
   text formatter also surfaces the enriched `not_yet` payload, e.g.
   "Not your turn yet. codex:abc holds turn 3 (lease expires ...)."

4. **Type changes.**
   - `WaitForTurnResult.your_turn.reason` union gains `"already_owner"`.
   - `WaitForTurnResult.not_yet` gains required `turn_id` and optional
     `current_owner`, `reserved_for`, `lease_expires_at`, `claim_expires_at`.

5. **Tests.** Four new cases in `tests/talking-stick.test.ts`:
   - `wait_for_turn is idempotent for the current owner and returns the same lease`
   - `wait_for_turn not_yet payload carries ownership context`
   - `wait_for_turn not_yet payload exposes claim_expires_at while a handoff is reserved`
   - `wait_for_turn does not short-circuit to already_owner when the owner lease has expired`
