# Park mode for `tt wait`

**Status:** Implemented in working tree (claude:b8175be6 + codex:0c293df7). Original checklist retained as design context.

**Origin:** Coordination churn observed during the guardian-contract session on 2026-05-10. After a no-work release, the just-released agent's next `tt wait` auto-claimed the idle room because the existing `shouldDeferIdleClaim` cooldown is gated on `hasOtherActiveRoomMember`, which was false when the other agent went briefly inactive. Sequence: claim → release → claim → release with no work in between (turns 247–248 in this room; turns 1205–1291 earlier with claude:b2c853ee). Independently surfaced from both sides; design draft in room note `722adc99-1f1e-4e83-a950-5176dce3ae1c`.

## Problem

`tt wait` is overloaded as two operations:

1. Wait for a turn that will be handed to me (reserved_for me, pass/assign to me, takeover).
2. Claim the room if it is idle (auto-claim).

The second operation is correct when the caller has work. When the caller has no work but is staying coordinated (waiting on operator input or other external signal), it produces the churn pattern. The existing `priorOwnerReleaseCooldownMs` heuristic helps but can't encode operator-wait intent — only the caller knows whether they have work.

## Design

Add a protocol-level opt-out for the idle auto-claim. The two operations split cleanly:

- **`tt wait`** (current behavior, unchanged): caller is willing to take the stick now. Auto-claim is on.
- **`tt wait --park`**: caller wants to stay coordinated but only act on explicit signals. Auto-claim is off. Already-owner, reserved-to-me, pass-to-me, and takeover-available still return `your_turn` / `takeover_available` normally.

**Protocol field:** `WaitForTurnInput.auto_claim?: boolean` (default `true`). The CLI flag `--park` sets `auto_claim: false`. Naming separation is deliberate — `auto_claim` is the precise protocol invariant; `--park` is the UX vocabulary.

**Filtered branches under `auto_claim: false`:**

- `!room.owner && !room.reserved_for` → `grantTurn` (service.ts:1107) is the **only** auto-claim path. Park returns `not_yet` with reason `auto_claim_disabled` here.

**Preserved branches:**

- already_owner (service.ts:1090) — true signal, return your_turn.
- reserved_for === caller (service.ts:1138) — explicit pass, return your_turn.
- recipient_gone / owner_gone / stale_owner / claim_timeout (service.ts:1122, 1146, 1162, 1173) — return takeover_available. Park = no automatic ownership, not blind recovery.
- closed (service.ts:1086) — unchanged.
- default not_yet (service.ts:1184) — unchanged.

**Fair routing:** parked agents stay eligible for `tt assign next`. Park opts out of automatic claim, not explicit routing.

**Cooldown:** `shouldDeferIdleClaim` is unchanged. Park is the explicit-intent mechanism; the cooldown is a heuristic for the no-park case. Tightening the cooldown to fire when alone would be a silent semantic change for plain `tt wait` callers and is the wrong tool.

## Implementation

### `src/service.ts`

Add `auto_claim?: boolean` to `WaitForTurnInput`. In `waitForTurnOnce` (line 1078), gate the idle branch:

```ts
if (!room.owner && !room.reserved_for) {
  const autoClaim = input.auto_claim ?? true;
  if (!autoClaim) {
    return {
      status: "not_yet",
      room_state: inspection.state,
      turn_id: room.turn_id,
      reason: "auto_claim_disabled"
    };
  }
  if (this.shouldDeferIdleClaim(room, input.agent_id, now)) {
    return { status: "not_yet", /* existing fields */ };
  }
  return this.grantTurn(room, input.agent_id, now);
}
```

Add `auto_claim_disabled` to the `not_yet` reason union.

### MCP surface

No MCP schema change is needed in the current CLI-only implementation. The older `src/mcp-server.ts` surface no longer exists; `src/commands.ts` carries the command-level `auto_claim` field through to the service.

### `src/cli/parser.ts`

Use `normalizeBooleanFlag(parsed, "park")` in the wait/try handler so `--park` can appear before or after the optional path. The generic parser still consumes the next non-`--` token by default; normalization restores that consumed token as a positional for this boolean flag.

### `src/cli/turn-commands.ts`

In `handleWaitCommand`:

```ts
normalizeBooleanFlag(parsed, "park");
const park = hasOption(parsed, "park");
const waitResult = await runtime.commands.waitForTurn(identity, {
  room_id: joined.room_id,
  max_wait_ms: isTry ? 0 : parseWaitTimeout(parsed),
  auto_claim: park ? false : undefined
});
```

Update `formatWaitResult` to print `Parked — auto-claim disabled; idle room left untouched.` when `status: "not_yet"` and `reason: "auto_claim_disabled"`.

### `skills/talking-stick/SKILL.md`

In §8 "After Release, Stay In The Loop", add after the "stop polling if only active member" rule:

> If you have no expected work and are blocked on operator input or external signal, use `tt wait --park` instead of `tt wait` to stay coordinated without claiming idle turns. Park returns `your_turn` only for explicit signals (reserved-to-me, pass/assign to me, takeover-available); it never auto-claims an idle room. Switch back to plain `tt wait` once you have work to do.

Add `tt wait --park` to the CLI list in §1.

### `README.md`

Add `--park` to the `tt wait` line in the CLI cheat sheet (~line 100). One-line description under it: "Stay coordinated without auto-claiming idle turns."

### `CHANGELOG.md`

Unreleased Added entry:

```
- **`tt wait --park`.** New flag opts out of idle-room auto-claim while keeping the agent coordinated for explicit passes, assignments, and takeover signals. Use when waiting on operator input without intent to take the next idle turn. Protocol-level field is `wait_for_turn.auto_claim` (default true).
```

## Tests

Add to `tests/talking-stick.test.ts` and `tests/cli.test.ts`:

- **service**: `waitForTurn with auto_claim=false on an idle room returns not_yet with reason auto_claim_disabled` (regression for this session's churn).
- **service**: `waitForTurn with auto_claim=false when reserved_for == caller returns your_turn`.
- **service**: `waitForTurn with auto_claim=false when caller is already owner returns your_turn`.
- **service**: `waitForTurn with auto_claim=false surfaces takeover_available for stale owner` (and for claim_timeout, recipient_gone, owner_gone).
- **service**: `waitForTurn with auto_claim=false returns not_yet when another agent owns the stick`.
- **service**: plain `waitForTurn` (auto_claim default true) still claims idle rooms — pin no-regression.
- **CLI**: `tt wait --park` against an idle room exits with not_yet, no guardian spawned, no claim event in the log.
- **CLI**: `tt wait --park` against a reservation-to-me returns your_turn with a live guardian.

## Out of scope

- No change to `shouldDeferIdleClaim` (line 2066) or `priorOwnerReleaseCooldownMs`.
- No new `tt park` verb. `--park` flag is the only surface in v1.
- No change to how parked agents are heartbeat-tracked; they remain active members.
- No change to fair-routing eligibility; parked agents stay in the `tt assign next` pool.

## Verification

`npm run typecheck && npm test && npm run build`. Manual smoke: in a two-agent room, agent A releases with no work, runs `tt wait --park --timeout 5s` — expect `not_yet, reason: auto_claim_disabled` and no claim event. Then agent B does `tt assign next` — agent A's next park wait should return `your_turn`. Then agent A releases and runs plain `tt wait --timeout 5s` — expect your_turn (auto-claim restored).

## Commit message

`Add tt wait --park for non-claiming coordination`
