# Room blockers and status

**Status** · Proposed

A room blocker is a durable request for a higher-level decision. It gives the operator or orchestrator enough context to decide from outside the room. Talking Stick is the shared-writer turn within a room. Adding, reviewing, or resolving a blocker is a room metadata action and does not acquire that turn.

## What goes in a blocker

| Field | Purpose |
| --- | --- |
| Title | A short label for the decision queue |
| Facts | What is known and why the current authorization is insufficient |
| Decision requested | A concrete question and the scope of the requested authority |
| Work affected | The action that must stop and the work that can continue |
| Options and evidence | A recommended answer, meaningful alternatives when available, and concrete references such as a PR head |

The service adds a stable ID, room, revision, author, timestamps, and lifecycle state. Use bounded plain text. Keep credentials and sensitive argument bodies out of the record. An example decision is “May I publish the reviewed commit as v0.37.0? CI passed on the release SHA. Local verification can continue while publication waits.”

## Lifecycle and authority

1. **Open.** A joined member records the facts and exact question as soon as work requires authority the member lacks. The request gets a stable ID. Retries with the same request key return the same blocker. Link to an existing blocker when it asks the same question.
2. **Review.** Any member can propose a resolution without the stick or decision authority. Record each proposal with its author and revision. A member replaces its current proposal instead of appending a discussion thread. Any joined member can correct facts or withdraw a stale blocker with a reason. These changes are audited and cannot grant permission. Changes to facts or the request increment the revision and make proposals on older revisions visibly stale. Store relevant evidence anchors, such as an event number or commit SHA, so reviewers can check whether the blocker still applies.
3. **Decide.** The operator, or a manager explicitly delegated authority for the room and decision scope, records an approval or decline against the exact revision the decision maker saw. The service rejects stale revisions and resolves a concurrent race with one atomic decision. The decision records who acted, when, the rationale, and any limits. A room role, the stick, a visitor request, and an identity override do not confer decision authority. Start with the trusted local operator path and explicit local delegation. A remote manager needs an authenticated identity and authorization transport before receiving write access. A same-OS-user process with write access to SQLite remains trusted under the current local model. Reject `--agent` for decisions. An instruction typed directly into a harness can be attached as a relay with provenance. Only an authorized caller or an authenticated operator event turns it into a decision.
4. **Continue.** Members review open blockers on join, handoff, and before taking dependent action. Continue work within existing authority where possible. Release the stick and park if the remaining work depends on the decision. A recorded decision is visible to the whole room and wakes interested members through the existing receive path and remains visible if no one receives the wake. The next writer verifies the decision still covers the action and takes the stick normally. Harness tool permissions remain enforced by the harness.

Keep at most **three open blockers per room** as a proposed starting limit. At the limit, finish safe cleanup, update the status, release, and park. Revisions, proposals, and decisions remain available. The service refuses a fourth open blocker atomically with links to the existing three. It never evicts or silently combines requests. Use evidence to withdraw an obsolete item or have the operator decide the priority.

Never expire blockers just because a message was unread or the author left. Keep an open blocker discoverable when a room has no live members. Preserve its identity when the declared room reopens and refuse room removal with unresolved blockers. Retain decided, withdrawn, or superseded items in history. Carry a blocking authorization forward by reference only while the same scope and evidence still apply.

## Operator and manager surfaces

- Add blocker summaries and counts to `tt room brief` and `tt room list --all`. Include rooms with open blockers even when empty. Provide a direct, versioned JSON read and decision route for same-host orchestrators without joining, acquiring a lease, or asking a member to relay the request.
- Proposed command group: `tt blocker add`, `list`, `show`, `revise`, `propose`, `decide`, and `withdraw`. The decision route accepts an explicit ID, expected revision, decision, and reason. A harness can invoke it when acting under a verified delegation. Keep free-text chat and visitor replies as discussion surfaces.
- In `tt chat`, put the open count on `/rooms` and the room header, and open `/blockers` for the facts, proposals, and authorized decision action. Link the same list from `/go` and let handoffs reference blocker IDs. Use the same service calls from the CLI and TUI. Show a stale revision with a refresh action before accepting any decision.
- Add a short **room status** line alongside those summaries. It answers “where does this stand?” in one current sentence. The stick holder, operator, or authorized manager can explicitly replace it with an audited update. Show who updated it and when. Fall back to the latest handoff status when nobody has posted a status line. Compute the open-blocker count from records. Leave harness input detection out of the first version.

Reuse the room event stream for blocker lifecycle events and decision notifications. The blocker record is the source of truth, including for managers that reconnect or scan periodically. A native approval or user-input prompt can point to an existing blocker or lead a worker to create one through the skill. The supervisor continues to handle the native protocol reply on time and never waits for a room decision before sending that reply.

## Implementation and acceptance

1. Add the lifecycle store, room retention, atomic limit and revision checks, audit events, and outside-room reads. Cover concurrent decisions and last-member departure.
2. Add authorized decisions, CLI JSON, chat navigation, and skill behavior together. Exercise stale decisions, unauthorized callers, member proposals without the stick, and a manager resolving from outside an otherwise empty room.
3. Add the status line and verify the outside-room loop with headless Claude and Codex. Each should open a decision, release the stick while blocked, receive a decision, and continue only the action the recorded scope allows.

## Existing headless operation

The published v0.36.0 macOS arm64 binary passed a disposable two-worker check. One Codex harness registered supervised Claude and Codex workers. Both joined the same room, and each answered a separate visitor request from outside the room. Both workers were stopped afterward. This exercised `tt supervisor add` and visitor messaging. The proposed [one-command headless launcher](2026-11-13-headless-rooms.md) is a separate step.
