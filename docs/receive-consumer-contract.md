# Receive Consumer Contract

`send_message` appends `message_sent` events to the room event log. `wait_for_events` is the canonical receive primitive. CLI consumers (`tt events --wait`, `tt events --follow`, `tt msg recv --wait`, `tt msg recv --follow`) and future harness-native consumers should share the same cursor and retry rules.

## Delivery

- Delivery is at least once. Consumers must tolerate duplicates after restart.
- `event_seq` is monotonic per database and is the receive cursor.
- Consumers should persist the highest processed `event_seq` after each emitted batch.
- Directed messages are routing only. Any room member can read messages through `get_room_events` or `tt events --target any`.

## Receive Modes

- Use `tt events --follow --after <cursor>` when the harness can monitor stdout from a long-running child. Each output line is one `RoomEvent` JSON object.
- Use `tt events --wait --after <cursor>` when the harness can only notice process completion. The process exits after the next matching batch or timeout; restart it with the latest processed cursor.
- Use `tt msg recv --wait` or `tt msg recv --follow` only when the consumer intentionally wants messages without turn handoffs.
- If no `--after` is supplied in `--wait` or `--follow` mode, the CLI starts from the current event tail to avoid flooding a new consumer with history.
- A one-shot `tt msg recv --after <cursor>` is a non-blocking drain operation.

## Filtering

- `target=self` is the default for `--wait` and `--follow`. It receives direct messages to the caller plus broadcasts from other agents. It excludes the caller's own broadcasts.
- `target=any` receives all matching events/messages and is intended for audit/debug views.
- `--from <agent>` resolves a full `agent_id` or unambiguous active display name and is enforced server-side.

## Consumer Responsibilities

- Keep `wait_for_turn` / `tt wait` running separately. Receive processes do not claim or grant the stick, even when they return pass, release, or assignment events.
- Treat an event wake as a prompt to read, reply, or retry `tt wait`. It is not permission to mutate shared files; only a `your_turn` wait result grants ownership.
- Decide how to surface `delivery_hint=interrupt`; the server only records the hint.
- Dedupe on `event_id` if restart replay is possible.
- Treat message bodies as room-visible text, not private data.
