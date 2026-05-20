# Changelog

All notable changes to `talking-stick` are recorded here. Per-version release
notes (with verification commands and the full motivation for each item) live
in [`docs/releases/`](docs/releases/).

The project follows a loose [Keep a Changelog](https://keepachangelog.com/) style.
Versioning is [SemVer](https://semver.org/). The historical alpha releases could
make protocol-level breaking changes across alpha bumps; any future breaking
changes will be called out under **Breaking changes**.

## Unreleased

## [0.4.7] — 2026-05-20

Full notes: [`docs/releases/0.4.7.md`](docs/releases/0.4.7.md).

### Added
- **`tt wait --events --after N`.** New flag turns `tt wait` into a unified background receive loop that long-polls for ownership changes *and* messages without a separate `tt events --follow` consumer. Holders can run the same command to receive directed and broadcast messages without renewing their lease; non-holders wake on ownership-relevant transitions (grant, reservation, takeover-available, room closure) or on self-targeted events. Result shape gains `events`, `cursor_event_seq`, and `wake_reason` (`turn` | `event` | `timeout` | `closed`). The cursor is required and explicit so a harness keeps the receive loop precise across restarts. `--target self|any|<agent_id>` (default `self`) selects which events the loop surfaces; release-to-room broadcasts are excluded by `self` but still wake the loop via the ownership-check half. `tt try --events --after N` composes the same shape for one-shot checks, and `--park --events` composes with the existing park-hint throttle so a parked receiver wakes once on a fresh pending handoff and then times out cleanly.

## [0.4.6] — 2026-05-12

Full notes: [`docs/releases/0.4.6.md`](docs/releases/0.4.6.md).

### Added
- **`room_members.last_park_hint_event_seq`.** New nullable INTEGER column (migration 7) tracking which pending-handoff event sequence a member has already been hinted about via park mode. Used to give the `auto_claim_disabled` hint at most once per (member, pending handoff) pair.

### Fixed
- **Park no longer spins on truly idle rooms.** `tt wait --park` short-returns with `reason: auto_claim_disabled` and a hint only the first time a member parks against a given pending handoff in an idle room. Subsequent parks by the same member against the same pending handoff long-poll quietly. Truly idle (no pending handoff) always long-polls. A fresh pending handoff (newer event sequence) hints again, and each member is hinted independently. Previously the short-return fired on every park call, which kept a naive re-park loop spinning even after the agent saw the hint.

## [0.4.5] — 2026-05-12

Full notes: [`docs/releases/0.4.5.md`](docs/releases/0.4.5.md).

### Added
- **Harness-instance member metadata.** New nullable columns on `room_members` (`harness_name`, `harness_session_id`, `harness_host_id`, `harness_pid`, `harness_process_started_at`) track the root harness process and the in-process session id independently of the row's current liveness fields. Identity resolution walks the process ancestry to populate them; `tt guard` carries them forward on spawn so guardian rejoins do not clobber them.
- **`session_superseded` event type.** Emitted when `tt join` detects that the room's owner or reserved recipient comes from the same harness process but a different in-process session (the `/clear` case). The superseded member row is deleted, owner/reservation/lease state is cleared as appropriate, and pending recipient handoffs are preserved for the next claimant. Legacy member rows with NULL harness-instance fields are skipped, so the migration is safe.

### Fixed
- **`/clear` no longer leaves a permanent stale stick holder.** When a harness like Codex or Claude Code resets its in-process session (e.g. `/clear`) while still holding or being reserved for the stick, the next `tt join` from the new in-process session evicts the prior agent and clears the lease so the new session can proceed. Previously the room stayed stuck until an operator forced a takeover.
- **Park mode no longer looks like active pending work.** `tt wait --park` now returns immediately when the room is idle and unreserved, with a JSON hint telling agents to use normal `tt wait --json` when a handoff or operator instruction leaves review/release work pending. The bundled instructions now reserve park mode for true passive standby.

## [0.4.4] — 2026-05-12

Full notes: [`docs/releases/0.4.4.md`](docs/releases/0.4.4.md).

### Added
- **Automatic release prep.** `npm version <new-version>` now runs `scripts/prepare-release.mjs`, moving `CHANGELOG.md`'s `Unreleased` entries into the new version section, creating `docs/releases/<version>.md`, and adding the GitHub release link before npm creates the version commit/tag.

### Changed
- **Ambient receiver guidance.** The shipped skill now says to run exactly one streaming ambient receiver per session, and warns that exit-notify background commands silently swallow `tt events --follow` output instead of surfacing mid-task events.

### Fixed
- **Idle-room retention.** Opportunistic cleanup still deletes long-idle rooms after the seven-day default retention, but it now preserves a room when any recorded member process is provably still alive. Once no member is recently active or live, the same cleanup path removes the room and its member, event, and note rows.

## [0.4.3] — 2026-05-11

Full notes: [`docs/releases/0.4.3.md`](docs/releases/0.4.3.md).

### Added
- **`tt wait --park`.** New flag opts out of idle-room auto-claim while keeping the agent coordinated for explicit passes, assignments, and takeover signals. Use it when waiting on operator input without intent to take the next idle turn. The service/command input field is `auto_claim` and defaults to true.

### Changed
- **Startup coordination guidance.** The bundled skill now tells freshly invoked agents to give peers a short window to join, using normal waits or read-only repo orientation before deciding they are alone.

## [0.4.2] — 2026-05-10

Full notes: [`docs/releases/0.4.2.md`](docs/releases/0.4.2.md).

### Fixed
- **Guardian ownership contract.** `tt wait` now repairs an already-owned turn when the local CLI session has no recorded guardian, and the bundled docs no longer ask agents to manually inspect guardian PIDs before editing.

## [0.4.1] — 2026-05-10

Full notes: [`docs/releases/0.4.1.md`](docs/releases/0.4.1.md).

### Fixed
- **Release/reclaim churn.** A prior owner who releases an idle handoff now waits through a bounded release cooldown when another active member exists, giving peers time to claim instead of immediately taking the stick back. Solo prior owners can still continue immediately, stale audit-only event reads do not refresh turn interest, and the bundled guidance now tells lone active members to stop polling after a clear handoff.

## [0.4.0] — 2026-05-10

Full notes: [`docs/releases/0.4.0.md`](docs/releases/0.4.0.md).

### Added
- **Editable collaboration instructions.** Added `tt instructions show|edit|reset` so bundled safety guidance can stay package-managed while user and project collaboration prompts live in editable Markdown. The bundled skill now loads the effective prompt after join.

## [0.2.0] — 2026-04-30

Full notes: [`docs/releases/0.2.0.md`](docs/releases/0.2.0.md).

### Added
- **Out-of-band messaging.** Two agents in the same room can now chat — design questions, "are you about to break X?", live coordination — without churning the stick. Substrate is a single new column on `room_events` (`payload_json`), two new MCP tools (`send_message`, `wait_for_events`), and three new CLI commands (`tt msg send`, `tt msg recv [--wait|--follow]`, `tt events --wait|--follow`). The skill grows a new §4.5 *Out-of-band messaging* section explaining when to message vs note vs handoff.
- **Observer-safe event long-poll.** `wait_for_events` is non-mutating: no `touchMember`, `touchKnownMember`, `touchWaitingMember`, or idle-room purge. Non-holders can long-poll the event log freely without disturbing turn-fairness bookkeeping.
- **`getLatestEventSeq`** service / commands helper backing the "start at now" cursor for `tt msg recv --wait|--follow`, so first-launch receivers don't replay history.
- **Splice-at-1 parser repair** for `tt msg send <recipient> --interrupt "<body>"`, preserving the single-command UX without changing the generic CLI parser.
- **Receive-consumer contract** documented in [`docs/receive-consumer-contract.md`](docs/receive-consumer-contract.md): lifecycle, cursor persistence, replay coalescing, backpressure, at-least-once + dedupe on `event_id`, SIGTERM behavior.

### Migration
- `room_events` gains a nullable `payload_json TEXT` column (migration #5). `ALTER TABLE ADD COLUMN` is O(1) on populated tables; existing rows back-fill to NULL; legacy event types continue to write NULL. No action required by operators on upgrade.

## [0.1.4] — 2026-04-30

Full notes: [`docs/releases/0.1.4.md`](docs/releases/0.1.4.md).

### Fixed
- **`force_new` no-op on exact-path joins now surfaces a warning.** `join_path` with `force_new=true` against an existing room at the same `canonical_path` has always been a no-op (path rooms are `UNIQUE` by canonical path). Prior versions returned the existing room silently; the response now includes a `warning` explaining the no-op and pointing at the remedy (join a distinct subpath). The default `tt join` text output now renders both this warning and the existing nested-room warning, not just `--json`. Skill `§4 While waiting` is also rewritten to frame wait time as active investigation + `add_note`, not idle sleep.
- **Contention test no longer races the room-purge clock.** The `only one process can claim an idle room under contention` test failed deterministically on wall-clock dates past the parent test's fake-clock window because the spawned claim worker constructed its service with real time and purged the idle room before claiming. The worker now inherits the parent fake-clock ISO timestamp.
- **Identity-resolver memoization test asserts deltas, not absolute call counts.** The 0.1.3 ancestry-walk change made `deriveMcpHarnessIdentity` walk multiple parent inspections per derive; the existing test still expected exactly one. Updated to assert call-count deltas so it remains correct regardless of ancestry-walk depth.

## [0.1.3] — 2026-04-28

Full notes: [`docs/releases/0.1.3.md`](docs/releases/0.1.3.md).

### Added
- **`tt kick` / `kick_member`.** New CLI command and MCP tool that evict a member from a room. Default behavior only succeeds when the target's process is detected gone past the silence-grace window; `--force` / `force: true` bypasses the check. The eviction is recorded as a `kick` room event so other members see the cleanup.

### Fixed
- **Stable codex agent ids across MCP and shelled-out CLI.** When a harness env signal is detected without an explicit session id (codex without `CODEX_THREAD_ID`), session-id resolution now walks process ancestry to anchor on the harness's root `pid+startTime` instead of the immediate parent. Previously every shell-out from a codex session entered the room as a fresh `codex:<hash>` member, producing duplicate ghost members.

## [0.1.2] — 2026-04-27

Full notes: [`docs/releases/0.1.2.md`](docs/releases/0.1.2.md).

### Changed
- **Combined harness setup.** `tt install` now installs both the MCP server registration and the bundled Talking Stick skill for each selected harness; `tt uninstall` removes both. The older `install-skill` / `uninstall-skill` commands remain available for targeted skill-only maintenance.

## [0.1.1] — 2026-04-27

Full notes: [`docs/releases/0.1.1.md`](docs/releases/0.1.1.md).

### Changed
- **Clearer README quickstart.** The setup flow now walks through install, harness registration, restart, and a concrete two-agent Claude/Codex room exercise.
- **Tighter scheduled-wakeup guidance.** The bundled skill now tells agents to prefer direct `wait_for_turn` wait cycles/background long-polls over scheduled wakeups, and caps active multi-agent wakeups at 120 seconds unless the operator explicitly pauses the room or the task is blocked outside the room.

## [0.1.0] — 2026-04-27

Full notes: [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md).

### Changed
- **First non-alpha release.** Promoted the current local coordination surface to `0.1.0`: MCP tools, `tt` CLI, SQLite persistence, installer flows, non-owner notes, fair release selection, liveness recovery, and bundled harness skill.
- **Long-poll skill guidance.** The bundled skill now recommends `110000` ms as the default client-safe `wait_for_turn` long-poll budget.

## [0.1.0-alpha.6] — 2026-04-27

Full notes: [`docs/releases/0.1.0-alpha.6.md`](docs/releases/0.1.0-alpha.6.md).

### Changed
- **Installer results are precise and idempotent.** `tt install` now preflights known MCP registrations and reports whether each harness was `added`, `already-present`, `updated`, `removed`, `already-absent`, `skipped`, or `failed` instead of forwarding each harness's inconsistent native wording.

### Fixed
- **Existing Claude Code MCP registrations are no longer failures.** Claude's native "already exists" response is treated as `already-present`, so `tt install --all` can be safely rerun.
- **Codex MCP install no longer looks like a duplicate add.** When Codex already has the `talking-stick` server, `tt install` reports `already-present` and does not invoke another `codex mcp add`.

## [0.1.0-alpha.5] — 2026-04-26

Full notes: [`docs/releases/0.1.0-alpha.5.md`](docs/releases/0.1.0-alpha.5.md).

### Added
- **Explicit room departure.** Added `leave_room` to the MCP server and `tt leave [path]` to the CLI. Leaving removes the caller's membership and clears local CLI session state.
- **MIT license.** The package metadata, lockfile, README, and repository `LICENSE` now declare MIT licensing.

### Changed
- **Rooms are ephemeral coordination state.** Rooms are physically deleted when no active members remain, and long-idle rooms are purged opportunistically on later service invocations.
- **Take-backsies are delayed.** When release leaves a handoff idle because no peer is currently waiting, the prior owner cannot immediately reclaim while another room member exists. The existing waiter grace window gives slower peers a chance to poll first.

### Fixed
- **Harness-launched `tt` identity.** CLI invocations now check known harness environment markers before falling back to `human:<user>`. A Claude Code shell with `CLAUDECODE=1`, for example, resolves to a `claude:*` harness identity without requiring `TT_HARNESS_EXPORT=1`.

## [0.1.0-alpha.4] — 2026-04-26

Full notes: [`docs/releases/0.1.0-alpha.4.md`](docs/releases/0.1.0-alpha.4.md).

### Changed
- **CLI internals split into focused modules.** `src/cli.ts` is now a thin entrypoint backed by `src/cli/` modules for parsing, command routing, output, identity/session handling, guardian lifecycle, install/self-update flows, notes, room reads, startup maintenance, and turn commands. This is intended to preserve CLI behavior while making follow-up CLI ergonomics work smaller and safer.

## [0.1.0-alpha.3] — 2026-04-26

Full notes: [`docs/releases/0.1.0-alpha.3.md`](docs/releases/0.1.0-alpha.3.md).

### Added
- **Operator-friendly CLI takeover.** Added `tt take` and made human CLI `tt takeover` reason-optional so an operator can step into a stuck reserved/owned room quickly. Harness-aware CLI takeovers still require `--reason` unless invoked with `--operator-requested`.
- **Explicit assignment command.** Added `tt assign <target|next>` for named handoffs; `tt pass [path]` now means "pass/end my turn" instead of treating the first positional as a target.
- **Automatic skill sync for human CLI.** Ordinary human `tt` invocations silently refresh already-installed Claude Code, Codex, and OpenCode skill copies/symlinks from the bundled skill so copied installs do not drift after a Talking Stick update. Missing harnesses and missing skill installs are skipped; Gemini remains explicitly managed by `tt install-skill gemini`.
- **`tt self-update`.** Detects how `tt` was installed (npm / pnpm / yarn / bun, including npm-via-Homebrew/mise/asdf/nvm) and runs the right global-update command. `--print` shows the inferred command without running it; `--manager` overrides detection. Refuses politely from a development checkout.

### Changed
- **Fair release selection.** Normal release now tracks `last_wait_at` and prefers recent waiters that are new or have gone longest without holding the stick. If the best-known member is between wait polls, a short grace window avoids immediately recycling the turn to a less-fair claimant.
- **Skill handoff guidance.** Default to `release_stick`; reserve `pass_stick` for cases where a specific named member must go next. This keeps the room open for active humans and other agents instead of turning agent-to-agent handoffs into a pinned duopoly.

## [0.1.0-alpha.2] — 2026-04-26

Full notes: [`docs/releases/0.1.0-alpha.2.md`](docs/releases/0.1.0-alpha.2.md).

### Added
- **Non-owner notes.** New `add_note` / `list_notes` MCP tools and `tt notes add` / `tt notes list` CLI subcommands. Members can leave durable async observations (≤ 16 KB plain text, optional `turn_id` scoping) for the current owner and successors without holding the stick. Additive `notes` table migration; no data back-fill.
- **`wait_for_turn` owner-idempotency.** Calling `wait_for_turn` while you already hold a non-expired lease returns `your_turn` (reason `already_owner`) with your existing `turn_id` / `lease_id` instead of falling through to `not_yet`.
- **Enriched `not_yet` payload.** Now carries `turn_id`, `current_owner`, `reserved_for`, `lease_expires_at`, and `claim_expires_at` so harnesses and the CLI no longer need a follow-up `get_room_state`.
- **Human-readable `tt` CLI text mode by default.** `tt wait` / `tt try` render handoff status, next action, artifacts, open questions, and do-not entries as indented sections; `tt notes list` is bulleted with relative time and scope; `tt state` shows owner / reserved / members with `last seen` time and a `← you` marker; `tt events` groups per turn with `from → to (reason)` arrows.
- **Auto-JSON in harness invocations.** `--json` is selected automatically when `TT_HARNESS_EXPORT=1`/`true` or `TT_HARNESS_AGENT_ID` is set (same gate as identity export). `--text` forces human mode even in a harness.
- **Stdin handoffs.** `tt release --stdin` and `tt pass --stdin` read a JSON `Handoff` from stdin (artifacts, open_questions, and do_not pass through). Mirrors the existing `tt notes add --stdin` convention.
- **Installer skip-on-absent.** `tt install --all` and `tt install-skill --all` skip harnesses that are not on the machine instead of failing or creating empty `~/.claude` / `~/.codex` / `~/.opencode` directories. New `SkipAction`, `MissingHarnessError`, and per-harness config-dir resolvers.

### Changed
- **Liveness verdict on startTime drift is now `unknown`, not `gone`.** A live pid whose stored `process_started_at` doesn't match (after trim normalization) is more likely the original process with a format bug than a distinct re-used pid; `gone` is reserved for ESRCH.
- **Owner-gone is grace-gated.** `inspectRoom` / `inspectRoomForMutation` now require `liveness === "gone" && silenceMs > 2 * heartbeatIntervalMs` before flipping to `owner_gone`. A momentary `gone` reading no longer voids an active lease.
- **`recipient_gone` is diagnostic only.** Actual takeover is gated on `claim_expires_at`; the label remains for operator visibility but does not by itself open takeover before the claim window expires.
- **Read RPCs refresh joined-member presence.** `get_room_state`, `get_room_events`, and `list_notes` accept an optional `agent_id` and call `touchKnownMember` so a legitimately-busy reader cannot trip the silence grace. Non-member reads remain a harmless no-op.
- **Windows installer routes `.cmd`/`.bat` through `cmd.exe /d /s /c`.** PATH lookup is unified between detection and execution, spawn errors become structured `InstallResult` failures, and args containing cmd metacharacters (`& | < > ^ % "`) are rejected before launch.
- **`tt wait` short-circuits on `already_owner`** instead of spawning a second guardian; the recorded guardian is verified via a trim-tolerant liveness check and replaced if it is gone.
- **CLI session preservation on join refresh.** `upsertJoinedCliSession` merges join-time fields onto existing lease/guardian state instead of clobbering it.
- **Skill guidance.** Four additions: prefer harness wakeups over synchronous long-polls (with cache-window pacing), keep handoffs tight (~150–300 words; reference SHAs; use `artifacts[]`), `pass_stick` requires an active member (use `release_stick` if the target session is gone), and holding the stick is for active work only — release the moment you stop editing or thinking through edits.

### Removed
- **`wait_for_turn` `cursor` parameter and `not_yet` field.** Never consumed by service logic; resumable event replay belongs to `get_room_events`. MCP smoke regression locks the schema cursor-free.

### Fixed
- **`shouldUseJson` export gate.** Previously treated any non-empty `TT_HARNESS_EXPORT` as truthy, so `=0` / `=false` flipped output to JSON while identity correctly stayed on the human path. Now mirrors `isHarnessCliExportEnabled`: only `1` or `true` (case-insensitive) enable export.

### Verification
- `npm run typecheck`
- `npm test` — 165 tests across 13 files
- `npm run build`

## [0.1.0-alpha] — 2026-04-23

Full notes: [`docs/releases/0.1.0-alpha.md`](docs/releases/0.1.0-alpha.md).

Initial alpha. Core room protocol, SQLite-backed persistence, multi-process
contention coverage, MCP smoke coverage, human guardian flow, harness
installers, and the portable `talking-stick` skill.

[0.4.7]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.7
[0.4.6]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.6
[0.4.5]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.5
[0.4.4]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.4
[0.4.1]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.1
[0.4.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.0
[0.1.3]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.3
[0.1.2]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.2
[0.1.1]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.1
[0.1.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0
[0.1.0-alpha.6]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.6
[0.1.0-alpha.5]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha
