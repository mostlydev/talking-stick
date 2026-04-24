# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the TypeScript implementation for the MCP server, CLI, storage, and install flows. The main entry points are `src/cli.ts`, `src/mcp-server.ts`, and `src/index.ts`; support modules such as `src/service.ts`, `src/db.ts`, and `src/install.ts` keep protocol, persistence, and harness integration separated. `tests/` mirrors that structure with Vitest suites like `tests/cli.test.ts` and `tests/mcp-server.test.ts`, plus helpers in `tests/fixtures/`. `docs/` holds design notes and release docs, `skills/talking-stick/` ships the portable skill, and `dist/` is generated build output and should not be edited by hand.

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

- `tt` executes `dist/cli.js`, not `src/` — run `npm run build` after source changes, and restart the harness's MCP subprocess to pick up the new dist (running servers cache code in memory).
- `~/.claude/skills/talking-stick` may be symlinked back to `skills/talking-stick` via `npm link` + `tt install-skill --link`; edits via either path propagate. Be intentional about which file you're opening.
- CLI identity defaults to `human:<user>`. Harness-aware CLI identity is opt-in via `TT_HARNESS_EXPORT=1` or an explicit `TT_HARNESS_AGENT_ID=<id>`. MCP path always derives harness identity from env/ancestry. Use `tt whoami --explain` to see the decision.
- `getMemberProcessLiveness` does exact-string comparison on `process_started_at`; format drift and code-version skew across MCP server processes can produce spurious `owner_gone`/`recipient_gone` states — don't treat those signals as authoritative without cross-checking (e.g. `ps -p <pid>`).
