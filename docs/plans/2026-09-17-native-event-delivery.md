# Native event delivery (#81)

## Workflow and invariants

An operator sends a message in chat. The durable room event exists before any wake is dispatched. A live receiver continues to receive through its existing wait. Without a live receiver, supported native endpoints receive an attributed JSON envelope containing the event itself. The recipient can answer from that envelope; no fetch is required.

Transport submission is not recipient acceptance: Claude can refuse inbound content after a successful socket write. Therefore the recipient acknowledges the envelope with `tt ack <token> --json`, a body-free, idempotent operation that never acquires a lease. Queued remains queued until acknowledgement or normal receiver delivery. Acknowledgement covers exact event identities, not a high-water cursor that could skip other messages.

States: durable event -> pending native batch -> transport queued/ambiguous (still unread) -> acknowledged. Definite transport failure permits fallback. Unknown outcomes remain recoverable through normal wait. An old or repeated envelope is deduplicated by event ID; acknowledgement is safe to repeat. A handoff describes work but still requires normal wait/claim and a live guardian before edits.

Messages arriving during an outstanding batch remain pending. Acknowledging that normal batch rearms delivery of its remainder. Interrupt acknowledgement does not clear an unrelated outstanding normal batch. If new directed work arrives after a batch has been unaccepted for five minutes, it rearms the stale batch with the same event IDs; silence never triggers periodic retries. Interrupt envelopes carry the urgent event and steer existing work; no forced cancellation. A live wait may race an interrupt, so event-ID deduplication remains necessary.

Payloads have a byte/event-count ceiling; oversized batches retain the complete durable events and use the fixed pull notification instead of truncating content. cmux retains its body-free fallback. No terminal shell interpolation of room content.

## Verification

Cover exact attribution and hostile delimiter content; normal and urgent delivery; queued/refused/ambiguous/failed outcomes; repeated ack; wrong recipient/session; later wait excluding only accepted events; unrelated unread events; messages arriving in flight; recipient restart; handoffs without ownership; bounded payload fallback. Exercise a real local chat sender and native harness delivery where available. Keep isolated test rooms separate from operator work.

## Scope

This change reuses registered native endpoints. Automatically joining previously unregistered harnesses from presence hooks is a separate installation/lifecycle concern; do not silently enroll unrelated sessions. Existing join/wait/standby endpoint registration remains supported.

## Review and live evidence

Claude independently reviewed the design and confirmed exact-event acceptance, idempotence and session binding. Review reduced envelope repetition and exposed a stale outstanding-batch problem; new directed work now rearms an unaccepted batch after five minutes. Interrupt acknowledgements deliberately leave unrelated normal batches intact, covered by a regression test.

Local validation: 596 tests passed, one skipped; typecheck and build passed. Live Claude events 18463 and 18467 arrived as full attributed bodies without a fetch, and durable receipt records confirm both acknowledgements. The Codex idle test was queued from a disposable real `tt chat` PTY in an isolated room (marker `7f21`); recipient acceptance is still pending until this active turn ends. This is not yet release acceptance.

## Verification record (2026-09-17)

Codex, live: an isolated chat event (18466) reached the Codex model as a queued
native envelope with the complete body, without `tt wait`; `tt ack` returned
`acknowledged` for that exact event; the sender's chat surface moved
`queued -> delivered` in place; a zero-duration self read starting before 18466
returned no events and `replayed: false`.

Claude, live: envelopes for events 18463, 18467, 18475, 18479, 18488 and the
18489/18491 batch arrived with full bodies and were acknowledged by token; each
`tt ack` returned `acknowledged` once and never a lease or a body. Compacted
envelope overhead measured at 576 fixed characters (header plus JSON scaffolding)
against 1,136 total for a 237-character message before compaction.

Claude, read-only on the live database at commit b986b56: every receipt for an
active member is consumed, acknowledged receipts are excluded from self waits
only, and the stale-batch retry heals rows written before the fix. The endpoint
for `claude:49512d87` has been stuck at `awaiting_wait = 1` since
2026-09-15T21:50 with no `batch_started_at`; the retry clause falls back to
`last_attempt_at`, so the next directed message to that member clears the batch
and redelivers instead of coalescing silently. That was the failure that
silently swallowed two operator messages on 2026-09-16.

Suite at b986b56: 596 passed, 1 skipped; typecheck and build clean.
