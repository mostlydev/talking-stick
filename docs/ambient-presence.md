# Ambient Presence: Shell Prompt, Event Stream, and Agent Skill

**Status:** Design sketch — not yet scheduled.
**Related:** [talking-stick-plan.md](talking-stick-plan.md)

## Purpose

Make room state *ambient* for everyone who enters a coordinated workspace — humans in their shells, and agents in their harnesses — so that awareness of the turn, the queue, and the lease does not depend on anyone remembering to query it.

The coordination primitive already exists (rooms, leases, handoffs, the state machine in `talking-stick-plan.md`). What is missing is the last-mile surface that makes it *felt*. Today, a human in a terminal has no indication that another agent is mid-turn on the repo they just `cd`'d into, and a waiting agent has no lightweight, replayable observer surface for room activity in either the harness UI or invoked shell helpers.

This document is intentionally a **layer** on top of the core protocol, not a rewrite of it. Ambient presence should project the existing room model into prompts, status queries, and followable events. It should not invent a second identity model, a second event model, or a different room-resolution rule.

## Vision

A concrete vignette of the target UX:

1. Human opens Claude Code in a repo with ambient presence enabled.
2. The agent notices the ambient-presence marker or instruction and reads room status.
3. It sees that Codex currently holds the stick and tells the human: *"Codex is holding the stick. I can watch the room and pick up when it becomes available — in the meantime, want to sketch requirements for the piece you mentioned?"*
4. A background observer stream tails room events. If the harness can also expose its protocol identity to spawned shells, the background task may additionally act as that participant; otherwise it remains observer-only.
5. The human and the agent design the next feature for ten minutes.
6. The background task sees a room transition or `wait_for_turn` result indicating the stick is now available.
7. The agent announces: *"Codex just released; I can take the turn now. Starting on the change we discussed."*

Parallel vignette for the shell: the human's `PS1` reads `~/repo 🥢 holding T42 $` when they hold the stick, `~/repo 🥢 waiting(2) $` when they are queued, and remains plain when they are outside any ambient-enabled workspace.

## Architecture

Four independent layers. Each is useful on its own; together they become invisible.

### 1. Discovery — "should the ambient layer engage here?"

How does anything know to engage the ambient layer at all? Options:

- **Repo marker directory** — a `.talking-stick/` dir at the workspace root, created manually for now and optionally by a future `tt init`.
- **Agent instruction file entry** — one line in `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` naming the skill.
- **User-global enablement** — a setting in `~/.config/talking-stick/config.toml` that opts the user into the shell prompt integration globally.

Important distinction: the marker directory is an **ambient-presence enablement signal**, not the authoritative definition of room scope. Room identity and room lookup still follow the workspace/path resolution rules in `talking-stick-plan.md`.

### 2. Runtime — what surfaces state

Two immediate surfaces, both driven by the local SQLite store:

- **Shell prompt fragment** — a `tt status --prompt` subcommand that prints a short PS1-safe string (or nothing). Wired into Bash `PROMPT_COMMAND`, Zsh `precmd`, Fish `fish_prompt`.
- **Background room event stream** — an extension of `tt events`, most likely `tt events --follow`, that emits one JSON line per room event to stdout and can resume from a stored `event_seq`.

The existing `tt wait` command keeps its current meaning: claimant-side wait for `your_turn` / `takeover_available`. Ambient presence should not overload `wait` into a second, room-wide event API.

A later extension may expose the same ambient state in **non-interactive invoked shells** (for example, harness command hooks or a `BASH_ENV` prelude). That is part of the broader ambient-presence story, but not part of the first shippable slice.

### 3. Identity modes — participant or observer

Ambient presence needs two distinct operating modes:

- **Participant mode** — the runtime can reliably infer or receive the harness identity that the MCP layer would use. In this mode, a spawned shell helper may join, wait, or claim on behalf of that participant.
- **Observer mode** — the runtime cannot reliably infer the harness identity. In this mode, ambient surfaces may read room state and tail room events, but they must not join the room or represent themselves as a protocol participant.

This distinction matters because `tt` also serves ordinary human terminals. A shell process launched from inside a harness must not silently become `human:<username>` and pollute room membership.

Current contract: known harness environment markers such as `CLAUDECODE=1`, `CODEX_THREAD_ID`, `GEMINI_CLI=1`, or `OPENCODE=1` make `tt` derive a harness-style identity before the human fallback. `TT_HARNESS_AGENT_ID=<agent-id>` exports the exact agent id directly. `TT_HARNESS_EXPORT=1` remains available for ancestry-based detection when no known harness environment marker is present.

That same rule applies to invoked shell helpers: if identity can be inferred or inherited, they may render participant-local state; if not, they should limit themselves to room-level observer status rather than pretending to be a participant.

### 4. Instruction — how the agent behaves

A skill (Claude Code `Skill` format, plus equivalent bootstrap for other harnesses) teaches the agent:

- On first message in an ambient-enabled repo, determine whether it has participant-mode identity or only observer-mode visibility.
- In participant mode, use the existing coordination path (`join_path`, `wait_for_turn`, `heartbeat`, `release_stick`, `pass_stick`) as the authority for membership and ownership. A shell-side helper may mirror this, but it should not be the source of truth.
- In observer mode, read `tt status` / `tt state` and optionally tail `tt events --follow`, but do not join or claim.
- Narrate wait state naturally to the human. Do not mutate the repo while waiting; use the time for planning, requirements, review.
- If `wait_for_turn` reports `takeover_available`, surface that explicitly: the agent can offer to take over, but takeover remains a deliberate act.

## Components

### `tt status --prompt`

Output format (one line, no trailing newline):

| Situation                                 | Output                            |
|-------------------------------------------|-----------------------------------|
| Not in an ambient-enabled workspace       | *(empty)*                         |
| In a room, holding the stick              | `🥢 holding T42`                  |
| In a room, queued                         | `🥢 waiting(2)`                   |
| In a room, idle (known participant)       | `🥢 idle`                         |
| In a room, observer-only                  | `🥢 codex holding`                |
| Lease going stale (you hold)              | `🥢 holding T42 ⚠`                |

`waiting(N)` needs a precise definition. Use:

- Start from the current effective head of the circular sequence:
  - if the room is `owned`, the current owner is the head,
  - if the room is `reserved`, the reserved recipient is the head.
- Walk forward through the circular member list.
- Count only **active** members who would receive first right of claim before the caller.
- Exclude inactive members.
- If the caller identity is unknown or the caller is not a member, do not render `waiting(N)`.

This keeps queue position stable and meaningful without pretending dormant members are still in line.

The emoji should be configurable (`TT_PROMPT_ICON`) for terminals that render it poorly. The prompt path should target sub-10 ms steady-state latency, ideally with cached room resolution and a single indexed SQLite read. Treat that as a performance goal, not as a protocol guarantee.

The prompt output stays deliberately short. A richer machine-readable `tt status --json` or `tt state --json` can carry more detail such as current owner, reservation state, queue position, and takeover eligibility.

Shell integration snippets ship under `integrations/shell/` with a `tt prompt install [bash|zsh|fish]` command that appends the right hook to the user's rc file, idempotently.

### `tt events --follow`

Line-oriented room event stream. Stdout is JSON lines, one event per line. Stderr is for diagnostics only.

```
tt events [path] --follow [--after <event_seq>] [--event <types>] [--json|--pretty]
```

Flags:

- `--follow` — continue polling for new room events instead of returning a bounded page.
- `--after` — resume after the last seen `event_seq`.
- `--event` — comma-separated filter over raw room event types.
- `--json` / `--pretty` — output format.

The stream should align with the core room event log, not invent a second taxonomy. For the MVP, the on-the-wire event types should be the existing `RoomEvent` types:

| Event      | Meaning                                           |
|------------|---------------------------------------------------|
| `claim`    | A member claimed the stick.                       |
| `release`  | The current holder released with a handoff.       |
| `pass`     | The current holder explicitly passed the stick.   |
| `takeover` | A takeover committed.                             |
| `close`    | Reserved for the optional later `close_room`.     |

Consumers can project these into higher-level phrases if they want:

- `claim` or `takeover` => "turn granted"
- `pass` => "explicit handoff offered"
- `release` => "normal sequence handoff"

But the event stream itself should stay audit-log-shaped so it matches the database and replays cleanly.

Implementation notes:

- Use the existing append-only `event_seq` for replay and resumption. Do not add a second cursor concept when `event_seq` already exists.
- The cheapest implementation is a 1-second poll on SQLite state. Latency is acceptable; coordination turns are measured in seconds to minutes, not milliseconds.
- A later optimization can use SQLite update hooks via a shared daemon, but that introduces a lifecycle we should not take on in v1.
- The process must handle `SIGTERM`/`SIGHUP` cleanly (flush stdout, exit 0). Harnesses kill tracked background tasks on session end.

### Skill

Ships as a Claude Code skill under `integrations/skills/talking-stick/`. Parallel bootstrap files for Codex and other harnesses live under `integrations/skills/` with harness-specific naming.

The skill body covers:

- When to invoke (description matches on ambient-enabled repo context).
- The bootstrap sequence for observer mode versus participant mode.
- How to narrate wait state without being annoying.
- The non-mutation rule while waiting.
- How to react to raw room events versus `wait_for_turn` outcomes.
- How to surface `takeover_available` as a social decision instead of silently taking over.

## Tradeoffs and open questions

- **One background process per room observer.** Idle cost is low (SQLite poll), but cleanup on session end must be reliable. Harnesses kill tracked background tasks on exit; we should verify this for each supported harness before relying on it.
- **Identity in spawned shells.** This is the real fork in the road. If a harness can cheaply export its protocol identity into child shells, participant-mode shell helpers are viable. If not, observer mode should ship first and participant mode moves to a later release.
- **Event granularity.** Coarse events (room-event log only) minimize context pollution; fine events (every lease poke, every presence blip) enable richer UX but flood. Start with raw room events plus caller-centric `tt wait`.
- **Skill activation reliability.** Skills load on description match or bootstrap, not on `cd`. The repo marker plus an `AGENTS.md` / `CLAUDE.md` line is the most reliable trigger we have without harness-specific hooks.
- **Cross-harness event format.** The event stream must be plain JSON lines — no dependency on any one harness's notification shape. Harnesses read lines; they map to their own notification system.
- **Current task in ambient status.** Showing the owner's current task would be high-signal, but it should come from the handoff that granted the current turn, not from guessed free text. That likely requires the core room projection to retain the granting handoff pointer or a current-task snapshot. Good follow-up; not a v1 requirement for the prompt fragment.
- **Non-interactive shells.** This is intentionally deferred, not dropped. `PS1` only covers interactive shells; harness command runners need a different hook. A future shell prelude or harness-specific command hook should render ambient state for invoked commands. If it can prove participant identity, it may render participant-local status; otherwise it should emit observer-only conversation status. Treat this as a follow-on stage, not as part of the first shippable surface.
- **Multiple rooms per repo.** Out of scope for v1; assume one active room per workspace path. The CLI surface should not preclude multi-room later.
- **Prompt icon portability.** Not every terminal renders `🥢` cleanly. Make it configurable; ship a plain ASCII fallback (`[TS]`).

## Staged rollout

Each stage is independently shippable and independently useful:

1. **`tt status --prompt` + shell integrations.** Humans get ambient awareness. No agent identity tricks needed.
2. **`tt events --follow` on top of the existing room-event log.** Enables replayable ambient notifications and observer tooling.
3. **Observer-mode skill for Claude Code.** Brings room awareness into the agent UX without requiring shell-side agent identity.
4. **Participant-mode shell helpers, if identity export is practical.** If a harness can expose its protocol identity to child shells, background shell helpers may join/wait as that participant.
5. **Non-interactive shell hooks for invoked agent commands.** Observer-only if identity export is unavailable; participant-aware if the harness can prove or inherit its protocol identity.
6. **Optional: `tt init` and richer status projections.** Marker creation, richer task display, and shell bootstrap installers can land once the basic layer proves useful.

## Out of scope for v1

- MCP resource subscriptions as an alternative to the shell event stream. The shell-based channel is sufficient and harness-portable; adding a second push channel is premature.
- Multi-room-per-workspace. See `talking-stick-plan.md` for the single-default-room stance.
- Treating shell observer processes as authoritative protocol participants unless they can prove or inherit the correct harness identity.

## Why this matters

The coordination primitive without the presence surface is an appointment-only service: you have to remember to ask. With the presence surface, it becomes an ambient fact of the workspace, the way `git status` in a `PS1` made branch awareness ambient. That shift is what makes multi-agent coordination feel less like a protocol and more like a room.
