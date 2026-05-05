# CLI-Only Coordination And MCP Removal

**Status:** draft by `codex:d4bc2492`, incorporating Claude OOB review. **Branch:** `oob-identity-fix-plan`.

## Why This Change

Out-of-band messaging exposed a deeper problem: Talking Stick has two harness integration paths, CLI and MCP, and they do not share the same process context. A message addressed to the MCP-side agent id can disappear from `tt msg recv --target self` if the CLI-side resolver produces a different id. Fixing one resolver bug helps, but keeping MCP in the active path preserves the same class of failure.

The new direction is simpler: **the `tt` CLI is the only harness contract.** Agents coordinate by running `tt` commands. MCP is removed from install, docs, skills, tests, and eventually package dependencies. The SQLite-backed service/core can stay as internal implementation; the public automation surface is `tt`.

## Goals

- Make every agent workflow expressible through CLI commands: `tt join`, `tt wait`, `tt release`, `tt assign`, `tt take`, `tt state`, `tt events`, `tt notes`, and `tt msg`.
- Make ambient receive CLI-first: `tt events --follow --target self --json` for live stdout consumers, `tt events --wait --after <cursor> --target self --json` for process-completion consumers, and `tt msg recv` only for messages-only consumers.
- Remove MCP registration from `tt install` and remove `tt mcp` as a supported command.
- Automatically remove stale Talking Stick MCP registrations from every supported harness during update/first-run migration.
- Update the bundled skill so harnesses prefer CLI even when MCP tools exist in older installations.
- Replace MCP smoke coverage with real child-process CLI smoke coverage, including SIGTERM/cursor behavior.
- Keep long turns safe by making the CLI-owned lease guardian a first-class contract of `tt wait` / `tt take`.
- Preserve human-friendly CLI defaults: human shells get readable text unless `--json` is explicit; harness-detected shells get JSON where machine output is expected.

## Non-Goals

- No backward compatibility promise for MCP users beyond automatic cleanup of stale Talking Stick-owned MCP registrations. This is an intentional breaking simplification.
- No plugin requirement. Plugins may later wrap the CLI, but v1 must work with subprocesses and stdout.
- No daemon. The existing SQLite service and `tt guard` process model remain enough; do not reintroduce a long-running automation server under another name.
- No change to the single-writer room semantics.

## Target Architecture

### Public Surface

`tt` is the public API. Harnesses call it through shell/exec facilities and parse JSON when they need structured output.

Core command mapping:

| Need | CLI |
|---|---|
| Join room | `tt join [path] --json` |
| Wait/claim | `tt wait [path] --timeout 110s --json` |
| Probe | `tt try [path] --json` |
| Release | `tt release [path] --stdin` |
| Assign specific next holder | `tt assign <agent_id> [path] --stdin` |
| Operator takeover | `tt take [path] --operator-requested --reason ... --json` |
| State | `tt state [path] --json` |
| Events | `tt events [path] --after N --target any --json` |
| Notes | `tt notes add/list ... --json` |
| Send OOB | `tt msg send <recipient|room> <body...> --json` |
| Ambient receive | `tt events --follow --target self --json` |
| Messages-only receive | `tt msg recv --follow --target self --json` |

The skill should teach these exact commands. It should not mention `join_path`, `wait_for_turn`, `release_stick`, `send_message`, or any MCP tool as a preferred path.

Successful `tt wait` and `tt take` calls must start or repair the internal `tt guard` lease guardian and return its `guardian_pid` in JSON. That guardian is not a harness API; it is the CLI's mechanism for keeping long turns alive after the `tt wait` process exits.

### Internal Surface

Keep `TalkingStickService` / `TalkingStickCommands` as internal TypeScript modules backing the CLI. They are not the harness API. The command layer owns input parsing, identity, JSON/text output policy, guardian spawning, and child-process behavior.

The CLI-only rule applies to external harness coordination. Same-package processes may still call internal modules when they are part of Talking Stick itself. The diff walker should use direct SQLite or internal service reads for its hot attribution/watch path, then use normal CLI commands for rare outward actions such as sending an annotation message or adding a note.

### Holder Lease Guardian

Claude's main review concern is load-bearing: if `tt wait` exits and no process continues heartbeating, a holder doing a long edit can time out and look stale. The current `tt wait` path already has the right shape: it spawns internal `tt guard` and records the guardian in the CLI session. The CLI-only migration should make that behavior explicit and tested, not incidental.

Required behavior:

- `tt wait --json` returning `your_turn` includes `guardian_pid`.
- `tt take --json` returning success includes `guardian_pid`.
- If the caller already owns the turn and the old guardian is gone, `tt wait` repairs it by spawning a replacement.
- `tt release`, `tt pass`, and `tt assign` do not require the original `tt wait` process to still exist; they rely on the persisted CLI session and identity.
- Tests kill the guardian and prove the next owner command either repairs or reports the problem clearly.

This avoids a harness-level `tt heartbeat` timer and avoids wrapping all work in a daemon-like `tt hold` command.

### Process Cost

CLI-only coordination pays a Node startup and SQLite-open cost for every command. That is acceptable for `tt wait` cycles, handoffs, notes, and OOB messages. Do not answer this by adding a long-running daemon unless the operator explicitly reverses the CLI-only decision; a daemon would recreate the same dual-context class of failure that led to removing MCP.

### Identity

With MCP removed, issue #19 becomes a CLI-only identity reliability issue instead of a CLI-vs-MCP comparison. The resolver still needs to be stable across repeated shell-outs from the same harness:

1. `TT_HARNESS_AGENT_ID` wins when explicitly exported.
2. Harness-provided stable ids win next (`CODEX_THREAD_ID`, `OPENCODE_RUN_ID`, similar).
3. Harness-root ancestry wins before terminal ids for no-session-id harnesses like Claude Code.
4. Terminal ids (`ITERM_SESSION_ID`, `CMUX_TAB_ID`, etc.) are fallback only after no harness root can be found.
5. Human fallback remains `human:<username>`.

Live receivers should either use the resolved harness id directly or run under `TT_HARNESS_AGENT_ID=<agent_id>` when a wrapper has already joined a room as that id.

### Install

`tt install` should become a skill/bootstrap installer, not an MCP installer. Update paths should also clean up old MCP registrations automatically so existing harnesses stop seeing the removed integration surface.

Proposed behavior:

- `tt install <harness...> | --all [--print] [--copy] [--link]`: install/update the bundled skill only.
- Remove `tt install-skill` / `tt uninstall-skill` once `tt install` owns skill installation. There is no compatibility requirement to keep parallel install verbs.
- `tt uninstall`: remove the skill install and Talking Stick-owned stale MCP config entries.
- Remove MCP config writes for Claude, Codex, Gemini, and OpenCode.
- Remove `DEFAULT_SERVER_COMMAND = ["tt", "mcp"]`.
- Remove native `harness mcp add/remove` command planning.

### Update-Time MCP Cleanup

Backward compatibility means removing the stale broken path, not keeping it alive. A user who updates from an MCP-capable version should not have to manually edit every harness config.

Required behavior:

- The package update lifecycle runs a cleanup pass when the package manager executes install/update scripts.
- `tt self-update` in versions that know about this migration runs the cleanup pass after the package manager completes.
- The first normal `tt` invocation after a package version change runs the same cleanup pass, covering users who update from an older `tt self-update`, skip lifecycle scripts, or use `npm update -g`, `mise`, `pnpm`, or another manager.
- Cleanup targets all supported harness config locations, not only the currently detected harness. Old entries in Claude, Codex, Gemini, and OpenCode should be removed together.
- The cleanup is idempotent and silent when nothing changes. If it modifies config during an interactive human CLI run, print a concise summary; harness JSON commands should not get noisy text.
- Always append an audit entry for removals with harness, config path, and removed server key/name so an operator can inspect why an MCP entry disappeared.
- Only remove Talking Stick-owned MCP entries by strict inverse-of-install matching: canonical server name/key `talking-stick` plus the exact command/args shape this installer previously wrote for that harness.
- Leave hand-edited or custom entries alone, even if they mention `talking-stick`, when the name/key or command/args no longer match the canonical installed shape.
- Do not remove unrelated MCP servers or unrelated harness settings.
- Config writes remain atomic and should preserve formatting where the existing installer machinery already can.

Implementation shape:

- Add `removeStaleMcpRegistrations({ harnesses: "all", reason: "update" })` in the install/maintenance layer.
- Track the last package version that completed migration in the Talking Stick data dir, separate from room state, so startup can cheaply decide whether to run it.
- Expose a non-interactive internal cleanup entrypoint that package lifecycle scripts can call without joining rooms or emitting harness JSON.
- Reuse the existing harness config discovery/write helpers and adapter-level install shape. Removal should be the inverse of install, not a second parser/matcher.
- Delete MCP add planning after cleanup support lands, but keep the adapter-owned stale-entry removal path.
- Add fixture tests for each supported harness proving a stale canonical Talking Stick MCP entry is removed, a neighboring unrelated MCP entry survives, and a hand-edited Talking Stick-looking entry survives.
- The audit log lives in a dedicated `${TALKING_STICK_DATA_DIR}/update-migrations.log`, not the general maintenance log. Update migrations are infrequent destructive events that operators may need to grep for after the fact ("why did my MCP entry disappear?"); mixing them with daily startup chatter makes that grep noisy and the destructive history harder to see at a glance. Format: one JSON line per migration run with `{ ts, package_version_from, package_version_to, harness, config_path, action, server_name }`.

### OOB Messaging And Ambient Receive

OOB stays on the existing `room_events` / `message_sent` substrate, but all live receive UX is CLI-based.

The recommended ambient consumer is **`tt events --follow --target self --json`**, not `tt msg recv --follow`. The event stream surfaces direct messages, broadcasts, **and** turn passes/reservations on a single ordered feed. A messages-only receiver silently misses the moment another agent passes you the stick — exactly the gap that motivated this section. The skill teaches the unified consumer in §2 (start it right after `tt join`) and references it from §4.5.

Required receive contract:

- `tt events --follow --target self --json` emits one JSON event per line for messages, broadcasts, and turn handoffs targeting the caller.
- It exits cleanly on SIGTERM/SIGHUP and writes the cursor to stderr as today.
- `tt events --wait --after <cursor> --target self --json` exits after the next matching batch for harnesses that cannot monitor long-running stdout.
- `tt msg recv --follow` and `tt msg recv --wait` remain available as messages-only feeds for harnesses that explicitly want the narrower stream, but the skill marks them as fallback rather than primary.
- First launch starts at the room tail unless `--after` is explicit, avoiding historical replay.
- Direct messages and room broadcasts are included for `target=self`; the caller's own broadcasts are excluded.

## Implementation Sequence

### Stage 1 — Skill And Plan

This PR:

- Add this plan.
- Update `skills/talking-stick/SKILL.md` to be CLI-only.
- Remove MCP-first language from the OOB skill section.
- Keep source code unchanged except docs/skill, so Claude can review direction before the destructive code pass.

### Stage 2 — CLI Identity Hardening

- Change resolver precedence so harness-root ancestry beats terminal-session fallback when a harness env marker exists but no stable session id is present.
- Add tests for Claude CLI shell-out matching repeated invocations from the same harness root.
- Add child-process tests proving `tt events --target self` receives direct messages and turn handoffs addressed to the active CLI member without `TT_HARNESS_AGENT_ID`.
- Keep narrower coverage proving `tt msg recv --target self` receives direct messages without widening into non-message events.
- Add guardian tests proving `tt wait` / `tt take` return a live `guardian_pid`, and that a subsequent `tt wait` repairs a dead guardian for an existing owner.
- Keep `TT_HARNESS_AGENT_ID` override as the explicit escape hatch.

### Stage 3 — Installer De-MCP

- Change `tt install` / `tt uninstall` to manage skill installs plus cleanup of stale Talking Stick MCP entries.
- Add automatic stale MCP cleanup to package update lifecycle, `tt self-update`, and first-run-after-version-change startup maintenance.
- Delete MCP add planning from `src/install.ts`; keep only the adapter-owned inverse-of-install removal/migration code needed to clean stale Talking Stick-owned entries.
- Remove stale Talking Stick MCP entries during `tt uninstall` too; do not remove unrelated harness config.
- Update README install instructions.
- Add tests showing `tt install --all` skips missing harnesses silently and does not write MCP config.
- Add update-migration tests covering all supported harnesses, idempotency, and preservation of unrelated MCP servers.

### Stage 4 — Remove MCP Server Surface

- Remove `tt mcp` from the command registry and help.
- Delete `src/mcp-server.ts` and MCP-specific tests.
- Delete `src/server.ts` unless another stdio entrypoint still needs it.
- Remove `@modelcontextprotocol/sdk` from `package.json`.
- Remove MCP exports from `src/index.ts`.
- Replace MCP smoke tests with CLI child-process smoke tests covering join/wait/release/msg/notes.

### Stage 5 — Docs And Release Notes

- Rewrite README around CLI-first coordination.
- Update `docs/receive-consumer-contract.md` to describe CLI subprocess consumers, not MCP wrappers.
- Update older OOB plan docs with a superseded note pointing here.
- Add a release note marking the change as breaking.

### Stage 6 — Live Dogfood

Before merging the code-removal PR:

- Start Claude receiver with `tt events --follow --target self --json`.
- Start Codex receiver the same way.
- Send direct and broadcast messages both directions.
- Verify `tt wait --timeout 110s --json`, `tt release --stdin`, and `tt assign <agent>` work from harness shell-outs.
- Verify no MCP subprocess is required for the room to operate.

## Risks

- **Harnesses without reliable shell execution.** If a harness cannot run `tt`, it cannot use Talking Stick. That is acceptable under the new direction; the installer/skill should say so clearly.
- **Lease expiry during long turns.** If guardian spawning regresses, long owner turns can time out after `tt wait` exits. Treat guardian behavior as required CLI surface and cover it with child-process tests.
- **Per-command process cost.** Repeated `tt` shell-outs pay Node startup and SQLite open cost. Accept this as the cost of a single CLI context; do not reintroduce a daemon/MCP-like server without an explicit operator change.
- **Long-running receiver lifecycle.** Some harnesses cannot monitor stdout from a running child. Keep `--wait --after` as the supported fallback.
- **Skill drift.** Installed skills may still have old MCP-first text. Human CLI startup sync helps file-based installs, but Gemini registry installs still need `tt install gemini`.
- **Config cleanup safety.** Automatic update cleanup can be destructive if the matcher is too broad. Match only canonical inverse-of-install Talking Stick MCP entries and test with unrelated neighboring MCP servers plus hand-edited Talking Stick-looking entries in every harness fixture.
- **Large test deletion.** Removing MCP tests can accidentally reduce protocol coverage. Replace them with CLI tests before deleting assertions.
- **Diff walker hot path.** A live watcher should not spawn `tt` for every file event. Use direct SQLite/internal reads for hot attribution and CLI subprocesses only for outward coordination events.

## Decisions From Claude Review

1. `tt install` fully replaces `tt install-skill`; remove the parallel verb in the destructive code pass.
2. `tt mcp` is removed immediately rather than kept as a migration shim.
3. Update/first-run maintenance must automatically remove Talking Stick-owned stale MCP config entries across all supported harnesses, and `tt uninstall` should run the same cleanup. It must not touch unrelated harness config.
4. Stale MCP cleanup must reuse each harness adapter's install resolver as the inverse operation. Do not reimplement config matching separately.
5. The diff walker can read SQLite/internal state directly for its hot watch path because it ships in this package; user-facing annotations still go through `tt msg send` or `tt notes add`.
6. The skill's primary ambient receiver is `tt events --follow --target self --json`, not `tt msg recv --follow`. A messages-only consumer silently misses turn passes/reservations and forces harnesses back to polling for the most load-bearing event in the protocol. The unified event stream is the recommended primary path; `tt msg recv` becomes a narrower fallback.
7. Cleanup audit lives in a dedicated `update-migrations.log`, not folded into general maintenance logging. Update migrations are infrequent destructive events; isolating them keeps "why did my MCP entry disappear" answerable by a single `cat`.
