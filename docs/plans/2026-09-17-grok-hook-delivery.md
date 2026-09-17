# Grok hook delivery

The operator requested the same room integration for a newly joined Grok session.
Grok 1.0.34 exposes active-turn hooks but no verified external inbox for waking
an existing idle session. Its installed hook documentation and live payload
probes establish PostToolUse, PostToolUseFailure and normal Stop feedback.

## Implementation

- Keep the lifecycle identity recorder and shared Claude-compatible Stop guard.
- Install a separate `talking-stick-inbox.json` for the three feedback events.
  `--no-guard` disables ownership guarding, not message delivery.
- Only an existing, joined Grok member with matching session and local host can
  receive events. Ambiguous membership fails open with a diagnostic.
- Open existing state without creating or migrating it. Quiet tool calls use
  reads only; reserve pending deliveries atomically when work exists.
- Deliver the same attributed native-event envelope and exact-event ack token.
  Acknowledgement records receipt, never grants writer ownership.
- Bound envelopes to 8 KB, below Grok's documented 10,000-character clipping.
  Page complete events after acknowledgement; an oversized single event gets a
  bounded pull notice and remains unread. Never truncate a body or ack token.
- Reserve each hook batch for 60 seconds to avoid repeating feedback on every
  tool. A later hook retries unaccepted work after that interval. Duplicate
  tokens can cover the same IDs; event-ID dedup and idempotent acknowledgements
  deliberately handle this. A normal wait also consumes pending receipts.
- Record urgent receipts when the event is written so hook delivery does not
  depend on a successful external wake or envelope formatting attempt.
- Ignore shutdown, recursive Stop and subagent feedback. All hook errors fail
  open. No new native idle transport or `can_self_wake` claim is introduced.

## Verification

- Full Vitest suite: 622 passed, 1 skipped.
- Typecheck and build passed.
- `tt install grok --link` installed the new inbox file and preserved the
  existing lifecycle and guard files.
- Regression coverage: exact bodies, acknowledgement/replay, no ownership,
  pending tails, expiry retry, normal wait recovery, size paging and oversize
  fallback, malformed input, foreign session/host, ambiguous membership,
  repeated hooks, database failure, urgent delivery, installer idempotence,
  independent uninstall and `--no-guard` delivery retention.
- Live Grok reload, actual hook feedback and acknowledgement: pending.
- Independent final candidate review: pending.

No merge or publication performed.
