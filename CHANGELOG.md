# Changelog

All notable changes to `talking-stick` are recorded here. Per-version release
notes (with verification commands and the full motivation for each item) live
in [`docs/releases/`](docs/releases/).

The project follows a loose [Keep a Changelog](https://keepachangelog.com/) style
while it remains in alpha. Versioning is [SemVer](https://semver.org/) with the
caveat that protocol-level breaking changes are still possible across alpha bumps;
they will be called out under **Breaking changes**.

## [Unreleased]

### Added
- **Operator-friendly CLI takeover.** Added `tt take` and made human CLI `tt takeover` reason-optional so an operator can step into a stuck reserved/owned room quickly. Harness-aware CLI takeovers still require `--reason` unless invoked with `--operator-requested`.
- **Explicit assignment command.** Added `tt assign <target|next>` for named handoffs; `tt pass [path]` now means "pass/end my turn" instead of treating the first positional as a target.

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

[0.1.0-alpha.2]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha.2
[Unreleased]: https://github.com/mostlydev/talking-stick/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.0-alpha
