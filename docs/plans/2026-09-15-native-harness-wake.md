# Native harness wake

Status: design, not implemented. Tracks #69.

## Problem

An operator (or peer) sends `@codex ...` from `tt chat`, but the target harness is not running `tt wait`: its model turn ended, or it sits in standby. Today the message waits in the room until the agent next polls. The only wake path is cmux keystroke injection (`cmux send` plus Enter), which requires the harness to run inside cmux and types into its terminal.

We want the harness to wake natively, with no keystrokes, no model polling, and no tokens spent while idle.

## Goals

- A directed message, assignment, pass, or pending handoff for a member with no live receiver wakes that member once.
- It works for Claude Code and Codex without cmux. cmux remains the fallback, and Grok follows later.
- The wake text is fixed and body-free. The agent reads the real message through `tt wait`, with sender attribution, so wake delivery can't carry injected instructions.
- Delivery status is honest: `woken` only when the harness confirmed a turn started, `queued` when it accepted the wake without confirmation.

Non-goals: waking a harness that isn't running at all (no live session to deliver into), cross-machine delivery, and broadcasts waking anyone.

## Findings

### Claude Code: per-session inbox socket (verified)

Documented in [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), section "The session's inbox socket", Claude Code v2.1.224+ on macOS and Linux:

- Each session binds a Unix socket and exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to its hooks and Bash commands. `tt` runs as one of those Bash commands, so it can read both.
- A client sends newline-delimited JSON. The first line, `{"type":"auth","token":"<token>"}`, is optional on macOS/Linux and required on Windows. Then `{"type":"user","message":{"role":"user","content":"<text>"}}`. The binary's own debug help prints this exact form.
- An idle session starts a new turn with the message. A busy session reads it between tool calls.
- Inbound controls: `crossSessionInbound` `accept` / `hold` / `refuse`. With no setting, a session that bypasses permission prompts holds unverified messages for approval. A connection authenticated with the session token counts as the session's own child and is delivered.
- Limits: plain text, a 30-second first-line deadline, per-sender rate limiting and repeat dropping, a 50-message queue. Same machine and same OS user only.

Verified on 2026-09-15 by posting the auth line plus a user line to the running session's socket from a child process. The message arrived in a bypass-permissions session.

### Codex: `codex queue` (source-verified, live test outstanding)

Codex's installed CLI exposes `codex queue --thread <thread-id> --message <text>`, which calls the app-server's `thread/queue/add`. In the matching source, `QueueService.enqueue` calls `wake_if_loaded`, which dispatches through `start_turn_if_idle`. A loaded idle thread therefore starts a turn, and a busy one receives the message after its current turn. What happens for an unloaded or interrupted thread is not yet validated. A probe against a nonexistent thread ID reached `thread/queue/add` and was rejected with "no rollout found", so the command can reach a server without the persistent daemon socket.

`CODEX_THREAD_ID` is already a harness identity signal in `tt`.

## Design

### Endpoint registry

Add a private table instead of more `room_members` columns, so secrets can't leak through the existing `SELECT *` member mapping:

```sql
CREATE TABLE member_wake_endpoints (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  transport TEXT NOT NULL,          -- 'claude_inbox' | 'codex_queue' | 'cmux'
  address TEXT NOT NULL,            -- socket path | thread id | workspace:surface
  secret TEXT,                      -- claude token; never returned by any read API
  harness_session_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  last_wake_batch_seq INTEGER,      -- dedupe: highest event seq already woken for
  last_status TEXT,                 -- 'woken' | 'queued' | 'failed'
  last_error TEXT,
  PRIMARY KEY (room_id, agent_id, transport),
  FOREIGN KEY (room_id) REFERENCES path_rooms(room_id) ON DELETE CASCADE
);
```

- Registration happens in `tt join`, `tt wait`, and `tt standby` when the caller has a verified harness identity. Claude registers when `CLAUDECODE=1` and both messaging variables are set. Codex registers from `CODEX_THREAD_ID`. cmux registers as today.
- The endpoint is scoped to `harness_session_id` and `host_id`. A different session or host replaces the row and bumps `generation`, which wipes the old secret.
- Rows are deleted on leave, kick, and harness-session supersede. The table cascades with the room.
- `tt health --verbose` shows `transport`, `recorded_at`, `last_status`, and `last_error` only. `secret` and the full socket path never appear in state, health, events, handoffs, or logs; tests assert this against the JSON output.
- The data directory's DB file stays owner-only (0600). Startup maintenance warns if it isn't.

### When to wake

A wake is due when all of these hold:

1. The event is directed at the member: a `message_sent` with `to_agent_id`, an assignment or pass to it, or a pending handoff hint it would act on. Broadcasts never wake, and room interrupts keep today's owner-only rule.
2. The member has no live receiver (`room_receivers` liveness is not `alive`).
3. The endpoint hasn't already been woken for an unread batch: `last_wake_batch_seq` is below the member's saved wait cursor, or null. One wake covers everything that arrives until the member runs `tt wait` again. Advancing the member's cursor clears the batch.

This replaces nothing in standby. Standby's `standby_wake_pending` becomes one trigger feeding the same dispatcher.

### What is sent

A fixed text, generated by `tt`, containing only a sanitized sender display name and the room's canonical path:

```
[talking-stick] New message from <sender> in <path>. Run `tt wait --json` to read it.
```

No message body, handoff text, or agent-controlled string beyond the sanitized name.

### Delivery and failover

Dispatch runs after the write transaction commits, in the sending process, like `flushPendingWakes` does today. Transports are tried in order: native first, then cmux.

| Transport | Call | Timeout | Result |
| --- | --- | --- | --- |
| `claude_inbox` | Unix socket connect, auth line, user line, end | 2 s | Written and flushed: `queued`. `ENOENT` / `ECONNREFUSED` / `EACCES`: definite failure, fall back. Timeout after write: ambiguous, no fallback, `last_error` set. |
| `codex_queue` | `codex queue --thread <id> --message <text>` | 10 s | Exit 0: `queued`, or `woken` if the output confirms a started turn. Non-zero with a thread-not-found error: definite failure, fall back. Timeout: ambiguous, no fallback. |
| `cmux` | existing `cmux send` + Enter | 5 s | Existing semantics. |

Fall back only on definite non-delivery, so a slow success can't produce two wakes. Claude's inbox never acknowledges delivery, so its best status is `queued`. Whether the session held or refused the message isn't observable, and the docs say so.

For `tt chat`, dispatch must not freeze the UI: run it off the input path with the same bounded timeouts, and show the result as a dim notice (`codex: woken`, `claude: queued`, `grok: not listening`).

### Status surface

`SendMessageResult.delivery_status` keeps `receiver | endpoint | pending | unreachable` and gains `delivery_transport` plus `delivery_state` (`woken | queued | failed`). `tt chat` renders these per recipient.

## Security notes

- The Claude token grants delivery into one session. It is same-OS-user data, the same boundary as the socket permissions and our SQLite file. It is stored only in `member_wake_endpoints.secret`, never echoed, and deleted with the endpoint.
- The wake text is fixed, so a malicious peer can at most cause one generic nudge per unread batch, bounded again by Claude's own per-sender rate limits.
- `crossSessionInbound: refuse` in a user's Claude settings silently disables native wake. Document it, and keep cmux as the fallback.

## Testing

- Unit: env parsing for each harness, generation bump and secret wipe, dedupe across a batch and reset on cursor advance, failover classification (definite vs ambiguous), and secret absence in state/health/events JSON.
- Integration: a fake Unix socket server asserting the exact two lines and the timeout paths; a fake `codex` executable on `PATH` covering exit 0, not-found, and hang.
- Live, manual: an idle Claude Code session outside cmux is woken by `@claude` from `tt chat`; an idle loaded Codex thread by `@codex`; a bypass-permissions Claude session still receives the message; `crossSessionInbound: refuse` falls through to `queued` with no wake.

## Open items

- Validate `codex queue` against an unloaded or interrupted thread, and whether its output distinguishes woken from queued.
- Grok: investigate its hook system (`~/.grok/hooks`) and any session inbox. Test with a live Grok member.
- OpenCode and Antigravity: cmux fallback only, until a native path is found.
