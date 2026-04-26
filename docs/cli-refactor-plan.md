# CLI Refactor Plan

This plan captures the intended cleanup after the `self-update` release lands.
The first implementation pass should be behavior-preserving: move code into
clear modules, add seams, and keep command behavior stable.

## Current Problem

`src/cli.ts` has become the main integration point for unrelated concerns:

- command parsing and dispatch
- text and JSON output
- room/session lookup
- human vs harness identity
- guardian process lifecycle
- handoff parsing
- notes commands
- turn commands
- install and install-skill commands
- startup maintenance such as skill sync and self-update

That makes simple behavior changes expensive because unrelated flows share one
large file and many private helpers. It also makes it hard to reason about which
commands should run startup maintenance, open the database, spawn guardians, or
print human text.

## Goals

- Keep the CLI behavior stable while splitting by responsibility.
- Make command routing declarative enough that command-level side effects are
  visible in one place.
- Isolate startup maintenance (`self-update`, installed-skill sync, future
  checks) from command business logic.
- Keep tests focused on public behavior, not incidental file layout.
- Preserve the current human/harness UX: human CLI text by default, harness CLI
  JSON by default, and opt-in harness identity.

## Non-Goals

- Do not redesign the protocol or service layer in this refactor.
- Do not change CLI command names or output shapes unless a follow-up behavior
  task explicitly calls for it.
- Do not combine this with release/version bump work.
- Do not rewrite install planners or service state transitions unless the
  refactor exposes a concrete bug.

## Proposed Module Split

Create a `src/cli/` directory and move code in small, reviewable slices:

- `src/cli/parser.ts`: `ParsedCommand`, `parseCommand`, option helpers, boolean
  flag normalization.
- `src/cli/runtime.ts`: runtime creation/closing, command context, and shared
  command dependencies.
- `src/cli/identity.ts`: CLI identity resolution, harness env detection, and
  `whoami` formatting.
- `src/cli/output.ts`: `printResult`, `shouldUseJson`, relative-time formatting,
  handoff formatting, indentation, and command help rendering.
- `src/cli/handoff.ts`: `resolveHandoff`, stdin reading, and handoff JSON
  validation.
- `src/cli/session.ts`: room/session resolution for reads, notes, and active
  lease commands.
- `src/cli/guardian.ts`: guardian spawn, self-spawn resolution, liveness checks,
  and guardian stop.
- `src/cli/turn-commands.ts`: `wait`, `try`, `take`, `takeover`, `release`,
  `pass`, and `assign`.
- `src/cli/notes-commands.ts`: `notes add`, `notes list`, note formatting, and
  note path resolution.
- `src/cli/install-commands.ts`: `install`, `uninstall`, `install-skill`,
  `uninstall-skill`, action planning output, and result reporting.
- `src/cli/startup-maintenance.ts`: installed-skill sync, self-update checks,
  and command gating for maintenance tasks.
- `src/self-update.ts`: keep self-update implementation separate from CLI
  wiring.

The existing `src/cli.ts` should shrink to an entry point that parses argv,
runs startup maintenance when appropriate, dispatches to a command handler, and
handles top-level errors.

## Command Registry

Replace the long top-level `if`/`switch` chain with a command registry. Each
entry should declare:

- command name
- handler function
- whether the handler needs a `TalkingStickService` runtime
- whether startup maintenance should run before the command
- whether the command is internal (`guard`, `mcp`) or user-facing
- optional aliases, for example `takeover` delegating to `take`
- one-line help text and usage

This keeps command behavior visible without reading every handler. It also makes
future commands like `self-update` less likely to accrete special cases in the
top-level entry point.

## Startup Maintenance

Human CLI startup maintenance should be centralized:

- skip for harness-aware CLI invocations
- skip for `mcp` and `guard`
- skip for explicit install/uninstall/self-update commands unless that command
  explicitly opts in
- be best-effort by default and never make an unrelated command fail
- provide a test seam so sync/update decisions can be unit-tested without
  touching real home directories or shelling out

The current installed-skill sync is intentionally silent. `self-update` may need
different UX, but the decision of whether to check should live in the same
maintenance gate.

## Suggested Implementation Order

1. Add the `src/cli/` directory and move pure parsing/output helpers first.
   Keep exports small and update imports without changing behavior.
2. Move handoff and session helpers. Run CLI tests after this slice.
3. Move guardian lifecycle helpers. Run CLI tests and at least one manual
   `tt take`/`tt release` smoke test after build.
4. Move notes and install command handlers into their modules.
5. Move turn command handlers last, because they touch the most state and
   guardian/session behavior.
6. Introduce the command registry once handlers are separated. Avoid doing the
   registry first; otherwise the diff mixes routing and extraction.
7. Move installed-skill sync and self-update gating into
   `startup-maintenance.ts`.
8. Leave `src/cli.ts` as the thin entry point and delete any duplicated helper
   exports.

## Test Plan

Run after each substantial slice:

```bash
npm run typecheck
npm test -- tests/cli.test.ts
```

Run before committing:

```bash
npm test
npm run build
node dist/cli.js --help
git diff --check
```

Add or preserve coverage for:

- human vs harness identity resolution
- `--json` / `--text` output selection
- `tt pass` path parsing
- `tt assign next`
- human `tt take` operator override
- harness `tt take` reason enforcement
- notes path/session resolution
- install and install-skill skip-on-absent behavior
- installed-skill sync startup gating
- self-update command behavior from Claude's release

## Review Checklist

- `src/cli.ts` is small enough to read as the CLI entry point.
- No handler imports `process.argv` directly.
- No handler writes to stdout except through output helpers.
- Startup maintenance is not run for MCP server startup or guardian subprocesses.
- Install planners remain reusable outside the CLI.
- Guardian code remains isolated and covered by existing liveness tests.
- The refactor commit contains no intentional behavior changes.

## Open Questions

- Should command help be generated entirely from the registry, or should the
  registry only provide metadata while `help.ts` controls layout?
- Should `self-update` be a startup maintenance check, an explicit command only,
  or both with different output modes?
- Should installed-skill sync become once-per-bundled-skill-digest instead of
  checking every human CLI invocation?
