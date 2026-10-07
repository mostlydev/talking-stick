# Herdr workspace bootstrap

Request: [#91](https://github.com/mostlydev/talking-stick/issues/91). This is a
launch workflow, separate from the session-safe room wake requirements in
[`2026-09-17-herdr-room-wake.md`](2026-09-17-herdr-room-wake.md).

## Proposed operator workflow

```sh
tt up --agents claude,codex --path . --print
tt up --agents claude,codex --path .
tt up --agents claude,codex --path . --new-tab
tt up --agents claude,codex --path . --new-workspace
```

Require an explicit agent list. Default path is the caller's working directory.
Default topology is sibling panes in the caller's current Herdr tab, keeping its
focus. `--new-tab` creates a clean tab in the current workspace; `--new-workspace`
creates a workspace. These flags are mutually exclusive. Current-tab splitting
follows the existing Herdr skill convention and makes the default topology
predictable. A clean tab is recommended for larger groups to avoid squeezing the
caller's pane, but remains an explicit choice. `--print` performs read-only
preflight and shows the plan; `--json` returns structured results without mixing
child stdout into the result.

Start with Claude and Codex adapters. Add Grok only after its skill invocation,
join, and idle receive behavior pass the operator's live acceptance checks.
The operator already runs Grok panes, so its live pass can happen in the first
acceptance session. The current Codex shell cannot find a `grok` executable in
PATH even though the operator has a running Grok pane. An interactive-shell alias
or function may explain the difference; executable preflight must account for
the shell Herdr actually launches. Other Herdr-supported
harnesses are subsequent adapters, not implicit support.

## Launch sequence

1. Require `HERDR_ENV=1` and trusted caller workspace/tab/pane context. Check the
   installed Herdr CLI and running server capabilities. Resolve the requested
   path canonically; require the directory, `tt`, and installed skill paths. Verify
   selected harness executables through Herdr's supported launch environment when
   available; local PATH lookup is diagnostic, not proof of absence from an
   interactive shell. If no read-only shell probe exists, report that uncertainty
   in preview and let agent-start supply the authoritative launch outcome. Do not
   inject a probe command into an existing pane. Fail definitive preflight errors
   before creating anything. Missing
   installation gives an exact `tt install <harnesses>` remedy; launch does not
   install packages or answer hook-trust dialogs.
2. Serialize launch attempts by canonical path (a conservative local scope for v1).
   Use a bounded lock and an atomic local launch record. Store returned workspace,
   tab, and pane IDs; do not predict IDs or use whichever pane is focused.
3. Read the exact room's membership and known launch records. Skip only verified
   live agents of the requested harness in that exact room. Uncertain records or
   agents still starting are reported for inspection, not silently relaunched.
   Sharing a directory does not authorize messaging unrelated existing panes.
4. Create a dedicated chat pane first and run `tt chat` from the canonical path.
   For an explicit new workspace, obtain its root pane from the create response.
   For `--new-tab`, obtain its root pane from `herdr tab create` in the caller's
   workspace. Do not create a second chat for a verified reusable launch record.
   Otherwise split the caller pane with `--no-focus`. Choose right/down splits
   from layout dimensions and balance subsequent splits to avoid narrow columns.
5. Create a fresh shell pane for each missing harness, preserving cwd and focus.
   Call `herdr agent start` with a unique name and the returned pane ID. Prefer
   the harness's initial-prompt positional argument after Herdr's `--`; both
   installed Claude and Codex CLIs advertise interactive positional prompts.
6. The single bootstrap prompt explicitly names
   the talking-stick skill, give the resolved SKILL.md and canonical room path,
   and instruct the agent to join, load instructions, and use its taskless
   standby/park path. Do not claim the stick or invent work. Use a per-harness
   prompt adapter rather than assuming `/talking-stick` means the same thing in
   every harness. Only adapters without an initial-prompt argument use a separate
   `herdr agent prompt` after the expected agent is ready. Never submit the prompt
   twice if `agent start` times out after possibly launching with its initial prompt.
7. Confirm a new exact-room member whose harness/session/process identity matches
   the created pane. Compare Herdr's `agent_session.value` with the member's
   `harness_session_id` after removing its `harness:` prefix, together with local
   process incarnation and harness kind. Missing session evidence is unconfirmed,
   not success. Kind or cwd alone cannot distinguish two same-harness agents.
   Prompt submission and a settled Herdr state alone are not
   proof the skill loaded or the agent joined. Use bounded join observation through
   the service event stream; do not add another ordinary agent `tt wait` listener.
8. Return each created/skipped pane and agent, membership evidence, blocked/failed
   stages, and what the operator must do next. A partial or unconfirmed launch
   exits nonzero while retaining successful agents and the chat console.

Allow explicit per-agent native arguments through a repeatable option such as
`--agent-arg claude=VALUE`; add repeatable-option parser support with tests. Never
add permission-skipping flags implicitly. Arguments are separate argv entries,
not shell-interpolated text; reject modes that replace interactive bootstrap with
an unrelated subcommand or noninteractive execution.

## Failure and restart behavior

Record intent and outcomes around each external side effect. On interrupted or
timed-out calls, distinguish definite failure from possible submission. Never
retry a prompt automatically after an ambiguous result. A rerun observes the
record and live identities before deciding anything; no duplicate agents, chat
consoles, or prompts should appear on a normal repeat.

Blocked startup leaves its pane available and reports the dialog for the
operator. Never accept permissions, trust a repository, or type into an existing
draft automatically. Leave partially created panes for inspection. Any future
cleanup must be limited to panes created by this invocation whose occupants are
still proven to be idle shells; do not force-close live agents.

Herdr is used only for fresh launch. It is not enabled as Talking Stick's ongoing
idle-wake transport: the separate room-wake plan requires send-time session
validation and composer protection before that can be safe.

## Implementation boundaries

- `src/herdr.ts`: injected subprocess runner, bounded requests, JSON result
  validation, capability checks, opaque IDs, layout and agent calls.
- `src/workspace-launch.ts`: preflight, orchestration, launch record and lock,
  repeat/failure policy, membership confirmation; separate from service leases.
- `src/cli/up.ts`: argument validation and text/JSON results. Register `up` in
  `src/cli/registry.ts` and `new-workspace`/`new-tab` as booleans in
  `src/cli/parser.ts`. Implement and test `--print` first.
- Keep per-harness skill invocation adapters explicit and testable. Reuse existing
  path resolution and skill installation discovery instead of a new path table.
- Update README, command reference, changelog, and shipped skill only after the
  behavior exists. Keep build and shared edits under Talking Stick ownership.

## Verification and operator acceptance

Fake-Herdr tests specify the exact argv and response sequence: outside-Herdr
rejection, missing capability/executable/skill, no mutation on print or failed
preflight, cwd/focus/layout preservation, opaque IDs, start readiness, blocked
startup, join evidence, normal repeat, concurrent launch, interrupted records,
partial failure, ambiguous prompt timeout, and clean JSON output. Assert no
unrelated panes are prompted or closed, and no taskless agent is asked to claim.

Run the full suite, typecheck, and build. Independently review the final behavior
in the room, then ask the operator to exercise a dedicated test workspace:

1. Preview the launch; confirm selected agents, repo path, and pane layout.
2. Launch Claude and Codex; verify readable panes, preserved focus, skill loaded,
   both members visible in chat, and idle room without stick churn.
3. Give a small chat task; verify both agents receive it and handoff works.
4. Run the same command again; verify no duplicate panes, members, or prompts.
5. Test a blocked agent and a failed launch; resolve the dialog personally and
   verify the reported state is honest and successful peers remain usable.
6. Repeat with `--new-tab` and `--new-workspace`; add Grok after its own live pass.

No release until the operator accepts this behavior. Do not replace or restart
the live Herdr server as part of testing.

## Development machine preparation (completed)

On 2026-10-07, `npm run build` and `npm link --ignore-scripts` linked the active
mise Node 26.7.0 global `talking-stick` package to this repository. The `tt`
executable resolves to `/Users/wojtek/dev/ai/talking-stick/dist/cli.js`. Claude and
shared `.agents` skills resolve to this repository's `skills/talking-stick`.
`tt install claude-code codex grok --link --replace` installed supported lifecycle
hooks and Grok session/inbox/stop hooks; Grok hooks were previously absent.
Claude independently verified command/skill paths, identity, and member and
non-member room reads.

Exact pre-switch package, skill links, and affected hook configurations are
backed up at
`/Users/wojtek/.local/share/talking-stick/dev-switch-backups/2026-10-07` with an
existence/symlink manifest. Normal rollback is `npm install -g talking-stick@0.20.0`
followed by skill installation from that package; the snapshot supports exact
restoration of affected files, including removal of newly added Grok hooks.

The development command follows this checkout's current branch, including the
unmerged #89/#90 fixes. Changing the active mise Node version changes the global
prefix and may require linking again. Source changes require a build. Reopen
`tt chat` and restart existing Claude/Codex/Grok harness sessions to load updated
skills and cached code; Codex lifecycle hooks also require operator review/trust
through `/hooks`. Existing sessions were left running.
