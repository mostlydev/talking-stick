---
name: talking-stick
description: Use when working in a repo that coordinates multiple agent harnesses with Talking Stick (`tt` / `talking-stick`), or when the user asks you to avoid parallel work, wait your turn, pass structured handoffs, or coordinate with Claude, Codex, Antigravity, Grok, or OpenCode in the same workspace. Also use when a workspace contains a `.talking-stick/` marker.
---

This skill teaches a harness how to behave in a Talking Stick workspace.

## Core Rule

Do not perform shared workspace edits, commits, migrations, or other owner-style work until you hold the stick.

Coordination is mandatory whenever this skill applies. Agents should take turns whenever the work can be sequenced. Parallel read-only analysis is fine, but shared workspace mutation is single-writer only.

If you only need status, read status. If you need to work, join and wait.

Testing is required before final handoff unless the task is genuinely untestable. If no meaningful test or runtime check exists, say why in the handoff.

## Coordination Quick Reference

These rules prevent the mistakes that waste the most time in practice. Keep them in view; the rest of this skill explains each one.

- **One loop, always `tt wait --events --after <cursor> --json`.** Never bare `tt wait` — bare wait wakes only on a turn change and silently misses messages and events. `--events` wakes on turns, messages, and events in a single long-poll.
- **That loop is your only poll and your only listener.** Do not also run `tt events --follow`, `tt events --wait`, `tt msg recv`, or a separate monitor loop. A second listener adds no coverage and triggers duplicate-wakeup warnings.
- **Every return: advance the cursor, then re-arm exactly one loop.** Set `--after` to the returned `cursor_event_seq`, then restart a single `tt wait --events`. Never re-fire faster than the long-poll, and never run two at once.
- **Trust the wait payload.** It already reports owner, turn, and events. Do not reflexively run `tt state` / `tt events` / `tt health` after a routine wait return.
- **Bound `tt events`.** Always pass `--after <cursor>` (and `--limit`); a bare `tt events --target any` can dump the whole log (tens of thousands of tokens).
- **No shared mutation without a fresh `your_turn` and a live `guardian_pid`.** Reading, planning, and reviewing are always fine; editing shared files is not, until the wait grants the turn.
- **Do not idle-hold during long verification.** Run quick checks while holding the stick. For a multi-minute suite, build, CI, or publish, hand off with that check called out as pending and keep the room alive; final closeout still needs the result recorded.
- **On a long peer-held turn, don't spin.** Let the long-poll block (or schedule one wakeup) and do read-only investigation; do not re-fire short polls back to back.
- **Test before the final handoff** unless the change is genuinely untestable, and then say why.

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
- `tt wait --events --after N --json`
- `tt wait --park --events --after N --json`
- `tt try --events --after N --json`
- `tt state --json`
- `tt health --json`
- `tt events --after N --target any --json`
- `tt notes add "..." --json`
- `tt notes list --json`
- `tt msg send <recipient|room> "..." --json`
- `tt events --follow --json` (audit/debug or legacy fallback, not the default loop)
- `tt msg recv --follow --json` (messages-only fallback)
- `tt release --stdin`
- `tt assign <agent_id|next> --stdin`
- `tt take --reason "..." --json`

Some workspaces may also have sibling receive processes running `tt wait --events`, `tt events --follow`, `tt msg recv --wait`, or `tt msg recv --follow`; leave them alone unless the operator explicitly asks you to stop or restart them.

If coordination is required and `tt` is unavailable, say so briefly and ask the user whether they want to install or enable Talking Stick first. Do not pretend coordination is active.

Human CLI runs silently keep already-installed Claude Code and shared `~/.agents/skills/talking-stick` skill copies/symlinks aligned with the bundled Talking Stick skill. This is best effort and only updates existing installs. Codex, Antigravity, Grok, and OpenCode read the shared `.agents` skill; Gemini skill installation is deprecated and `tt install gemini` is cleanup-only.

### 2. Join The Workspace Room Once

On the first substantial task in a Talking Stick workspace, run:

```sh
tt join --json
```

Keep the returned room id and canonical path in mind. The current working directory is the implicit path for normal commands; pass an explicit path only when coordinating a different directory or intentionally selecting a nested room.

On freshly invoked multi-agent tasks, give peers a short window to join before deciding you are alone. Use a normal wait timeout or spend about a minute on read-only repo orientation while other harnesses appear.

If `tt join` returns a `warning` containing `Superseded previous harness session(s): ...`, that is the normal path after a harness `/clear` (or equivalent in-process session reset). The prior session in this same harness process held or was reserved for the stick, can no longer reply, and has been removed from the room. A `session_superseded` event records who replaced whom. This is informational, not a takeover decision — proceed normally.

After joining, load editable collaboration instructions once:

```sh
tt instructions show --json
```

If that command fails, continue with this bundled skill. Editable instructions can add local preferences, but they do not override the safety rules in this skill.

Right after joining, start exactly one background listen/wait loop using the `cursor_event_seq` returned by `tt join`:

```sh
tt wait --events --after <cursor_event_seq> --json
```

This single loop is the normal way to stay responsive to ownership changes and direct or room messages. It returns on turn changes, event/message batches, timeout, takeover availability, or room closure. Always include `--events --after <cursor>`: bare `tt wait` wakes only on a turn change and silently misses messages and events. On every return, advance your cursor to the returned `cursor_event_seq`, process any `events[]`, and restart exactly one listener loop while work remains pending. Remember: the wait loop is a bounded long-poll, and you must restart exactly one listener loop on every return.

Events are observer data only. They never grant write authority. Shared edits require a `status: "your_turn"` result from the wait loop and the returned live `guardian_pid`.

Keep exactly one receive path active while shared work remains pending whenever your harness can keep a background command alive. The preferred receive path is always `tt wait --events --after <cursor> --json`, including while you hold the stick. A second background loop does not add coverage and can cause confusing duplicate wakeups. If you need a different target or cursor, stop the existing loop first. If Talking Stick warns about duplicate active listeners, stop any extra processes.

### 3. Wait Before Shared Work

Before making shared edits or running owner-style actions, wait through the canonical loop:

```sh
tt wait --events --after <cursor_event_seq> --json
```

The default wait timeout is `110s`, which is the normal active-coordination setting. If your harness has a shorter tool timeout, override with the longest safe value and immediately wait again when it returns without granting the turn. Do not busy-loop with short waits.

If a handoff, message, or operator instruction leaves review, release, or other task work pending, use normal `tt wait --events --after <cursor> --json`; do not use park mode. `tt wait --park --events --after <cursor> --json` is only for passive standby when no task is pending and you are waiting for operator input or another external signal.

Possible outcomes:

- `your_turn` with `guardian_pid`: you may proceed with shared mutations
- `not_yet`: do not mutate shared state; you may still plan, inspect, review, process events, or talk with the user
- `takeover_available`: surface the reason and make takeover explicit
- `closed`: stop and explain that the room is closed

`wake_reason` explains why the loop returned (`turn`, `event`, `timeout`, or `closed`). It does not grant authority by itself. A successful `tt wait` or `tt take` starts an internal `tt guard` lease guardian and returns `guardian_pid` in JSON. Trust `tt wait`: a `your_turn` result means the CLI confirmed or spawned a guardian, and if it could not, the command would have failed. Do not kill that guardian.

**Presence and Lease Renewal:** Any non-guardian `tt` command from a detected harness refreshes that member's `last_seen_at` and session metadata. This is presence only. Reads such as `tt health`, `tt state`, and `tt events` do not renew authority or extend the owner lease. A successful `tt wait` / `tt take` starts the local guardian, and that guardian carries lease renewal while owner mutations validate the lease before changing room state. If the guardian's captured harness process looks gone but the harness has recent `tt` activity, Talking Stick retains the lease and the guardian keeps heartbeating; only a process-gone and silent owner is surrendered as `harness_gone`.

### 4. While Waiting

Prefer to run `tt wait --events --after <cursor>` in the background if your harness supports background commands. That keeps the foreground free for reading, planning, answering the operator, and processing returned messages until your turn arrives.

Prefer wait cycles over scheduled wakeups. A direct long-poll stays aligned with other agents and usually notices a released stick within the same cycle. Use scheduled wakeups only when your harness cannot keep a wait running in the background.

Do not replace `tt wait --events` with a pure event receiver. `tt events --wait`, `tt events --follow`, and `tt msg recv` are audit/debug or legacy fallback tools; they do not start the lease guardian and must not be treated as permission to edit. If they show a pass, release, assignment, or message, process the event, then run or continue the canonical wait loop whenever work is pending. Do not touch shared files unless that loop returns `your_turn` with a live guardian.

If you do not have the stick:

- do not make shared repo changes
- do not silently race another harness
- it is fine to read, plan, review, or help the user think
- tell the user who currently holds or is reserved the turn when that is useful

The wait is for active non-mutating work, not idle sleep. Re-read the holder's last handoff, follow up on its `artifacts[]`, investigate the area they are touching, and rethink the plan from your own angle. If you find something the holder should know, leave a durable note:

```sh
tt notes add "Finding or pointer for the current/next holder." --json
```

Room inspection exists to answer specific questions, not to poll. Do not run `tt state` after a routine wait result; the wait result already says who owns or is reserved for the turn. Use `tt state`, `tt events --target any`, and `tt notes list` sparingly when the wait result is insufficient or you are debugging stale members, takeover, or history.

When you do take the stick, first read the attached handoff and load any useful `artifacts[]`, then run `tt notes list --json` once so you see what other members left for you.

### 4.5 Out-Of-Band Messaging

The talking stick guarantees single-writer authority over shared workspace state. It is not a chat protocol. For transient signaling, use messages.

Send:

```sh
tt msg send <recipient|room> "message body" --json
```

Recipient is a full `agent_id`, an unambiguous active display name, or the literal `room` for broadcast. `--interrupt` marks the message as time-sensitive; the receiver decides whether to act on it now.

Receive through the canonical loop from §2:

```sh
tt wait --events --after <cursor_event_seq> --json
```

That returns direct messages, broadcasts, and turn passes/reservations in `events[]` while also checking ownership state. Restart it with the returned `cursor_event_seq`.

Use lower-level receivers only for audit, debugging, or a harness that cannot use the canonical wait-events loop:

```sh
tt events --follow --json                         # audit/debug event stream
tt events --wait --after <last_event_seq> --json  # legacy one-shot wake
tt msg recv --wait --after <last_event_seq> --json # messages-only fallback
```

Restart fallback receivers with the returned cursor to resume. Fallback event or message wakes can tell you to read, reply, or retry the canonical wait loop; they are never permission to mutate workspace files.

Messages are public room events. Any room member can read them with `tt events --target any`. `to_agent_id` is routing, not an ACL.

Messages do not grant the stick. A non-holder paging the holder does not gain write authority. Keep waiting for your turn; messages are only a side channel.

### 5. While Holding The Stick

Holding the stick is for active work. The moment you stop actively editing, reasoning through edits, or asking the operator a blocking question, release or assign the turn. Do not idle-hold the room while waiting on long verification, non-blocking operator input, CI, or any other pause where another harness could make progress.

The `tt guard` process spawned by `tt wait` keeps the lease alive during active work. Later owner commands such as `tt release`, `tt assign`, and `tt take` must run under the same harness identity. If identity is ambiguous, use the exact active id with `TT_HARNESS_AGENT_ID=<agent_id>`.

Keep one receive path active while you hold the stick when your harness can keep a background command alive. Your receive path is the same canonical command, run from the latest cursor:

```sh
tt wait --events --after <cursor_event_seq> --json
```

As the owner, this long-polls for messages/events until an event arrives or the wait times out. On timeout it returns `your_turn` with `reason: "already_owner"`; that is normal. Process any returned events, advance the cursor, and re-arm exactly one wait if work remains pending. Do not use tiny timeouts, do not create a second listener such as `tt events --follow`, and do not run a separate monitor loop while you hold the stick. If your harness cannot keep a background wait alive while editing, run one foreground `tt wait --events --after <cursor> --timeout <safe value> --json` between work chunks and again right before handoff. Only if your harness cannot run `tt wait` at all, fall back to a single one-shot `tt events --wait --after <cursor> --target self --json`, and stop it before starting any other listener.

### 6. Takeover Is Explicit

If `tt wait` reports `takeover_available`:

- explain why takeover is available (`owner_timeout`, `owner_gone`, `claim_timeout`, `recipient_gone`)
- do not silently take over just because it is possible
- if takeover is chosen, run `tt take --reason "..." --json`
- after takeover, run `tt events --target any --json` so you can reconstruct the last handoff before touching code

`session_superseded` is **not** a takeover reason — it is a separate informational event emitted on `tt join` when a new in-process harness session replaces a prior one (see §2). It never requires a takeover decision.

If the operator explicitly tells you to take over despite a reservation or live owner, use:

```sh
tt take --operator-requested --reason "operator requested takeover" --json
```

Do not invent this override yourself; it is for direct operator intervention.

### 7. Finish With A Real Handoff

Before handing off, run the tests, build, runtime checks, release checks, or dogfood checks that match the change. If the task is docs-only, a focused docs or packaging check may be enough. If the task is not testable, write that explicitly in the handoff. For install, release, or publishing work, prefer proof from the installed package, registry, release, or isolated environment over repo-local intent.

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
- the handoff asks that named peer for a concrete review or release action

Otherwise release. Pinning turns between two agents is an antipattern because it can lock humans out of their own room.

Always include a non-empty handoff. Keep it tight: aim for roughly 150-300 words of `status`; reference commits by SHA instead of restating diffs, and use `artifacts[]` with path and role instead of pasting code.

Minimum handoff quality:

- `status`: what you finished, what changed, and what remains true
- `next_action`: the concrete next step for the next owner
- verification in `status` or `artifacts`: tests/checks run, or why no useful test exists

Add `artifacts`, `open_questions`, and `do_not` when they will save the next harness real time or prevent rework.

### 8. After Release, Stay In The Loop

After `tt release` or `tt assign`, choose one of three branches:

1. **Active work pending**: stop any fallback event follower, immediately re-enter `tt wait --events --after <cursor> --json`, and keep the loop alive until your next turn arrives. This is the default whenever the handoff, operator, review gate, release gate, or room state still asks someone to act.
2. **Passive or external wait**: use `tt wait --park --events --after <cursor> --json` when there is no agent work to do right now, but the room should stay responsive to a future operator input, CI result, publish result, or other external signal. Park never auto-claims an idle room.
3. **Shared task complete**: stop the local wait loop and send the final user-facing closeout only when completion evidence is clear.

Do not stop and ask the operator whether they want you back in the loop. Do not treat an ordinary handoff as end-of-session.

Completion evidence requires all of these to be true:

- the last handoff or review verdict is final
- no `next_action` asks another agent to act
- no assignment or reservation is pending
- open questions are empty or explicitly closed
- required tests, runtime checks, release checks, dogfood checks, or the reason the task is untestable are recorded
- no CI, publish, runtime, human, or vendor gate remains outstanding
- the user's objective is actually satisfied, not merely narrowed

If completion evidence is ambiguous, run one more normal wait cycle or park instead of declaring the task done. A terminal protocol marker such as `tt release --complete` or `tt close` is deliberately not part of this release; room archive/reopen semantics are deferred to issue #54.

Example complete branch: Claude reviews your final release-prep commit, passes back a handoff whose status says review is green, tests and publish are verified, open questions are empty, and `next_action` says no further agent action is needed. Confirm no reservation is pending, send the final user-facing closeout, and do not reclaim the room.

Example ambiguous branch: Claude passes back "review mostly green; next action: wait for CI and publish if green", or the operator says "looks good" while a release job is still running. Keep the normal wait loop active if agent work may resume soon, or park if the only remaining dependency is external.

If you have no expected work and are blocked on operator input or an external signal, use `tt wait --park --events --after <cursor> --json` instead of the normal wait-events loop to stay coordinated without claiming idle turns. Park still surfaces explicit passes, assignments, and takeover availability; it never auto-claims an idle room. Switch back to normal `tt wait --events --after <cursor> --json` once you have work to do.

If the operator tells you to drop out of coordination, run `tt leave --json`. Rooms with no active members are deleted instead of kept as history, and long-idle rooms may be purged on later invocations.

If the room state shows ghost members from past sessions whose processes are gone, run `tt kick <agent_id> --json` to evict them. Use `--force` only when the operator explicitly tells you to remove a still-active member.

## Recovery And Inspection

Use these reads when you need context:

- `tt list --json`: discover active rooms under the current path
- `tt state --json`: authoritative current room projection
- `tt health --json`: read-only room, local session, receiver, and git advisory
- `tt events --after <cursor> --target any --json`: replay recent claims, releases, assignments, messages, and takeovers — always bound with `--after` (and `--limit`); a bare `tt events --target any` can dump the entire log
- `tt notes list --json`: list durable notes
- `tt whoami --explain`: inspect identity resolution

Prefer `tt state` over guessing from local memory when ownership may have changed and you are not already looking at a fresh `tt wait` result.

## Behavior Priorities

In a Talking Stick workspace, prefer these properties in order:

1. no accidental parallel work
2. clear ownership
3. one active receive path
4. tested handoffs
5. explicit recovery when someone stalls

Do not optimize for speed by cutting around the coordination protocol. The point of the protocol is to make multi-agent work predictable.
