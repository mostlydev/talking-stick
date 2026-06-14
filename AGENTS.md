# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript implementation for the CLI, storage, service protocol, and install flows. The main entry points are `src/cli.ts` and `src/index.ts`; support modules such as `src/service.ts`, `src/db.ts`, and `src/install.ts` keep coordination, persistence, and harness integration separated. `tests/` mirrors that structure with Vitest suites like `tests/cli.test.ts` and `tests/talking-stick.test.ts`, plus helpers in `tests/fixtures/`. `docs/` holds design notes and release docs, `skills/talking-stick/` ships the portable skill, and `dist/` is generated build output and should not be edited by hand.

## Build, Test, and Development Commands

- `npm install`: install dependencies for local development.
- `npm run build`: compile TypeScript into `dist/` and mark `dist/cli.js` executable.
- `npm test`: run the full Vitest suite once.
- `npm run typecheck`: run strict TypeScript checks without emitting files.

Use Node `>=22`, as declared in `package.json`. For quick manual verification, run commands such as `node dist/cli.js whoami --json` after a build.

## Coding Style & Naming Conventions

This repo uses strict TypeScript with ESM (`"type": "module"` and `moduleResolution: "NodeNext"`). Match the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` extensions in local imports from TypeScript files. Keep files focused and name them by responsibility, for example `path-resolution.ts` or `session-store.ts`. Prefer small helpers over deeply nested logic, and keep exported types near the modules that own them.

## Testing Guidelines

Vitest runs in a Node environment with global setup from `tests/setup.ts`. Name tests `<feature>.test.ts` and extend the suite that matches the behavior you changed. Add regression coverage for CLI flows, room state transitions, SQLite-backed persistence, and harness install logic when those areas move. Run `npm test` and `npm run typecheck` before opening a PR.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Add MCP smoke coverage` and `Fix bin[tt] path to satisfy npm publish validator`. Follow that pattern, keep commits scoped, and avoid mixing refactors with behavior changes when possible. PRs should summarize the user-visible change, list affected commands or harnesses, link the issue when applicable, and update `README.md`, `docs/`, or the shipped skill when install or coordination behavior changes.

## Runtime & Dogfooding Notes

- `tt` executes `dist/cli.js`, not `src/` — run `npm run build` after source changes, and restart any long-running harness process that caches the old dist.
- `~/.claude/skills/talking-stick` and shared `~/.agents/skills/talking-stick` may be symlinked back to `skills/talking-stick` via `npm link` + `tt install --link`; edits via either path propagate. Codex, Antigravity, Grok, and OpenCode use the shared `.agents` skill target. Grok still also installs `~/.grok/hooks/talking-stick-session.json`; proprietary Codex/Grok/OpenCode skill symlinks are duplicate-cleanup targets.
- CLI identity first checks harness signals such as `CLAUDECODE`, `CODEX_THREAD_ID`, `ANTIGRAVITY_AGENT=1`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_TRAJECTORY_ID`, `GEMINI_CLI`, `CMUX_AGENT_LAUNCH_KIND=grok`, `OPENCODE`, or explicit `TT_HARNESS_AGENT_ID=<id>`. It falls back to `human:<user>` only when no harness signal is present. Antigravity uses `ANTIGRAVITY_CONVERSATION_ID` as the preferred session anchor, then `ANTIGRAVITY_TRAJECTORY_ID`, then `agy` ancestry. `TT_HARNESS_EXPORT=1` enables ancestry-only detection for most harnesses when env markers are unavailable. Grok does not depend on cmux: without a Grok env marker, `tt` still walks process ancestry for a `grok` root process. Grok's `GROK_SESSION_ID` is hook-only; `tt install grok` installs `~/.grok/hooks/talking-stick-session.json`, and that hook records session context in `${TALKING_STICK_DATA_DIR}/grok-sessions.jsonl` for later identity upgrades. CLI commands derive harness identity from env/ancestry. Use `tt whoami --explain` to see the decision.
- Liveness uses trim-normalized `process_started_at` and a `2 * heartbeatIntervalMs` silence grace; a momentary `gone` reading no longer voids an active lease. `recipient_gone` is a diagnostic label only — actual takeover is gated on `claim_expires_at`.
- Boolean CLI flags are registry-backed in `src/cli/parser.ts`; add new booleans there so they never consume following positional arguments.
- In instruction files, `##` headings that don't name a known harness end the current harness section and their content is excluded from harness extraction (it is neither shared nor attributed to the preceding harness).
- Write-RPCs use `touchMember` (throws `unknown_member` if caller isn't joined); read-RPCs use `touchKnownMember` (silent no-op) so non-members can still read room state, events, and notes.
- Apply `WHERE` filters (e.g. `include_resolved`) in SQL before `LIMIT`, not in a JS `.filter()` after the query — post-filter pagination under-returns.
- CLI tests isolate state via `TALKING_STICK_DATA_DIR` pointed at a temp dir; that env var drives both the SQLite DB and `cli-sessions.json`.
