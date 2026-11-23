# Room blockers and status

**Status** · Agreed design direction

A blocker is a short, durable room item with an ID, author, time, facts, and one question. It tells an operator or orchestrator what decision is needed and which work depends on it. The talking stick remains the shared-writer turn.

## Raise, answer, and clear

- A joined member raises a blocker when progress requires a decision outside its current authority. Reuse an open blocker that asks the same question. Keep at most three open items per room. At the cap, finish safe cleanup, release the stick, and park. Below the cap, continue independent work and release when only blocked work remains.
- Any member can propose an answer in an ordinary message referencing the blocker. A member can also withdraw an obsolete item with a reason. If the question itself changes, replace the item with a new ID so an answer to the original cannot close the replacement.
- Close a blocker by sending a text message explicitly marked **resolves** with its ID. Inside a room, send it through `tt msg send`. Outside, add a room-targeted send that posts the same type of message without joining. Keep `tt room ask` for requests that expect replies. In chat, choose **Resolve** from `/blockers` and compose the text.
- Post the message and clear the matching open item in one transaction. Keep the resolution message and derived sender in room history. A repeat or concurrent close returns the existing resolution. The room wakes through its existing message delivery path.
- Use the existing machine and invoking user session trust. A caller who can send the explicit local room message through the operator or outside-room surface can resolve it. Require the explicit marker and a matching open ID. Free-text discussion leaves the item open. The change needs no new login or delegation model.

Raising, proposing, withdrawing, or resolving a blocker does not require the stick or confer it. Agents still take a turn for shared edits. The message text supplies the answer, including any scope or limits. On join and handoff, check which open items still apply.

## Surface the queue

Put the open count in the chat header and `/rooms`. Link to `/blockers` from the room and its navigation. Show open items in `tt room brief` and surface rooms with blockers in `tt room list --all`, even after the last member leaves. Protect unresolved items from ordinary room expiry or removal.

Use the last handoff as the initial room-door status, alongside the open count. An explicit one-line status override can follow if the handoff proves insufficient.

## First slice

Ship a complete local loop together: raise, list, resolve by message, withdraw, and navigate the same items in `tt chat`. Test duplicate and concurrent resolutions, stale IDs, the cap, outside-room resolution after the last member leaves, and blocker visibility in the chat header and navigation. Exercise the loop from a headless room once implemented.

The published v0.36.0 macOS arm64 binary already passed a disposable headless smoke test. Supervised Claude and Codex joined the same room, answered separate requests from outside it, and stopped cleanly. This exercised `tt supervisor add` and visitor messaging. The [one-command headless launcher](2026-11-13-headless-rooms.md) remains planned.
