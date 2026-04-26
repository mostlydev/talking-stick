---
name: talking-stick
description: Use when working in a repo that coordinates multiple agent harnesses with Talking Stick (`tt` / `talking-stick`), or when the user asks you to avoid parallel work, wait your turn, pass structured handoffs, or coordinate with Claude, Codex, Gemini, or OpenCode in the same workspace. Also use when a workspace contains a `.talking-stick/` marker or when the MCP tools `list_rooms`, `join_path`, `wait_for_turn`, `heartbeat`, `release_stick`, `pass_stick`, `takeover_stick`, `get_room_state`, `get_room_events`, `add_note`, or `list_notes` are available.
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
- the Talking Stick MCP tools are available in the current harness

Do not use this skill for ordinary single-agent work in repos that are not using Talking Stick.

## Workflow

### 1. Check that Talking Stick is actually available

Prefer the Talking Stick MCP tools when they are available. If they are not available but the `tt` CLI is on `PATH`, use the CLI instead (`tt list`, `tt join`, `tt wait`, `tt state`, `tt release`, `tt pass`, `tt takeover`). Do not treat missing MCP tools alone as proof that coordination is unavailable.

If coordination is required and neither the MCP tools nor the `tt` CLI are available, say so briefly and ask the user whether they want to install or enable Talking Stick first. Do not pretend coordination is active.

### 2. Join the workspace room once

On the first substantial task in a Talking Stick workspace:

1. call `join_path` with the current workspace path
2. keep the returned `room_id`
3. note the returned policy, especially `heartbeatIntervalMs`

If the workspace is nested, accept the resolved canonical path the server returns.

### 3. Wait before doing shared work

Before making shared edits or running owner-style actions, call `wait_for_turn`.

Use the `room_id` returned by `join_path`. Do not pass the original filesystem path to `wait_for_turn`; path resolution belongs to `join_path`, and waiting must target the exact resolved room. This avoids ambiguity when a nested workspace resolves to an ancestor room or when multiple rooms could exist under the same tree.

Keep the wait input minimal:

```json
{
  "room_id": "<room_id from join_path>",
  "max_wait_ms": 60000
}
```

`max_wait_ms` is optional. Use the longest client-safe wait you can support: 60000 ms is a good MCP default when the harness can tolerate it; 120000 ms is fine only when the tool/client timeout is known to exceed that. If the call times out at the harness layer, fall back to a shorter value and call again. Do not send `cursor`, even if an old tool schema still exposes it; `wait_for_turn` is cursor-free, and resumable event replay belongs to `get_room_events`.

Possible outcomes:

- `your_turn`: you may proceed
- `not_yet`: do not mutate shared state; you may still plan, inspect, review, or talk with the user
- `takeover_available`: surface the reason and make takeover explicit
- `closed`: stop and explain that the room is closed

### 4. While waiting

**Prefer to run the wait in the background.** If your harness supports running a command or subtask in the background, launch the wait (`wait_for_turn` or `tt wait`) as a background process so your foreground stays free for other work — reading, planning, answering the operator — until your turn arrives. Blocking the whole harness on the wait defeats the point.

**Even better: use a wakeup if your harness supports one.** Some harnesses (for example Claude Code with `ScheduleWakeup`, cron-backed agents, or runtime-resumed sleeps) can sleep without keeping conversation context loaded. Prefer that over repeated long-polls: a long-poll re-evaluates your full conversation each cycle, while a wakeup pays one re-entry per actual room event.

Wakeup pattern:

1. Probe `wait_for_turn` with `max_wait_ms: 0`.
2. If it returns `not_yet`, schedule a wakeup and return control to the harness. Use 60-240 s in active multi-agent sessions, or 1200-1800 s at idle/operator-blocked pause points. Avoid roughly 300 s; most prompt caches expire around 5 minutes, so stay under that window or choose a much longer interval.
3. On wakeup, repeat from step 1.

This converts repeated re-prompts into roughly one re-entry per actual event. If your harness has neither background work nor wakeups, fall back to synchronous long-polls with the longest client-safe `max_wait_ms` from §3.

Whether the wait runs in the foreground or the background, call it **once** with the client-safe `max_wait_ms` budget from above and let the server long-poll. When it returns without `your_turn`, call it again. Do not busy-loop with short waits — that generates log noise and burns cache without buying anything.

Coordination is meant to be lightweight. `wait_for_turn` is the only long-running call you should make. Room-inspection RPCs (`get_room_state`, `get_room_events`) exist to answer specific questions ("who holds the stick right now?", "what was in my predecessor's handoff?") — do not call them on a timer or repeatedly just to check on another agent's progress. If you find yourself inspecting the room more than a few times per turn, stop; long-poll on `wait_for_turn` instead and trust the protocol.

If you do not have the stick:

- do not make shared repo changes
- do not silently race another harness
- it is fine to read, plan, review, or help the user think — or any other work that does not mutate shared state
- tell the user who currently holds or is reserved the turn when that is useful

If you notice something the current owner should know — a subtle invariant near code they are about to touch, a related bug you spotted while reading, a pointer to a doc — leave a note with `add_note` instead of sitting on it until your next turn. Notes do not grant permission to edit shared files; they are observations and pointers, not coordination bypasses.

When you do take the stick, first read the attached handoff and load any useful `artifacts[]`, then run `list_notes` once so you see what other members left for you. The owner's turn is the right place to act on a note, not to debate it with its author mid-turn.

### 5. While holding the stick

If the task may run longer than a few minutes, heartbeat periodically.

Use the cadence from `join_path.policy.heartbeatIntervalMs` when available. Do not invent your own cadence if the server already told you one.

**Holding the stick is for active work.** The moment you stop actively editing, reasoning through edits, or asking the operator a blocking question, release or pass. Do not idle-hold the room while waiting on long verification, non-blocking operator input, CI, or any other pause where another harness could make progress.

### 6. Takeover is explicit

If `wait_for_turn` reports `takeover_available`:

- explain why takeover is available (`owner_timeout`, `owner_gone`, `claim_timeout`, `recipient_gone`)
- do not silently take over just because it is possible
- if takeover is chosen, call `takeover_stick`
- after takeover, call `get_room_events` so you can reconstruct the last handoff before touching code

### 7. Finish with a real handoff

When you are done with your turn:

- use `release_stick` for normal sequence continuation
- use `pass_stick` only when a specific member should go next

Always include a non-empty handoff.

**Keep handoffs tight.** Handoffs are persisted in the event log and re-read on claims. Aim for roughly 150-300 words of `status`; reference commits by SHA instead of restating diffs, and use `artifacts[]` with path, line range, and role instead of pasting code. The handoff is the headline; long-form context belongs in `docs/` or a note.

Minimum handoff quality:

- `status`: what you finished, what changed, and what remains true
- `next_action`: the concrete next step for the next owner

Add `artifacts`, `open_questions`, and `do_not` when they will save the next harness real time or prevent rework.

Example:

```json
{
  "status": "Added the MCP smoke test and verified it against two clients sharing one SQLite database.",
  "next_action": "Run the same handoff path through the human CLI and confirm pass/release behavior matches the MCP flow.",
  "artifacts": [
    {
      "path": "tests/mcp-smoke.test.ts",
      "role": "review",
      "note": "End-to-end MCP adapter smoke coverage."
    }
  ],
  "open_questions": [
    "Should install-skill default to copy or link for local development?"
  ]
}
```

**`pass_stick` requires the target to be an active room member.** If the intended recipient's harness session has ended and they show as `inactive` in `get_room_state.members`, `pass_stick` can return `unknown_member`. Use `release_stick` instead; the next active sequence member becomes the reserved recipient automatically, and a re-joining target can claim through the normal sequence path.

### 8. After passing or releasing, stay in the loop

**The default after `release_stick` or `pass_stick` is to re-enter the wait loop and keep waiting until your next turn arrives.** Do not stop and ask the operator whether they want you back in the loop. Do not treat a handoff as end-of-session. In a multi-agent workspace, the expectation is: work on your turn, hand off, wait for your next turn, repeat.

Stopping to ask questions after every pass defeats the coordination protocol — the operator wired you into a room so that you *would* keep showing up without being asked.

Exit the wait loop only when one of these is true:

- the shared task is explicitly finished (the operator said so, or the final handoff marks the work complete)
- you are the only active member and there is no one to hand off to
- the operator gives a direct redirect or stop ("that's enough," "drop out of the room," a new unrelated task, etc.)

In every other case: after `release_stick` or `pass_stick`, go straight back into the wait loop (ideally backgrounded — see §4).

## Recovery and Inspection

Use these reads when you need context:

- `list_rooms`: discover active rooms under a path
- `get_room_state`: authoritative current room projection
- `get_room_events`: replay recent claims, releases, passes, and takeovers

Prefer `get_room_state` over guessing from local memory when ownership may have changed.

## Behavior Priorities

In a Talking Stick workspace, prefer these properties in order:

1. no accidental parallel work
2. clear ownership
3. good handoffs
4. explicit recovery when someone stalls

Do not optimize for speed by cutting around the coordination protocol. The point of the protocol is to make multi-agent work predictable.
