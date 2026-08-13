# Changelog

All notable changes to `talking-stick` are recorded here. Per-version release
notes (with verification commands and the full motivation for each item) live
in [`docs/releases/`](docs/releases/).

The project follows a loose [Keep a Changelog](https://keepachangelog.com/) style.
Versioning is [SemVer](https://semver.org/). The historical alpha releases could
make protocol-level breaking changes across alpha bumps; any future breaking
changes will be called out under **Breaking changes**.

## Unreleased

## [0.12.1] — 2026-08-13

Full notes: [`docs/releases/0.12.1.md`](docs/releases/0.12.1.md).

### Fixed

- **Concurrent same-process sessions no longer evict each other.** Session supersession now fires only when a verified `harness:` identity replaces a provisional (`pid:`/`term:`/`userhost:`) identity from the same harness process. Subagent threads sharing one process coexist instead of deleting the owner's membership and voiding its lease mid-turn (the my-cli `unknown_member` failure).
- **Membership changes wake waiting members.** Genuinely new joins and leaves emit broadcast `join`/`leave` events that reach every other member's `tt wait`; implicit-join presence touches stay silent. `tt wait` now uses the documented `self` event filter, which also keeps handoff-pickup claims visible to the releaser.
- **No ghost grants.** A member removed mid-wait gets a caller-named `unknown_member` error with re-join guidance instead of being granted a turn; pre-join sends name the caller and no longer fabricate a CLI session row.

## [0.12.0] — 2026-08-13

Full notes: [`docs/releases/0.12.0.md`](docs/releases/0.12.0.md).

### Added

- **Default-on Claude Code Stop guard.** `tt install claude-code` merges a managed `Stop` hook into `~/.claude/settings.json` (`--no-guard` opts out; uninstall removes only the managed entry, including on the native fallback path). The internal `tt claude-stop-hook` command binds to the exact harness session, uses a genuinely read-only grant lookup, and blocks a stop with exit 2 only while that session holds an unexpired lease or an unclaimed reservation. It honors `stop_hook_active`, propagates only exit 2, and fails open on every error path.

## [0.11.0] — 2026-08-13

Full notes: [`docs/releases/0.11.0.md`](docs/releases/0.11.0.md).

### Added

- **Durable receiver registry.** A foreground `tt wait` registers its exact PID, start time, cursor, generation, and heartbeat in `room_receivers`. A concurrent second wait for the same room member fails fast with `duplicate_listener`, crash recovery replaces provably dead registrations, and `tt health` reads the registry instead of scanning process command lines.
- **Reachability-gated routing.** Fair release selects only members with a live registered receiver or a verified self-waking endpoint. Named `pass`/`assign` to an unreachable target fails with `recipient_unreachable` (with recovery suggestions) unless `--operator-requested` explicitly overrides.
- **Reservation expiry requeue.** An expired unclaimed reservation emits one `reservation_expired` event, preserves the pending handoff, and reroutes to the next reachable waiter (or idles) instead of broadcasting `takeover_available` to every wait. Owner-gone, owner-idle, and owner-timeout keep the explicit takeover decision.
- **Meaningful `--interrupt`.** `tt wait` records the caller's verified cmux surface as a session-scoped wake endpoint. A directed interrupt reaches a live listener through its wait output, and otherwise sends one coalesced, fixed, body-free wake prompt to the verified endpoint; a room interrupt may wake only the current owner. Send results expose `delivery_status` (`receiver`, `endpoint`, `pending`, or `unreachable`) with no acknowledgement handshake.
- **`claude` install alias.** `tt install claude` resolves to `claude-code`.

### Changed

- **Compact default JSON.** Coordination commands omit the static `coordination_prompt`, prose `next` hint, and event fields duplicated by the envelope. `--verbose` restores the full diagnostic representation. Substantive messages and handoffs are never truncated.
- **Grok hook throttling.** The installed Grok hook records only identity lifecycle events (`SessionStart`, `UserPromptSubmit`, `SessionEnd`); repeated observations of the same session are idempotent no-ops, keeping `grok-sessions.jsonl` bounded.
- **Strict positional paths.** `tt release`, `tt pass`, and `tt assign` reject an unsupported `--path` flag instead of silently resolving the current directory into the wrong room.
- Documentation: build/clean/generated-output commands are shared workspace mutations and require the stick; `SKILL.md` documents `--interrupt` etiquette and delivery statuses.

## [0.10.0] — 2026-07-21

Full notes: [`docs/releases/0.10.0.md`](docs/releases/0.10.0.md).

### Added

- **Event-driven standby.** `tt standby --wake cmux` records parked intent and a verified caller surface, returns immediately, and delivers one coalesced wake for directed actionable work. Manual standby is explicit about requiring operator resumption; wake failures remain visible and retry on later mutations or `tt health`.
- **Persisted wait intent and routing diagnostics.** Room members now expose active/parked intent plus standby generation, pending, delivery, and error state. Ordinary release selects fresh active intent (without requiring ten-second write churn), probes only the selected candidate for liveness, and reports `no_active_waiters` / `parked_hinted`; direct pass/assign may target parked members and reports `routed_to_parked`.

### Fixed

- **Silent waits no longer churn agent turns.** Without an explicit `--timeout`, `tt wait` and `tt wait --park` silently renew the bounded service long-poll in the same OS process instead of exiting every 110 seconds. The 250 ms observation loop is read-only; presence and intent writes are bounded to wait entry/heartbeat cadence.
- **Passive park no longer masquerades as active work.** Park clears active wait recency, cannot be entered by a live owner before release, and does not receive ordinary fair releases. The shipped skill now directs truly passive cmux sessions to standby instead of repeatedly polling a parked subprocess.

## [0.9.0] — 2026-07-12

Full notes: [`docs/releases/0.9.0.md`](docs/releases/0.9.0.md).

### Added

- **CLI-managed wait cursor.** Plain `tt wait --json` now receives room events by default and persists `event_cursor_seq` in `cli-sessions.json`. Normal agent loops no longer manage `--events` or `--after`, eliminating stale-cursor replay loops that made nominal long-polls return immediately.
- **Safe instruction updates.** Generated editable defaults and recorded unedited skill copies update automatically. Customized files are preserved and offered explicit `tt instructions update --replace` or `tt install --replace` commands.

### Changed

- **Coordination guidance rewritten from session evidence.** The bundled default and shipped skill now explain the actual subprocess lifecycle: a yielded tool handle is still one running wait, poll that handle, do not add short CLI timeouts, and start a successor only after the subprocess exits. The skill is substantially shorter and no longer repeats harness stereotypes, phase taxonomies, or legacy receive alternatives.
- **Editable files are local overrides.** New editable instruction files contain only a small override template instead of copying the bundled default into a second effective layer.

### Removed

- **Legacy integration cleanup and identity code.** Removed the old postinstall/startup/update cleanup lifecycle, internal migration command, installer adapters, obsolete identity API/session naming, tests, and stale design documents. Install and uninstall now manage skills and the Grok session hook only.

## [0.8.0] — 2026-06-18

Full notes: [`docs/releases/0.8.0.md`](docs/releases/0.8.0.md).

Coordination guidance hardening driven by mining real Claude and Codex session logs (134 sessions across both harness stores). Both corpora independently ranked the same root problem — agents distrusting the single long-poll — and surfaced the same meta-insight: the rules mostly already existed but were buried in prose.

### Added
- **Coordination Quick Reference in the skill.** A short, mechanical checklist at the top of the `talking-stick` skill front-loads the highest-leverage rules: one `tt wait --events --after <cursor>` loop as the only poll *and* the only listener, never bare `tt wait`, advance the returned `cursor_event_seq` and re-arm exactly one loop, bound `tt events`, no shared mutation without a fresh `your_turn` and a live `guardian_pid`, and test before the final handoff.
- **Coordination is mandatory and testing-before-final-handoff are now explicit** in both the bundled skill and the editable collaboration instructions, plus a "lead a multi-agent kickoff with one room broadcast of the goal and a proposed split" optimization.
- **`LICENSE.md` (MIT) added** and both `LICENSE.md` and `CHANGELOG.md` now ship in the published package `files`.

### Changed
- **Corrected owner-side receive-path guidance.** An owner's `tt wait --events` is a genuine long-poll: `isTurnWake` suppresses `already_owner` as a turn wake, so the loop blocks until an event arrives or the wait times out, then returns `your_turn` with `reason: "already_owner"`. The same single loop serves owner and waiter alike while the separate guardian renews the lease. This replaces prior owner-side `tt events --follow` listener advice — a recurring leaked-duplicate-listener footgun seen in the logs; the only documented fallback for harnesses that cannot run `tt wait` is now a single one-shot `tt events --wait`.
- **Never bare `tt wait`.** The skill, instructions, and README now require the standby loop to always be `tt wait --events --after <cursor>`; bare `tt wait` wakes only on a turn change and silently misses messages and events.
- **Bound `tt events`.** Guidance to always pass `--after` (and `--limit`); a bare `tt events --target any` can dump the entire log (tens of thousands of tokens).

## [0.7.0] — 2026-06-16

Full notes: [`docs/releases/0.7.0.md`](docs/releases/0.7.0.md).

### Added
- **Concise `tt health` / `tt status` action card.** Default health output is now a short, action-oriented summary — owner, whether you own it, lease + renewal status, guardian, listener (with duplicate count), git, and the next recommended command. Full member/receiver/process diagnostics moved behind `--verbose` (the existing `--all` still works). JSON exposes `hidden.{members_omitted,receivers_omitted}` so consumers know detail is available. (#55)
- **Listener restart reminder on every `tt wait` / `tt try`.** Each return now carries a dedicated `next` reminder (JSON field and human line) to restart exactly one listener, and warns when duplicate active listeners are detected for your own harness. (#56)

### Changed
- **Stable leases across harness process rotation.** The lease guardian no longer surrenders a live owner's turn the instant its captured harness pid leaves the process table. It now confirms persistent absence through the same `isGonePersistent` grace the service layer already enforces — process gone *and* no `tt` activity past the gone-grace window — before relinquishing as `harness_gone`. Harnesses whose OS process identity rotates per turn keep their lease as long as they keep issuing `tt` commands. (#55)
- **Presence refresh on ordinary commands.** Reads such as `tt health`/`tt state` and owner mutations (`release`/`pass`/`takeover`) refresh the calling harness member's `last_seen` and process metadata. This is presence only — reads never renew owner authority or extend the lease. (#55)
- **Duplicate-listener detection is harness-scoped.** Receiver scanning is now scoped to the caller's own process tree and ancestor-deduped (a wrapper shell plus its child `node … wait` count once), so an unrelated room or peer's listeners no longer trigger false duplicate warnings. (#56)

### Fixed
- **`harness_gone` false positive.** A live harness that kept running `tt` commands could be marked gone and have its lease taken over mid-task. The guardian/service parity above closes that path. (#55)

## [0.6.0] — 2026-06-15

Full notes: [`docs/releases/0.6.0.md`](docs/releases/0.6.0.md).

### Added
- **Skiller-backed skill installation.** Talking Stick now bootstraps the `skiller` binary during package postinstall, verifying release checksums before installing to `~/.local/bin`, and uses skiller for skill directory install, uninstall, sync, and duplicate cleanup whenever a compatible binary is available. The existing TypeScript installer remains as fallback, while MCP cleanup and the Grok session hook stay Talking Stick-owned.

## [0.5.1] — 2026-06-15

Full notes: [`docs/releases/0.5.1.md`](docs/releases/0.5.1.md).

### Changed
- **README modernized for the CLI-only workflow.** Documentation only — no code changes. The quickstart now shows a single shared `/goal … /talking-stick $talking-stick` prompt for both panes instead of two long per-harness scripts; stale MCP-era RPC names (`add_note`, `list_notes`, `release_stick`, `pass_stick`, `wait_for_events`, `get_room_events`, `leave_room`, `wait_for_turn`) are replaced with their `tt` CLI equivalents; the version pin was removed from the intro (it belongs in this changelog and on npm); and the post-turn closeout section now points to the bundled skill instead of duplicating it.

## [0.5.0] — 2026-06-15

Full notes: [`docs/releases/0.5.0.md`](docs/releases/0.5.0.md).

### Added
- **`tt health` / `tt status` room health view.** A read-only diagnostic that combines room truth (owner, reservation, turn, lease/claim expiry, pending handoff, takeover availability), member liveness, local process truth (the current `cli-session`, guardian liveness and whether it protects the current turn, and duplicate/stale receiver detection), and an advisory `git status`. Available as text and JSON. It never claims, releases, refreshes wait state, spawns guardians, kicks members, or mutates handoffs.
- **`cursor_event_seq` on `tt join` and `tt state`.** Harnesses can seed the canonical wait loop from a returned event cursor instead of replaying history from `--after 0`.
- **Automatic recency horizon for default reads.** `tt state`, non-streaming `tt events`, `tt notes list`, and `tt health` anchor to the room's most recent activity and collapse older ghost rows behind a summary; `--all` and explicit `--after`/`--limit`/streaming restore full history. The owner, reserved member, and calling agent are never hidden, and JSON exposes the hidden counts.

### Changed
- **One canonical listen/wait loop.** The bundled skill, README, and command help now teach `tt wait --events --after <cursor> --json` as the single harness loop for both ownership changes and room events; `tt events --follow` and `tt msg recv` are documented as audit/debug or legacy fallbacks. Events remain observer-only — shared mutation still requires a `your_turn` grant with a live guardian.
- **Explicit terminal closeout guidance.** Skill §8 now defines three post-turn branches (active work pending, passive/external wait, shared task complete) with a completion-evidence checklist and worked examples, so a finished shared task closes out cleanly without an operator prompt. A protocol-level terminal marker is deferred to a follow-up issue pending room archive/reopen design.

### Fixed
- **Command help is side-effect-free.** `tt <command> --help`/`-h` (including `tt --json wait --help`, `tt wait . --help`, and `tt help <command>`) now print help and exit without resolving or claiming a room, spawning a guardian, or writing any events, leases, handoffs, member rows, or wait state. Help short-circuits before startup maintenance and runtime, and the parser recognizes leading global options and normalizes `-h`.

## [0.4.13] — 2026-06-14

Full notes: [`docs/releases/0.4.13.md`](docs/releases/0.4.13.md).

### Added
- **Antigravity CLI harness support.** `tt` now detects Antigravity from `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, or `agy` ancestry, using the conversation id as the preferred stable session anchor. `tt install antigravity` installs the bundled skill through the shared `~/.agents/skills/talking-stick` location.

### Changed
- **Shared `.agents` skills are now primary for shared-reading harnesses.** Codex, Antigravity, Grok Build, and OpenCode install the Talking Stick skill once at `~/.agents/skills/talking-stick`; Claude Code remains at `~/.claude/skills/talking-stick`. Grok still gets its global session hook. Install planning deduplicates same-path skill actions before running them.
- **Gemini CLI skill installation is deprecated.** Gemini identity detection and `## Gemini` instruction aliases remain for existing sessions, but `tt install gemini` is cleanup-only and points users to `tt install antigravity`.
- **Shared skill uninstall is explicit.** `tt uninstall codex`, `tt uninstall grok`, `tt uninstall opencode`, and `tt uninstall antigravity` leave `~/.agents/skills/talking-stick` in place and print the explicit removal command. Use `tt uninstall agents`, `tt uninstall --shared`, or `tt uninstall --all` to remove the shared skill target.

### Fixed
- **Duplicate skill entries are pruned conservatively.** Installs, update cleanup, and first-run migration remove only proprietary `talking-stick` symlinks that resolve to the bundled skill, including both OpenCode roots (`~/.config/opencode/skills` and `~/.opencode/skills`). Copies, foreign symlinks, and hand-authored directories are preserved and audited.

## [0.4.12] — 2026-06-09

Full notes: [`docs/releases/0.4.12.md`](docs/releases/0.4.12.md).

### Fixed
- **No-op `tt install` runs are quiet.** Legacy MCP cleanup lines are only printed when an entry was actually removed, preserved, or failed — `absent`/`skipped` no-ops stay silent. The Grok session hook and Gemini skill installs now inspect their targets and report `already_present` instead of rewriting (`ok: Updated ...`) or re-linking (`added: ok`) on every run, and the `tt instructions edit` hint only prints when an install actually changed something.

## [0.4.11] — 2026-06-09

Full notes: [`docs/releases/0.4.11.md`](docs/releases/0.4.11.md).

### Fixed
- **Guardian no longer leaks when readiness times out.** `spawnGuardian`'s readiness timeout now kills the detached child and clears its listeners before rejecting. Previously the orphaned guardian survived, wrote `READY` to a stream nobody read, and held the lease indefinitely with no recorded PID for `stopGuardian` to reach. (#31)
- **Fair-turn ordering survives member churn.** Round-robin distance is now computed from each member's rank within the current member list instead of raw join ordinals modulo member count, which inverted ordering once departures left sparse ordinals (e.g. `[0, 5, 7]`). (#32)
- **Reserved-member liveness gets the same gone grace as owners.** Both room-inspection paths now run the reserved branch through `isGonePersistent`, so a transient process-check misread right after claim expiry can no longer deny the rightful recipient its grant. (#33)
- **`cli-sessions.json` and harness config patches are written atomically.** Both now write to a temp sibling and `rename`, so a crash or full disk mid-write can no longer truncate the session store or a user-owned config such as `opencode.json`. (#34)
- **`ps` lstart parsing is locale-stable.** Process inspection invokes `ps` with `LC_ALL=C`, so non-C locales no longer silently degrade identity resolution and liveness to the weakest fallback. (#35)
- **Errors are machine-readable in JSON mode.** When `--json` is requested, plain CLI errors serialize as `{"error": "cli_error", "message": ...}` on stderr (matching `ProtocolError`'s shape) instead of bare text, keeping the non-zero exit code. (#36)
- **Boolean flags never consume positionals.** The CLI parser has a boolean-flag registry, retiring the `--json`-eats-positional footgun and the per-command repair shims; `--after`-style integer options now reject trailing garbage like `100ms`. (#37)
- **Non-harness `##` headings no longer bleed into harness sections.** In instruction files, an unrecognized `##` heading after harness sections ends the current section; its content is excluded from harness extraction. (#38)
- **OpenCode skill installs follow the XDG-aware config dir.** The skill now lands next to `opencode.json` (normally `~/.config/opencode/skills/talking-stick`, honoring `XDG_CONFIG_HOME`) instead of the hardcoded `~/.opencode` tree; verified against OpenCode source, which scans both `skill/` and `skills/` under the config dir. (#39)
- **Restarted Grok sessions mint fresh identity.** When PID identity is available but matches no recorded session, the workspace-candidate fallback no longer hands the new process the previous session's identity while the old `session_end` hook is pending. (#40)
- **`tt install` is idempotent for skills.** Skill install actions carry `operation`/`inspect`, so a second run reports `already_present` instead of deleting and re-copying the skill directory every time. (#41)
- **Docs drift from the MCP-to-skill migration cleaned up.** AGENTS.md/README no longer reference the removed `src/mcp-server.ts` entry point or stale install paths; `patchOpencodeConfig`'s dead install branch is gone and the legacy `tt mcp` command constant is marked as match-only. (#42)

## [0.4.10] — 2026-06-08

Full notes: [`docs/releases/0.4.10.md`](docs/releases/0.4.10.md).

### Added
- **Grok Build harness support.** `tt install grok` now installs the native `~/.grok/skills/talking-stick` skill and a trusted global `~/.grok/hooks/talking-stick-session.json` hook. Grok-launched `tt` calls work without cmux by detecting a `grok` root process in ancestry; `CMUX_AGENT_LAUNCH_KIND=grok` remains optional fast evidence when present. The hook records `GROK_SESSION_ID` context in `${TALKING_STICK_DATA_DIR}/grok-sessions.jsonl` so identity can upgrade from pid-root identity to the real Grok session id when the record matches the workspace and harness process.

## [0.4.9] — 2026-06-03

Full notes: [`docs/releases/0.4.9.md`](docs/releases/0.4.9.md).

### Fixed
- **Home-level workspace markers no longer capture scratch directories.** `resolveContextPath` now treats the user's home directory as a marker boundary for descendant paths, so an incidental `~/package.json`, `~/AGENTS.md`, or similar marker does not make unrelated markerless paths under `$HOME` join a home-scoped room. Explicitly joining `$HOME` still resolves to home, and real project markers below home still win.

## [0.4.8] — 2026-05-21

Full notes: [`docs/releases/0.4.8.md`](docs/releases/0.4.8.md).

### Added
- **`coordination_prompt` in coordination command JSON.** Object-shaped JSON results from the common coordination commands (`join`, `state`, `events`, `wait`, `try`, `take`, `takeover`, `release`, `pass`, `assign`, `msg send`) now carry a short `coordination_prompt` reminder: keep `tt wait`/`tt events` active until all goals are met, and re-read the Talking Stick skill if context slips. The field is added only to plain JSON objects — event-stream arrays and instruction output are left untouched — and is never duplicated if a result already includes it. This keeps the stay-in-the-loop guidance in front of a harness even when the skill has scrolled out of context.

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

## [0.3.0] — 2026-05-05

Full notes: [`docs/releases/0.3.0.md`](docs/releases/0.3.0.md).

### Breaking changes
- **MCP server surface removed.** Removed the MCP stdio server implementation, `tt mcp` command registration, MCP-specific tests, and the `@modelcontextprotocol/sdk` dependency. `tt --help` no longer advertises MCP startup, and `tt install` no longer writes MCP server config.
- **`tt install` is skill-only.** `tt install <harness>` now installs or refreshes the bundled `talking-stick` skill for Claude Code, Codex, Gemini, and OpenCode. The older `tt install-skill` / `tt uninstall-skill` command surface was removed.

### Changed
- **CLI-only runtime.** Harnesses now coordinate by running `tt` subprocesses for join, wait, handoff, notes, messages, and event receive. The bundled skill teaches `tt events --follow --json` as the ambient receiver, `tt wait --json` for ownership, and `tt events --wait --after <cursor> --json` as an observer-only fallback for harnesses that cannot consume long-running stdout.
- **Stable CLI identity preference.** CLI identity resolution now prefers stable harness ancestry over transient terminal ids when no explicit harness session id exists, keeping repeated shell-outs from one harness attached to the same room member.

### Migration
- **Stale MCP cleanup.** Updates remove stale Talking Stick MCP registrations during package postinstall, self-update, first installed-package invocation after a version change, and explicit install/uninstall. Cleanup records JSONL audit entries in `${TALKING_STICK_DATA_DIR}/update-migrations.log`.

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

[0.12.1]: https://github.com/mostlydev/talking-stick/releases/tag/v0.12.1
[0.12.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.12.0
[0.11.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.11.0
[0.10.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.10.0
[0.9.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.9.0
[0.8.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.8.0
[0.7.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.7.0
[0.6.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.6.0
[0.5.1]: https://github.com/mostlydev/talking-stick/releases/tag/v0.5.1
[0.5.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.5.0
[0.4.13]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.13
[0.4.12]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.12
[0.4.11]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.11
[0.4.10]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.10
[0.4.9]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.9
[0.4.8]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.8
[0.4.7]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.7
[0.4.6]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.6
[0.4.5]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.5
[0.4.4]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.4
[0.4.3]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.3
[0.4.2]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.2
[0.4.1]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.1
[0.4.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.4.0
[0.3.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.3.0
[0.2.0]: https://github.com/mostlydev/talking-stick/releases/tag/v0.2.0
[0.1.4]: https://github.com/mostlydev/talking-stick/releases/tag/v0.1.4
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
