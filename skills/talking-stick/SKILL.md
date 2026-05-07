---
name: talking-stick
description: Use when working in a repo that coordinates multiple agent harnesses with Talking Stick (`tt` / `talking-stick`), or when the user asks you to avoid parallel work, wait your turn, pass structured handoffs, or coordinate with Claude, Codex, Gemini, or OpenCode in the same workspace. Also use when a workspace contains a `.talking-stick/` marker.
---

This skill teaches a harness how to behave in a Talking Stick workspace.

## Core Rule

Do not perform shared workspace edits, commits, migrations, or other owner-style work until you hold the stick.

If you only need status, read status. If you need to work, join and wait.

## When To Use

Use this skill when any of these are true:

- the user mentions `talking-stick`, `tt`, handoffs, turn-taking, or avoiding parallel work
- the repo is known to use Talking Stick coordination
- a `.talking-stick/` marker exists

Do not use this skill for ordinary single-agent work in repos that are not using Talking Stick.

## Workflow

### 1. Use The CLI

Use the `tt` CLI for all Talking Stick coordination. Do not use old Talking Stick MCP tools for repo coordination, even if an older install exposes them; the CLI is the source of truth. Current updates should remove stale Talking Stick MCP registrations automatically.

Useful commands:

- `tt whoami --json`
- `tt join --json`
- `tt wait --json`
- `tt try --json`
- `tt state --json`
- `tt events --after N --target any --json`
- `tt notes add "..." --json`
- `tt notes list --json`
- `tt events --follow --json`
- `tt msg send <recipient|room> "..." --json`
- `tt msg recv --follow --json` (messages-only fallback when an event-stream consumer is too broad)
- `tt release --stdin`
- `tt assign <agent_id|next> --stdin`
- `tt take --reason "..." --json`

Some workspaces may also have sibling receive processes running `tt events --follow`, `tt msg recv --wait`, or `tt msg recv --follow`; leave them alone unless the operator explicitly asks you to stop or restart them.

If coordination is required and `tt` is unavailable, say so briefly and ask the user whether they want to install or enable Talking Stick first. Do not pretend coordination is active.

Human CLI runs silently keep already-installed Claude Code, Codex, and OpenCode skill copies/symlinks aligned with the bundled Talking Stick skill. This is best effort and only updates existing installs; Gemini skills are registry-managed and should be refreshed with `tt install gemini` when needed.

### 2. Join The Workspace Room Once

On the first substantial task in a Talking Stick workspace, run:

```sh
tt join --json
```

Keep the returned room id and canonical path in mind. The current working directory is the implicit path for normal commands; pass an explicit path only when coordinating a different directory or intentionally selecting a nested room.

Right after joining, start a background ambient receiver so direct messages and turn passes/reservations surface as soon as they happen instead of waiting for the next time you poll:

```sh
tt events --follow --json
```

For `tt events --wait` and `tt events --follow`, the default target is `self`; add `--target any` only for audit/debug views. If your harness can stream a child process's stdout into the model's context (Claude Code's Monitor, Codex `attach`-style), this is enough — each line becomes an event you see mid-task. If your harness can only notice that a backgrounded command exits, use the polling fallback in §4.5. Without an ambient receiver, neither messages nor turn handoffs reach you between deliberate `tt wait` / `tt events` calls.

The ambient receiver is not a turn claimant. It never grants the stick and never starts the lease guardian. Keep using `tt wait --json` for ownership.

### 3. Wait Before Shared Work

Before making shared edits or running owner-style actions, run:

```sh
tt wait --json
```

The default wait timeout is `110s`, which is the normal active-coordination setting. If your harness has a shorter tool timeout, override with the longest safe value and immediately wait again when it returns without granting the turn. Do not busy-loop with short waits.

Possible outcomes:

- `your_turn`: you may proceed
- `not_yet`: do not mutate shared state; you may still plan, inspect, review, or talk with the user
- `takeover_available`: surface the reason and make takeover explicit
- `closed`: stop and explain that the room is closed

A successful `tt wait` or `tt take` starts an internal `tt guard` lease guardian and returns `guardian_pid` in JSON. Verify the field is present and the pid is alive before you start a long edit; the guardian is what keeps your lease from expiring after the foreground `tt wait` process exits. If `guardian_pid` is missing or the pid is gone, stop, run `tt wait` again to repair the guardian (it will detect the existing ownership and respawn the guardian), and only then continue. Do not kill that guardian.

### 4. While Waiting

Prefer to run `tt wait` in the background if your harness supports background commands. That keeps the foreground free for reading, planning, answering the operator, and watching OOB messages until your turn arrives.

Prefer wait cycles over scheduled wakeups. A direct long-poll stays aligned with other agents and usually notices a released stick within the same cycle. Use scheduled wakeups only when your harness cannot keep a wait running in the background.

Do not replace `tt wait` with an event receiver. `tt events --wait` is only a wake channel for messages and handoff/reservation events. If it exits with a pass, release, assignment, or message, process the event, then run or continue `tt wait --json`; do not touch shared files unless that wait returns `your_turn` and a live `guardian_pid`.

If you do not have the stick:

- do not make shared repo changes
- do not silently race another harness
- it is fine to read, plan, review, or help the user think
- tell the user who currently holds or is reserved the turn when that is useful

The wait is for active non-mutating work, not idle sleep. Re-read the holder's last handoff, follow up on its `artifacts[]`, investigate the area they are touching, and rethink the plan from your own angle. If you find something the holder should know, leave a durable note:

```sh
tt notes add "Finding or pointer for the current/next holder." --json
```

Room inspection exists to answer specific questions, not to poll. Do not run `tt state` after a routine `tt wait`; the wait result already says who owns or is reserved for the turn. Use `tt state`, `tt events --target any`, and `tt notes list` sparingly when the wait result is insufficient or you are debugging stale members, takeover, or history.

When you do take the stick, first read the attached handoff and load any useful `artifacts[]`, then run `tt notes list --json` once so you see what other members left for you.

### 4.5 Out-Of-Band Messaging

The talking stick guarantees single-writer authority over shared workspace state. It is not a chat protocol. For transient signaling, use messages.

Send:

```sh
tt msg send <recipient|room> "message body" --json
```

Recipient is a full `agent_id`, an unambiguous active display name, or the literal `room` for broadcast. `--interrupt` marks the message as time-sensitive; the receiver decides whether to act on it now.

Receive with the mode your harness can observe. The recommended primary path is the unified event stream you started in §2:

```sh
tt events --follow --json
```

That streams direct messages, broadcasts, and turn passes/reservations for you as a single ordered feed — one JSON event per line. Use it whenever your harness can stream a child process's stdout into the model's context. If the harness can only notice that a backgrounded command exits, use the polling fallbacks:

```sh
tt events --wait --after <last_event_seq> --json   # all event types
tt msg recv --wait --after <last_event_seq> --json # messages only
```

Restart with the returned cursor to resume. `tt msg recv --follow` still exists for harnesses that want a messages-only feed, but the event stream is preferred because turn handoffs use the same channel and a messages-only consumer silently misses them.

For Codex-style harnesses that cannot consume a continuous stdout stream, the safe loop is: keep `tt wait --json` as the ownership wait, and separately run `tt events --wait --after <last_event_seq> --json` as a short-lived wake process. An event wake can tell you to read, reply, or retry `tt wait`; it is never permission to edit.

Messages are public room events. Any room member can read them with `tt events --target any`. `to_agent_id` is routing, not an ACL.

Messages do not grant the stick. A non-holder paging the holder does not gain write authority. Keep waiting for your turn; messages are only a side channel.

### 5. While Holding The Stick

Holding the stick is for active work. The moment you stop actively editing, reasoning through edits, or asking the operator a blocking question, release or assign the turn. Do not idle-hold the room while waiting on long verification, non-blocking operator input, CI, or any other pause where another harness could make progress.

The `tt guard` process spawned by `tt wait` keeps the lease alive during active work. Later owner commands such as `tt release`, `tt assign`, and `tt take` must run under the same harness identity. If identity is ambiguous, use the exact active id with `TT_HARNESS_AGENT_ID=<agent_id>`.

### 6. Takeover Is Explicit

If `tt wait` reports `takeover_available`:

- explain why takeover is available (`owner_timeout`, `owner_gone`, `claim_timeout`, `recipient_gone`)
- do not silently take over just because it is possible
- if takeover is chosen, run `tt take --reason "..." --json`
- after takeover, run `tt events --target any --json` so you can reconstruct the last handoff before touching code

If the operator explicitly tells you to take over despite a reservation or live owner, use:

```sh
tt take --operator-requested --reason "operator requested takeover" --json
```

Do not invent this override yourself; it is for direct operator intervention.

### 7. Finish With A Real Handoff

When you are done with your turn, default to releasing:

```sh
tt release --stdin <<'JSON'
{
  "status": "Updated the CLI-only coordination plan and the bundled skill so harnesses use tt subprocesses for join, wait, OOB messaging, notes, and handoffs.",
  "next_action": "Review the plan and then start the code-removal pass.",
  "artifacts": [
    {
      "path": "docs/plans/2026-05-05-cli-only-coordination.md",
      "role": "review",
      "note": "CLI-only migration plan."
    }
  ]
}
JSON
```

Use `tt assign <agent_id> . --stdin` only when a specific named member must go next:

- they have unique context the next step requires
- they hold a credential or capability others lack
- the operator explicitly addressed the work to them

Otherwise release. Pinning turns between two agents is an antipattern because it can lock humans out of their own room.

Always include a non-empty handoff. Keep it tight: aim for roughly 150-300 words of `status`; reference commits by SHA instead of restating diffs, and use `artifacts[]` with path and role instead of pasting code.

Minimum handoff quality:

- `status`: what you finished, what changed, and what remains true
- `next_action`: the concrete next step for the next owner

Add `artifacts`, `open_questions`, and `do_not` when they will save the next harness real time or prevent rework.

### 8. After Release, Stay In The Loop

The default after `tt release` or `tt assign` is to re-enter the wait loop and keep waiting until your next turn arrives. Do not stop and ask the operator whether they want you back in the loop. Do not treat a handoff as end-of-session.

Exit the wait loop only when one of these is true:

- the shared task is explicitly finished
- you are the only active member and there is no one to hand off to
- the operator gives a direct redirect or stop

In every other case, after `tt release` or `tt assign`, go straight back into `tt wait --json`.

If the operator tells you to drop out of coordination, run `tt leave --json`. Rooms with no active members are deleted instead of kept as history, and long-idle rooms may be purged on later invocations.

If the room state shows ghost members from past sessions whose processes are gone, run `tt kick <agent_id> --json` to evict them. Use `--force` only when the operator explicitly tells you to remove a still-active member.

## Recovery And Inspection

Use these reads when you need context:

- `tt list --json`: discover active rooms under the current path
- `tt state --json`: authoritative current room projection
- `tt events --target any --json`: replay recent claims, releases, assignments, messages, and takeovers
- `tt notes list --json`: list durable notes
- `tt whoami --explain`: inspect identity resolution

Prefer `tt state` over guessing from local memory when ownership may have changed and you are not already looking at a fresh `tt wait` result.

## Behavior Priorities

In a Talking Stick workspace, prefer these properties in order:

1. no accidental parallel work
2. clear ownership
3. good handoffs
4. explicit recovery when someone stalls

Do not optimize for speed by cutting around the coordination protocol. The point of the protocol is to make multi-agent work predictable.
