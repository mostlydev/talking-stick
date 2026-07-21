---
name: talking-stick
description: Use in a Talking Stick workspace or when the user asks agents to coordinate, take turns, hand off work, or use tt.
---

# Talking Stick

Talking Stick gives several harnesses one shared-writer turn and one room event stream. Use the `tt` CLI.

## The loop

1. Join once:

   ```sh
   tt join --json
   tt instructions show --json
   ```

2. Keep exactly one signal-only long-poll running while agent work remains:

   ```sh
   tt wait --json
   ```

   `tt wait` now includes room events and resumes from the cursor saved in `cli-sessions.json`; agents do not manage `--events` or `--after` during normal work.

   The CLI silently renews its bounded service long-poll in the same OS process. Silence does not make the command exit. It exits only for an actionable turn/event/close signal or an explicit `--timeout`.

3. If the harness tool yields a process/session handle, the wait is still running. Poll or resume that same handle only when the harness requires it to receive output. Do not launch another `tt wait`, narrate timer-driven polls, or add a short `--timeout` to make the tool call return.

4. When `tt wait` actually exits, process its events and result. Start one successor wait if shared work remains.

The wait subprocess is the receive path; its output is not magically injected into model context. A harness must surface or poll the running process output. Never use global `pkill`; stop only a process handle you started.

Do not build a polling loop from `tt try`, `tt state`, `tt health`, `tt events`, or `tt msg recv`. Those commands are diagnostics or lower-level human tooling. Reusing a stale explicit cursor replays the same event and makes a nominal long-poll exit immediately.

## Write authority

Only a successful `tt wait` or `tt take` result containing both of these authorizes shared workspace mutation:

- `status: "your_turn"`
- a live `guardian_pid`

Messages, event wakes, notes, room state, and `takeover_available` do not grant the turn. Read-only investigation is always allowed.

Interpret wait results directly:

- `your_turn`: load the handoff, read notes once, and work.
- `not_yet`: remain read-only and keep the single wait alive.
- `takeover_available`: explain the reason; use `tt take --reason "..." --json` only after an explicit takeover decision.
- `closed`: stop.

Park does not auto-claim or become an ordinary release recipient. An active owner must release before parking. Use `tt wait --park --json` only when a live process listener is useful.

When no agent work is pending and the current model turn should end, prefer event-driven standby:

```sh
tt standby --wake cmux --json
```

Standby records parked intent and returns immediately. A direct message, assignment, pass, or pending-handoff hint wakes the registered cmux surface once. Room broadcasts do not wake it. Use `--wake manual` outside cmux; manual standby cannot self-wake, so an operator must later run `tt wait --json`.

## Messages and notes

Send conversational OOB messages without passing the turn:

```sh
tt msg send <agent|room> "message" --json
```

Receive messages through the same `tt wait --json` process. Messages are room-visible routing, not private ACLs and not write authority.

Use `tt notes add "finding" --json` for durable findings that should survive a handoff. Do not use notes as a second chat stream.

## Handoff

Test before handing off unless no meaningful check exists. Keep quick checks inside the turn; do not idle-hold while waiting on long CI or external work.

Normally release with a concise JSON handoff:

```sh
tt release --stdin <<'JSON'
{
  "status": "What changed and what verification passed.",
  "next_action": "The concrete next step.",
  "artifacts": []
}
JSON
```

Use `tt assign <agent> --stdin` only when a named member has unique context, credentials, or an explicit review request. Otherwise release to fair ordering.

After handoff:

- active agent work remains: run one `tt wait --json`;
- only an external/operator signal remains: run `tt standby --wake cmux --json` and let the model turn end;
- the shared objective is proven complete: stop and report the result.

Completion requires a final verdict, no pending assignment or next action, closed questions, and recorded verification. Do not stop merely because one implementation turn ended.

## Recovery

Use these only to answer a specific diagnostic question:

```sh
tt state --json
tt health --json
tt events --after <cursor> --limit <n> --target any --json
tt notes list --json
tt whoami --explain
```

If `tt` reports duplicate listeners, identify the process handles you created and stop the extras. Do not kill unrelated room processes. If coordination is unavailable, say so rather than pretending it is active.
