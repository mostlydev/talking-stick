# Coordination clarity + safety: #45, #46, #47, #48, #53

> **Status:** CONVERGED (claude:ea744c80 + codex:155f83db, 2026-06-15). Debate
> resolved O1–O5 below; ready for Codex implementation.
> Claude drafts → both debate → Codex implements → both review/test → release.
>
> **Scope:** five linked issues. #48 is an isolated safety bug. #45 and #47 are
> mostly skill/README/help contracts (with a small CLI addition each). #46 adds a
> read-only health surface; #53 is the noise-reduction half of #46 and is folded
> in here so the health view ships readable. Targeting one release at the end.

## Scope decisions (proposed)

- **#53 is in-scope for this release**, implemented together with #46 because the
  health view is the first surface that would drown in ghost rows. The recency
  horizon also applies to `tt state` (and optionally `tt events` / `tt notes
  list`) — see the per-issue scope notes below.
- Build order: **#48 first** (isolated, safety, fast), then **#45** (docs + join
  cursor), then **#46 + #53** (new command + horizon), then **#47** (docs +
  terminal marker). Tests land with each. Two-harness dogfood for #45 and #47
  before their docs are considered final. One release cut at the very end.

---

## Issue #48 — `--help` / `-h` must never mutate room state

### Root cause

`runCli` (`src/cli.ts`) only short-circuits help for the **top-level** case
(`!parsed.name || name === "help" || name === "--help"`). For a command like
`tt wait --help`, `parseCommand` yields `name: "wait"` with `options` containing
`help: true` (because `help` is in `BOOLEAN_FLAGS`). The dispatcher then runs
`runStartupMaintenance` and invokes `handleWaitCommand`, which joins the room,
claims the turn, writes a lease, and spawns a guardian — exactly the bug in #48.
`-h` is worse: the parser treats any non-`--` token as a positional, so `tt wait
-h` makes `-h` a *positional* (a bogus context path) and still runs the handler.

### Fix

**Converged approach (O1):** do **not** scan raw argv for a literal `help` token
(that would make `tt msg send room help` print help instead of sending the word
"help"). Instead, harden `parseCommand` and short-circuit on parsed structure:

1. `parseCommand` consumes **leading global options** before the command name so
   `tt --json wait --help` / `tt --agent x wait` resolve `name` to the real
   command (using `BOOLEAN_FLAGS` to know whether a leading `--opt` takes a value).
2. `parseCommand` normalizes `-h` → the `help` option.
3. In `runCli`, **before** `runStartupMaintenance` and before any runtime
   creation, short-circuit when `parsed.name === "help"` **or**
   `hasOption(parsed, "help")`:

```ts
if (parsed.name === "help" || hasOption(parsed, "help")) {
  // tt help <cmd> → positionals[0]; tt <cmd> --help/-h → parsed.name
  printCommandHelp(parsed.name === "help" ? parsed.positionals[0] : parsed.name);
  return; // exit 0, fully introspective
}
```

This is position-independent, never misreads a message body, and is fully
introspective (no room resolution, no skill-sync/MCP-migration writes, no
guardian, no events, no member/lease/handoff/`last_wait_at` writes). Covers
`tt wait --help`, `tt wait -h`, `tt --json wait --help`, `tt wait . --help`, and
`tt help wait`.

- `printCommandHelp(name)`: when `name` resolves via `getCommand`, print that
  entry's `usage` + `description` (+ the shared "Common options" block). The
  registry already carries `usage`/`description`, so no new per-command help
  strings are required. Unknown/missing `name` → existing `printHelp()`.
- Help wins over JSON: when `--json` is present, still emit help and exit 0.
  Recommendation: keep help **text** for now (issue treats JSON help as
  "if supported later"). Optional: emit a small read-only `{command, usage,
  description}` JSON object under `--json`. **Open question O1.**
- `internal` commands (`guard`, `grok-session-hook`, `migrate-mcp`) keep working;
  help for them can print a one-line usage or be treated as general help.

`detectHelpRequest` runs on raw `argv` so it does not depend on parser changes.
We may *also* add `-h` normalization to the parser for cleanliness, but the
short-circuit must not rely on it.

### Tests (`tests/cli.test.ts`, `tests/parser.test.ts`)

- Parser/dispatch: help detected for `--help` and `-h` at any position, and with
  a leading global flag (`tt --json wait --help`).
- **Side-effect-free regression:** seed a room with an owner **and** a pending
  handoff (use the existing temp-`TALKING_STICK_DATA_DIR` harness). Snapshot:
  event count/max seq, room row (owner/reserved/turn/lease/state/pending
  handoff), member rows incl. `last_wait_at`, `cli-sessions.json`, and live
  guardian pids. Run `tt wait --help`, `tt wait -h`, `tt --json wait --help`,
  `tt wait . --help`; assert **all snapshots unchanged** and exit 0 with help on
  stdout. Repeat for `try`, `take`/`takeover`, `release`, `pass`, `assign`,
  `join`, `leave`, `kick`, `notes add`, `msg send`.

### Docs

README + help text: state that help flags are always read-only and take
precedence over command execution.

---

## Issue #45 — one canonical listen/wait workflow

### Foundation already exists

`docs/plans/2026-05-20-wait-events-ambient-loop.md` converged and the mechanic is
**already implemented**: `tt wait --events --after <cursor> --json` long-polls and
returns `{ ...waitResult, events, cursor_event_seq, wake_reason }` with
`wake_reason ∈ {turn,event,timeout,closed}` (see `service.waitForTurnWithEvents`).
Crucially, the CLI only spawns a guardian on `status: "your_turn"`, so **events
never grant write authority** — already enforced in code. #45 is mostly the
*promotion* that the prior plan deferred "until dogfooded": make this the single
documented loop and demote the split.

### The canonical loop (what SKILL.md will teach)

One loop after `tt join`:

```sh
tt wait --events --after <cursor> --json
```

On each return, branch on `wake_reason` / `status`:

- `your_turn` (+ live `guardian_pid`) → **write authority**: do shared work.
- `wake_reason: "event"` / `not_yet` → observer data only. Process `events[]`
  (messages, passes, reservations), advance `cursor = cursor_event_seq`, loop.
- `wake_reason: "timeout"` → loop again with the same cursor.
- `takeover_available` → surface explicitly (existing §6 rules).
- `status: "closed"` → stop (terminal; ties into #47).
- Park: `tt wait --park --events --after <cursor>` for passive standby.

The permission boundary is restated in **every** example: *events are observer
data; only a `your_turn` grant with a live guardian permits shared mutation.*

### Initial-cursor gap (small CLI addition)

`JoinPathResult` has **no** event cursor today, so a harness cannot start the
loop without either replaying from `--after 0` or a separate `tt events` read.
Close this: add `cursor_event_seq` (the room's current max visible event seq) to
`tt join` output (and to `tt state`). Then the documented bootstrap is:

- initial cursor = `join.cursor_event_seq` (no replay), or
- `--after 0` for a deliberate full replay.

Restart/recovery: re-derive the cursor from a fresh `tt join` / `tt state` and
resume; document this in the workflow.

### SKILL.md restructure

- **§2** "Join once" — drop the "start a `tt events --follow` ambient receiver"
  instruction. Replace with "start one background `tt wait --events --after
  <cursor>` loop."
- **§3/§4** — fold the separate `tt wait` ownership wait and the ambient receiver
  into the single canonical loop; keep the active-vs-idle and "don't idle-hold"
  rules.
- **§4.5** — `tt events --follow` / `tt msg recv` demoted to **audit / debug /
  legacy fallback** and to harnesses that genuinely cannot background the wait
  loop. Keep `tt msg send` as the OOB send path.
- Per-harness note: the loop is request/response (returns on wake), so it suits
  both streaming harnesses (Claude Code background + notify) and non-streaming
  ones (Codex: background call returns, process, relaunch).

### Docs + verification

- README and `tt --help`/command help examples use the canonical loop, not
  `tt wait` + a separate receiver.
- **Dogfood with two harnesses in one room** (Claude + Codex) before the SKILL
  edit is final: confirm a non-owner wakes on a message, a holder wakes on a
  message without losing the lease, and ownership passes cleanly — all through
  the single loop.

---

## Issue #46 — read-only room health view  (+ #53 horizon)

### Surface (recommend `tt health [path]`)

New top-level command `tt health [path] [--all] [--json]` (**resolved O2**:
dedicated command, with `tt status` as an **alias** to `health` since operators
reach for "status"; `tt state` stays the compact projection and is **not**
overloaded with `--health`).

### Hard constraint: genuinely read-only

`getRoomState` and `resolveSessionForReads` **mutate** (presence refresh /
session upsert). The health command must NOT use them as-is. Add **non-mutating
read variants** (e.g. `getRoomHealth` / a read-only projection that does not
touch `last_seen_at`, does not upsert `cli-sessions.json`, does not warm/refresh
liveness in a way that writes). It must not claim, release, refresh wait
interest, spawn/stop guardians, kick, or mutate handoffs.

### What it combines (clearly separated sections)

1. **Room truth:** owner, reserved_for, turn_id, lease/claim expiry, pending
   handoff (with source/target and whether room-targeted), takeover availability
   + reason.
2. **Member truth:** active / stale / inactive using the existing liveness
   model (read-only).
3. **Local truth (this harness/session):** resolved identity; the
   `cli-sessions.json` row; guardian pid + liveness via `checkGuardianLiveness`,
   and **whether that guardian protects the currently-owned turn**; detected
   receiver processes (`tt events --follow`, `tt msg recv --follow|--wait`) for
   this room via a read-only `ps`/process scan; flags **duplicate** receivers and
   **stale** receiver pids when safely identifiable.
4. **Workspace advisory:** `git status` summary (tracked/untracked) when inside a
   git repo, **clearly labeled advisory**, not ownership proof.

Output in both text (human-first) and JSON (harness-first). Any cleanup is a
**separate explicit command** with exact process/room/session targeting — **not**
part of `tt health` (out of scope for this issue; `tt kick` already exists for
ghost members).

### Tests

Healthy single loop; duplicate receivers; stale receiver pid; missing guardian
for a local owned session; stale local session row; pending room-targeted
handoff. Plus an assertion that `tt health` causes **no** writes (same snapshot
technique as #48).

---

## Issue #53 — automatic recency horizon for ghost traffic

### Behavior

Default read views anchor to the room's **most-recent real activity** (max of:
owner/turn change, latest event, latest note, active member `last_seen`) and hide
much-older ghost rows behind a summary:

- Show members/events/notes within a horizon relative to the anchor (proposal:
  members seen on/after the anchor's day; events/notes from roughly the last ~20
  events or since the anchor day). Collapse the rest into
  `+N older … hidden — use --all`.
- **Always shown regardless of age:** current owner, reserved member, and the
  calling agent.
- `--all` (and explicit `--after`/`--since`/`--limit`) restore full history.
- Horizon is **presentation only** — it must not change ownership, liveness
  classification, takeover math, or what `--target any` audit reads can retrieve.
- JSON exposes both shown rows and a structured `older_count` / `hidden` summary.

### Scope for this release

**Resolved O3:** apply the default horizon to **all four** surfaces named in the
issue — `tt state`, non-streaming `tt events`, `tt notes list`, and `tt health` —
since deferring events/notes would fail #53's acceptance criteria. Keep it
pragmatic: only the **default display/listing** paths change; `--all`, explicit
`--after`, explicit `--limit`, and `--wait`/`--follow` streaming preserve full
audit/stream behavior.

### Tests

Fresh-activity room hides old ghosts; all-old room still shows its most-recent
day (not empty); `--all` shows everything; owner/reserved/self never hidden.

---

## Issue #47 — terminal closeout semantics

### SKILL.md §8 → three explicit post-turn branches

- **Active work pending** → continue the canonical loop (§45).
- **Passive / external wait** → `tt wait --park --events …` (no idle auto-claim).
- **Shared task complete** → stop the loop cleanly and send the final
  user-facing closeout.

**Completion evidence (all required):** last handoff/review verdict is final; no
`next_action` asks another agent to act; no assignment/reservation pending; open
questions empty/closed; required tests/runtime/release checks recorded; no
CI/publish/runtime/human gate outstanding; the user objective is satisfied (not
merely narrowed). **Conservative rule:** if evidence is ambiguous, run one more
normal cycle or park rather than declare done. Examples must show (a) a final
two-agent handoff ending without either harness reclaiming, and (b) an ambiguous
case where the harness keeps listening/parks.

### Protocol marker — DEFERRED (resolved O4: docs-only this release)

We will **not** add a room-closing terminal marker in this release. Verified:
`path_rooms` has `UNIQUE (canonical_path)` and `joinPath` returns the existing
same-path room even when `state = "closed"`, so a hard `release --complete` that
closes the room would strand the repo's canonical room with no archive/reopen
path. #47 explicitly makes protocol support optional, so this release ships the
**documentation contract only**: the three-branch post-turn guidance, the
completion-evidence checklist, worked examples, and the two-harness dogfood. The
"complete" branch is proven behaviorally — a final two-agent handoff where both
agents stop instead of reclaiming.

A terminal marker (`tt release --complete` / `tt close`) is deferred to a
**follow-up issue** that must first design room archive/reopen under the
`UNIQUE(canonical_path)` model.

### Tests + dogfood

Unit: `release --complete` closes the room / emits the terminal marker; ordinary
release does not. Dogfood: two harnesses complete a shared task and both stop
without an operator prompt deciding the room is done.

---

## Resolved decisions (debate outcome)

- **O1 (#48):** text-only help now (structured JSON help deferred). Help detection
  via hardened `parseCommand` + `name === "help" || hasOption("help")`
  short-circuit — **no** raw-argv literal-`help` scanning (must not break
  `tt msg send room help`).
- **O2 (#46):** dedicated `tt health`, with `tt status` as an alias; `tt state`
  stays the compact projection (not overloaded).
- **O3 (#53):** horizon applies to all four default views — `state`,
  non-streaming `events`, `notes list`, `health` — with `--all`/explicit
  `--after`/`--limit`/`--follow` preserving full history/stream.
- **O4 (#47):** docs-only this release; room-closing terminal marker deferred to
  a follow-up issue pending archive/reopen design.
- **O5 (sequencing):** one new branch from current HEAD, per-issue commits, a
  single release cut at the very end after both review/test.

## Test / verification gates (whole effort)

`npm run typecheck` clean · `npm test` green · `npm run build` · two-harness
dogfood for #45 and #47 · then the release flow (version bump → build → publish →
gh release) as the final step.
