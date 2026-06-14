# Plan: Antigravity (agy) harness support + shared `~/.agents/skills` install trimming

- **Date:** 2026-06-13
- **Author:** Claude (draft) + Codex (adversarial review) + Claude (convergence) + Claude (convergence review)
- **Status:** IMPLEMENTED & VERIFIED (2026-06-14). All §12.5 steps 1-9 done. Codex implemented; Claude
  reviewed + tested. Verification: typecheck clean, 386 tests pass, build clean, antigravity identity
  (conversation-id + trajectory fallback) confirmed, real `tt install --all` dogfood migrated to shared
  `~/.agents/skills/talking-stick` + pruned codex/grok/opencode duplicates (claude proprietary & gemini
  symlink left intact), Option B uninstall confirmed (single-harness leaves shared + hint; `agents`/
  `--shared`/`--all` remove shared). §13.2 resolved Option B. REMAINING: git commit + npm release
  (operator-gated, outward-facing).
- **Phase:** draft -> adversarial review -> convergence (done) -> implementation
- **Scope:** Planning only. No code changes in this turn beyond this document.
- **Implementation entry point:** §12 (converged decisions) is authoritative; §1-11 are the
  reasoning trail. Build from §12.5 (build sequence).

## 1. Summary / goals

Two coupled changes:

1. **Add Antigravity CLI (`agy`) as a first-class harness**, replacing the now-deprecated
   Gemini CLI. Antigravity announces itself with env markers `ANTIGRAVITY_AGENT=1`,
   `ANTIGRAVITY_CONVERSATION_ID`, and `ANTIGRAVITY_TRAJECTORY_ID`.
2. **Trim skill-install behavior so Talking Stick does not create duplicate or conflicting
   `talking-stick` skill entries** for harnesses that load skills from a shared
   `~/.agents/skills` directory in addition to (or instead of) their proprietary
   `~/.<harness>/skills` folder.

These are coupled because the most likely reason Antigravity matters here is that Antigravity
reads the shared `~/.agents/skills` location rather than a proprietary folder, which is exactly
the duplication problem we need to solve generally.

The two changes share one root design decision: **install the skill once per physical location,
keyed by a per-harness "skill loading model," instead of once per harness name.**

## 2. Current state (evidence)

All paths below are in this repo at the time of writing (package version 0.4.12).

### 2.1 Harness enumeration is duplicated across several modules

There is no single registry of harnesses; the set is re-declared per concern, so adding/removing
a harness touches many files:

- `src/install.ts:7` — `SUPPORTED_HARNESSES = ["claude-code", "codex", "gemini", "grok", "opencode"]`
  (install ids; drives `tt install`, `--all`, `parseHarnessList`, stale-MCP cleanup).
- `src/skill-install.ts:15` — `FILE_SKILL_HARNESSES = ["claude-code", "codex", "grok", "opencode"]`
  (harnesses that get a **file** skill install — copy/symlink into a proprietary folder). Gemini
  is deliberately excluded because it is registry-managed.
- `src/identity.ts:58` — `HarnessCliHarness = "claude" | "codex" | "gemini" | "grok" | "opencode"`
  (CLI identity prefixes / display names).
- `src/identity.ts:406` — `HARNESS_COMMAND_MAPPING` maps process-command labels
  (`claude`, `claude-code`, `codex`, `gemini`, `grok`, `opencode`) → harness, used by ancestry walking.
- `src/instructions.ts:8` — `InstructionHarness` union includes `gemini`.
- `src/instructions.ts:95` — `HARNESS_ALIASES` (`gemini: "gemini"`, etc.).
- `src/instructions.ts:82` — `## Gemini` section inside `DEFAULT_INSTRUCTIONS_MARKDOWN`, plus the
  prose line at `src/instructions.ts:68` ("Gemini and OpenCode start with conservative local guidance...").
- `src/cli/output.ts:204` — help text enumerates `claude|codex|gemini|grok|opencode`.

### 2.2 How identity detection works (Gemini today)

- `detectHarnessSignal` (`src/identity.ts:444`) checks env markers in order: `CLAUDECODE`,
  `CODEX_MANAGED_BY_NPM`/`CODEX_THREAD_ID`, `GEMINI_CLI` (`src/identity.ts:459`), `OPENCODE`, then
  cmux launch kind. Gemini returns `{ harness: "gemini", sessionId: null, pidHint: null }` — it has
  **no env session id**, so the session id falls back to ancestry root pid/startTime
  (`resolveHarnessSessionId`, `src/identity.ts:272`).
- Ancestry detection (`detectHarnessViaAncestry`, `src/identity.ts:415`) and
  `findHarnessRootInAncestry` (`src/identity.ts:346`) rely on `HARNESS_COMMAND_MAPPING`, i.e. a
  process whose command basename is `gemini`.

### 2.3 How skill install works

`tt install <harness>` (`runInstallCommand`, `src/cli/install-commands.ts:39`) does two things per
harness: (a) install/refresh the bundled `talking-stick` skill, and (b) clean up stale MCP
registrations from older releases. `tt install` no longer **adds** MCP servers (README:164).

Skill install targets (`resolveSkillTargetPath`, `src/skill-install.ts:42`):

- `claude-code` → `~/.claude/skills/talking-stick`
- `codex` → `~/.codex/skills/talking-stick`
- `grok` → `<grok config dir>/skills/talking-stick` (default `~/.grok`)
- `opencode` → `<opencode config dir>/skills/talking-stick` (default `~/.config/opencode`, honors `XDG_CONFIG_HOME`)
- `gemini` → **special-cased** (`planSkillInstall`, `src/skill-install.ts:80-105`): runs
  `gemini skills link <src> --scope user --consent` (or `gemini skills install ...` with `--copy`).
  The on-disk location it *inspects* is `~/.gemini/skills/talking-stick`.

For the four `FILE_SKILL_HARNESSES`, `installSkillDirectory` (`src/skill-install.ts:188`) writes a
**symlink** (default) or a recursive **copy** (`--copy`) into the proprietary folder. Each harness
gets its **own physical copy/symlink**. Idempotence is via `inspectInstalledSkill`
(`src/skill-install.ts:291`): symlink → bundled source = `present`; matching copy digest = `present`.

`syncInstalledSkills` (`src/skill-install.ts:161`) silently realigns the four
`FILE_SKILL_HARNESSES` on human CLI runs (called from `runStartupMaintenance`,
`src/cli/startup-maintenance.ts:32`). Gemini is excluded from silent sync (README:176, SKILL.md:52).

### 2.4 How uninstall / stale cleanup works

- `planSkillUninstall` (`src/skill-install.ts:129`) removes the proprietary folder, or for gemini
  runs `gemini skills uninstall talking-stick --scope user`.
- `planUninstall` (`src/install.ts:274`) removes legacy MCP registrations: `claude mcp remove`,
  `codex mcp remove`, `gemini mcp remove -s user` (`src/install.ts:303`), OpenCode JSON patch.
  Grok is skipped (`src/install.ts:316`).
- `removeStaleMcpRegistrations` (`src/install-migration.ts:35`) + `runStaleMcpCleanup`
  (`src/update-migration.ts:58`) run on install, uninstall, self-update, and first-run after a
  version change. It is **strict** for OpenCode (only removes the canonical `["tt","mcp"]` shape;
  preserves hand-edited entries) and name-only for the exec harnesses
  (`src/install-migration.ts:18-26`).

### 2.5 There is no `~/.agents/skills` concept anywhere yet

`grep -rn "\.agents\|agents/skills"` across `src/ tests/ docs/ skills/ README.md` returns **nothing**.
A shared agents skills directory is entirely net-new. Likewise `antigravity`/`agy` appears nowhere.

### 2.5a Codex read-only recon (2026-06-13, `codex:b71174a5`)

Folded in from Codex's pre-review recon on this machine:

- **`agy` has no `skills` subcommand.** `agy --help` exposes `plugin import/install/link` (a plugin
  system), not `agy skills ...`. → **Do not** model Antigravity as `gemini`-style registry-exec via a
  fake `agy skills`. Antigravity skills are file-based via `~/.agents/skills`. (If a plugin-based path
  is ever wanted, it would be `agy plugin`, but file-based shared install is the primary route.)
- **Official Antigravity migration guidance:** workspace `.gemini/skills` should move/rename to
  `.agents/skills`. This confirms `.agents/skills` as the convergent convention (project scope; the
  user-scope analogue is `~/.agents/skills`).
- **Live duplication evidence on this machine:** `~/.agents/skills` exists but has **no** talking-stick
  entry; meanwhile `talking-stick` is currently linked into `~/.claude`, `~/.codex`, `~/.gemini`,
  `~/.grok`, **and** `~/.opencode`. Separately, **both** `~/.opencode/skills` and
  `~/.config/opencode/skills` exist — note our code targets only `~/.config/opencode`
  (`resolveOpencodeConfigDirFromResolved`, `src/install.ts:241`), so an `~/.opencode/skills` copy is
  either user-created or from another tool. This is concrete evidence that multi-location skill state
  already exists and will duplicate once a harness reads both shared and proprietary.
- **Codex design steer:** make the shared `agents` target **first-class**, and keep harness-specific
  targets only where needed — Claude Code (`~/.claude/skills`, if it does not read `~/.agents/skills`)
  and harness-only extras like the Grok session hook. Antigravity identity from `ANTIGRAVITY_AGENT`
  plus conversation/trajectory IDs and ancestry label `agy`. Recorded as the leading **D1** option
  in §8.

### 2.6 Key existing invariant we must preserve

The bundled `SKILL.md` **self-gates**: its `description` says to use it only when the workspace
coordinates with Talking Stick or contains a `.talking-stick/` marker (`skills/talking-stick/SKILL.md:3`,
lines 16-22). This matters: installing into a **broadly shared** `~/.agents/skills` means every agent
reading that directory will see the skill. Because the skill self-gates, a broad install is acceptable
and does not force coordination behavior onto unrelated repos.

## 3. Problem statement (the duplication bug we are preventing)

If a harness loads skills from **both** a shared `~/.agents/skills/talking-stick` **and** its
proprietary `~/.<harness>/skills/talking-stick`, and `tt install` writes both, the agent sees the
`talking-stick` skill **twice**. Consequences:

- Two skill entries with the same name → ambiguous/duplicated tool surface.
- If one location is stale (older bundled version) and the other fresh, the agent may load
  conflicting instructions depending on the harness's precedence rules (which are undefined / vary).
- Silent sync (`syncInstalledSkills`) keeps re-asserting the proprietary copy, so the duplicate
  never self-heals.

Today this does not bite because (as far as the current code assumes) each file harness reads only
its own proprietary folder. The moment a harness (Antigravity is the immediate case; possibly Codex
or others later) also reads `~/.agents/skills`, the duplication appears. We want to ship the model
that prevents it **before** Antigravity lands, and clean up any duplicates older `tt` versions created.

## 4. Proposed design

### 4.1 Introduce a single harness capability registry

Create one authoritative table describing each harness's skill-loading model and config locations,
and derive the scattered lists from it. Proposed location: `src/harness-registry.ts` (new), or extend
`src/install.ts`. Shape (illustrative, not final):

```ts
type SkillLoadingModel =
  | { kind: "shared" }                 // reads ~/.agents/skills only
  | { kind: "proprietary" }            // reads ~/.<harness>/skills only
  | { kind: "shared+proprietary" }     // reads both -> install ONCE (prefer shared)
  | { kind: "registry-exec" };         // managed by the harness's own `skills` CLI (legacy gemini)

interface HarnessSpec {
  installId: HarnessId;            // e.g. "antigravity"
  identityName: HarnessCliHarness; // e.g. "antigravity"
  commandLabels: string[];         // process basenames -> e.g. ["agy", "antigravity"]
  envDetect: (env) => HarnessSignal | null;
  configDir: (resolved) => string; // proprietary config dir (may be unused for shared-only)
  skill: SkillLoadingModel;
  mcpCleanup: "none" | "exec" | "opencode-json";
  deprecated?: boolean;
}
```

The registry becomes the single source of truth. `SUPPORTED_HARNESSES`, `FILE_SKILL_HARNESSES`,
`HARNESS_COMMAND_MAPPING`, `HarnessCliHarness`, and the instruction aliases are derived from it (or at
minimum cross-checked by a test that fails if they drift). This directly mitigates the "enumeration
duplicated across modules" fragility from §2.1 and makes the Antigravity addition and any future
correction to a harness's skill model a one-line change.

> Scope control for the reviewer: a full registry refactor may be larger than the operator wants in
> one PR. A lighter alternative is to add `antigravity` to the existing lists and add a small
> `SKILL_LOADING_MODEL: Record<HarnessId, SkillLoadingModel>` map plus a shared-dir resolver, deferring
> the broader registry consolidation. Flagged as decision **D1** in §8.

### 4.2 Shared agents skills directory resolver

Add `resolveSharedAgentsSkillsDir(options)` returning `path.join(homeDir, ".agents", "skills")` by
default. Keep it override-aware (e.g. an `AGENTS_DIR`/`AGENTS_HOME` env var) **only if** such a
convention is confirmed — otherwise hardcode `~/.agents/skills` and leave a TODO. The skill target
becomes `<shared>/talking-stick`. (Verification needed — open question **Q2**.)

### 4.3 Install algorithm: one physical install per location, with dedup

`runInstallCommand` / `planInstallActionsForHarness` change from "one skill action per harness" to:

1. Resolve the target harness set (explicit args or `--all` detected).
2. For each harness, look up its `SkillLoadingModel`:
   - `shared` or `shared+proprietary` → contributes a skill install at `<shared>/talking-stick`.
   - `proprietary` → contributes a skill install at `~/.<harness>/skills/talking-stick`.
   - `registry-exec` (legacy gemini) → no new install (deprecated; see §4.6).
3. **Deduplicate skill actions by absolute target path** so that, e.g., `tt install --all` with two
   shared-reading harnesses writes `~/.agents/skills/talking-stick` exactly once and reports it once.
   (Today actions run via `Promise.all`, `src/cli/install-commands.ts:57-61`; two parallel writes to
   the same path are individually idempotent but race on the `removeInstalledSkill`→`symlink` window
   in `installSkillDirectory`, `src/skill-install.ts:200-212`. Dedup removes the race and the
   double-report.)
4. For `shared+proprietary` harnesses, also enqueue a **proprietary-copy cleanup** action (see §4.5)
   so the redundant `~/.<harness>/skills/talking-stick` is removed once the shared install exists.

The skill action itself (symlink-or-copy, idempotent inspect) is unchanged; only the **set and
location** of actions changes. Reuse `installSkillDirectory`/`inspectInstalledSkill` for the shared
target — they are already path-agnostic.

### 4.4 Antigravity specifics

- **Detection** (`detectHarnessSignal`, `src/identity.ts:444`): add, ordered before/after Gemini:
  ```ts
  if (env.ANTIGRAVITY_AGENT === "1" ||
      nonEmpty(env.ANTIGRAVITY_CONVERSATION_ID) ||
      nonEmpty(env.ANTIGRAVITY_TRAJECTORY_ID)) {
    return {
      harness: "antigravity",
      sessionId: nonEmpty(env.ANTIGRAVITY_CONVERSATION_ID) ?? nonEmpty(env.ANTIGRAVITY_TRAJECTORY_ID),
      pidHint: null
    };
  }
  ```
  Recommend `ANTIGRAVITY_CONVERSATION_ID` as the primary session anchor (stable per conversation);
  `ANTIGRAVITY_TRAJECTORY_ID` is likely finer-grained (per turn/sub-task) and would fragment identity
  if used as the anchor. Decision **D2** / open question **Q3**.
- **Command mapping** (`HARNESS_COMMAND_MAPPING`, `src/identity.ts:406`): add `agy → antigravity` and
  `antigravity → antigravity` so ancestry detection works when env markers are absent (consistent with
  how Grok is detected by ancestry).
- **Identity prefix / display name**: recommend `antigravity` (matches the env-marker family and reads
  clearly in `agent_id`s like `antigravity:ab12cd34`). The binary stays `agy`. Decision **D2**.
- **Skill loading model**: `shared` (reads `~/.agents/skills`). **Confirmed file-based** by Codex
  recon (§2.5a): `agy` has no `skills` subcommand, and Antigravity migration guidance routes skills to
  `.agents/skills`. Install target therefore `~/.agents/skills/talking-stick`, file copy/symlink —
  **not** an exec. (A plugin path `agy plugin import/install/link` exists but is not the route here.)
  Still verify *which other* harnesses share that dir (open question **Q1**).
- **MCP cleanup**: `none` (like Grok). `agy` has no `mcp`/`skills` registry surface we use, and `tt`
  no longer adds MCP servers.
- **`detectHarness`** (`src/install.ts:532`, used by `--all`): add an `antigravity` branch. Use
  `which agy` as the **strong** presence signal. Do **not** key presence on `~/.agents/skills` alone —
  it is shared and may exist for unrelated reasons (it already exists empty on this machine, §2.5a), so
  it would over-claim Antigravity under `--all`. Antigravity has no confirmed proprietary config dir
  (**Q4**), so absent `agy` on PATH, treat as not-detected.
- **Instruction routing**: add `antigravity`/`agy` to `HARNESS_ALIASES` (`src/instructions.ts:95`),
  add `antigravity` to `InstructionHarness`, add a `## Antigravity` section to
  `DEFAULT_INSTRUCTIONS_MARKDOWN`, and update the prose line at `src/instructions.ts:68`.

### 4.5 Migration / cleanup of existing installs

Three classes of existing state to handle on `tt install`, `tt uninstall`, `tt self-update`, and
first-run-after-version-change (reuse the `runStaleMcpCleanup` plumbing in `src/update-migration.ts`):

1. **Redundant proprietary copies for shared-reading harnesses.** When a harness's model is
   `shared`/`shared+proprietary` and a tt-managed `talking-stick` skill exists in its **proprietary**
   folder, remove the proprietary copy once the shared install exists. **Safety gate (strict, mirrors
   the OpenCode MCP cleanup philosophy):** only remove when the proprietary entry is clearly
   tt-managed — a **symlink** whose realpath resolves to the bundled skill source, OR a directory whose
   digest matches a **known-tt-bundled** digest (current or a recorded set of prior-release digests).
   A `talking-stick` directory that is neither (i.e. hand-authored or unknown) is **preserved** and
   reported, never deleted. This avoids nuking a user's own skill or a copy a still-proprietary-only
   harness genuinely needs.
   - Open question **Q5**: maintaining a set of prior-release bundled digests is the only robust way
     to recognize a *stale tt copy*. Alternative: only auto-remove **symlinks** (cheap, unambiguous)
     and leave copies to a `--prune-duplicates` opt-in. Recommend symlink-only auto-removal + opt-in
     prune for copies, to stay conservative.
2. **Gemini deprecation cleanup.** See §4.6.
3. **Audit.** Every removal appends a JSONL audit entry (extend `install-audit.ts` reasons/targets to
   cover skill-dir cleanups, not just MCP). The existing audit currently only models MCP cleanup
   (`AuditAction`, `src/install-migration.ts`); a parallel "skill cleanup" audit path or a generalized
   action enum is needed. Decision **D3**.

`syncInstalledSkills` (silent human-CLI sync) must also be updated to (a) sync the shared location for
shared-reading harnesses, and (b) **stop re-creating** proprietary copies for shared-reading harnesses
(otherwise it re-introduces the duplicate the migration just removed). This is the most important
behavioral edit in the silent path.

### 4.6 Gemini deprecation

The operator states Gemini CLI support is being deprecated/replaced by Antigravity. Proposed handling
(conservative, non-stranding):

- **Keep identity detection** for `GEMINI_CLI=1` and `gemini` ancestry so any still-running Gemini
  session keeps a stable identity and can coordinate during the transition. (Decision **D4**: fully
  drop vs keep detection. Recommend keep for now.)
- **Stop installing** the Gemini skill: `gemini` is dropped from default `--all` install targets and
  from any "install the skill" path. `tt install gemini` prints a deprecation notice and performs
  cleanup-only (see below) rather than `gemini skills link`.
- **Active cleanup on update/first-run:** best-effort `gemini skills uninstall talking-stick --scope user`
  and `gemini mcp remove -s user talking-stick`, guarded by `which gemini` / `skipMissing` so machines
  without Gemini are silent no-ops. This removes the old registry skill so it cannot duplicate the new
  Antigravity/shared skill.
- **Recognize-but-deprecate the token:** keep `gemini` accepted by `parseHarnessList` and the
  `## Gemini` alias in instruction parsing (so existing project instruction files with `## Gemini`
  sections still extract) but mark it deprecated. Replace the `## Gemini` block in the **default**
  instructions template with `## Antigravity`.
- Decision **D5**: timeline — do we remove Gemini entirely in a later release, or keep the deprecated
  shim indefinitely? Recommend: ship deprecation + cleanup now, schedule full removal for a later
  major.

### 4.7 Uninstall semantics for the shared dir

`tt uninstall` must remove only `<shared>/talking-stick`, **never** the whole `~/.agents/skills`
directory (it is shared with other tools). After removing the subdir, if `~/.agents/skills` is now
empty, leaving it is fine; do not attempt to remove the parent. Mirror the existing
`removeInstalledSkill` symlink-vs-dir handling (`src/skill-install.ts:324`).

## 5. CLI / API surface changes

- `tt install antigravity` → writes `~/.agents/skills/talking-stick` (shared model).
- `tt install --all` → dedups shared targets; one shared write covers all shared-reading harnesses.
- `tt install gemini` → deprecation notice + cleanup-only (no new skill).
- `tt uninstall antigravity` → removes `<shared>/talking-stick` only.
- Help text (`src/cli/output.ts:204`) and README enumerations updated to
  `claude|codex|antigravity|grok|opencode` with `gemini` noted as deprecated.
- New `SkillLoadingModel`/registry exports from `src/skill-install.ts` (or new module) consumed by
  `install-commands.ts`.
- (Optional) `tt install --prune-duplicates` opt-in to remove tt-managed proprietary **copies** that
  the conservative auto-cleanup leaves in place (see **Q5**).

No new MCP behavior; `tt install` still does not add MCP servers.

## 6. Tests to add / update

Existing suites that reference gemini or harness lists and will need updates:
`tests/identity.test.ts`, `tests/install.test.ts`, `tests/skill-install.test.ts`,
`tests/install-commands.test.ts`, `tests/install-migration.test.ts`, `tests/instructions.test.ts`,
`tests/cli.test.ts`, `tests/talking-stick.test.ts`, `tests/oob-substrate.test.ts`, `tests/notes.test.ts`.

New coverage:

1. **Antigravity detection** — `detectHarnessSignal` returns `antigravity` for `ANTIGRAVITY_AGENT=1`,
   for `ANTIGRAVITY_CONVERSATION_ID` only, and for `ANTIGRAVITY_TRAJECTORY_ID` only; session anchor is
   `CONVERSATION_ID` when both present; `agy` ancestry detection when env markers absent.
2. **Shared skill install** — `tt install antigravity` writes a symlink/copy at
   `<home>/.agents/skills/talking-stick`; idempotent re-run reports `already_present`.
3. **Dedup** — `tt install --all` with ≥2 shared-reading harnesses produces exactly one shared skill
   action / one report line for `~/.agents/skills/talking-stick`; no race/`ENOENT` flake.
4. **Proprietary-copy migration** — given a pre-existing tt-managed symlink at
   `~/.codex/skills/talking-stick` (only if Codex's model becomes shared+proprietary — gate on the
   verified model), migration removes it once the shared install exists; a **hand-authored** dir at the
   same path is **preserved** and reported.
5. **Gemini deprecation** — `tt install gemini` does not call `gemini skills link`; update/first-run
   issues best-effort `gemini skills uninstall` + `gemini mcp remove`; both are silent no-ops when
   `which gemini` is null (`skipMissing`).
6. **Uninstall** — `tt uninstall antigravity` removes only the `talking-stick` subdir, never the
   `~/.agents/skills` parent.
7. **Instructions** — `## Antigravity` extracted for antigravity identity; legacy `## Gemini` sections
   still extract under the deprecated alias; `--harness antigravity` accepted; default template shows
   Antigravity not Gemini.
8. **Registry/lists in sync** — a guard test asserting the derived lists
   (`SUPPORTED_HARNESSES`, `FILE_SKILL_HARNESSES`, command mapping, instruction aliases) match the
   registry, so future drift fails loudly.

Use the existing install-test patterns: injected `homeDir`, `pathExists`, `readFile`, `writeFile`,
`run`, `which` hooks (`InstallerHooks`, `src/install.ts:29`) and `TALKING_STICK_DATA_DIR` temp dirs
(CLAUDE.md). No real `~/.agents` or `~/.gemini` writes in tests.

## 7. Docs to update

- `README.md`: harness list (line 5), "How installation works per harness" (lines 162-176), identity
  markers (lines 220), instructions `--harness` enumeration (line 193), command reference (203-204).
  Document the shared `~/.agents/skills` model, the one-install-per-location rule, and Gemini
  deprecation.
- `skills/talking-stick/SKILL.md`: description harness list (line 3) and the silent-sync note
  (line 52) — replace Gemini with Antigravity, mention shared skills directory.
- `CLAUDE.md` "Runtime & Dogfooding Notes": the identity-markers bullet and the
  `~/.claude/skills`/`~/.grok/skills` symlink bullet need an Antigravity + `~/.agents/skills` line.
- `docs/releases/<next>.md` + `CHANGELOG.md`: new entry.
- This file moves draft → converged once Codex review lands.

## 8. Decisions for reviewer (recommendations in **bold**)

- **D1 — Shared-first vs per-harness model.** Two framings of the same trim:
  - *(1a) Codex's shared-first (leading):* treat the shared `~/.agents/skills` target as first-class
    and the default for every harness that reads it; keep harness-specific skill targets only where a
    harness does **not** read shared (Claude Code is the likely holdout via `~/.claude/skills`), plus
    harness-only extras (Grok session hook). Fewest physical installs, smallest duplication surface.
  - *(1b) Per-harness model map:* each harness carries a `SkillLoadingModel`
    (`shared`/`proprietary`/`shared+proprietary`/`registry-exec`); the installer derives locations from
    it. More explicit, tolerates a messy reality where harnesses differ.
  These converge in code (1a is 1b with most harnesses set to `shared`). **Recommend implementing the
  1b map (it is the honest data model) but defaulting most harnesses to `shared` per 1a once Q1
  confirms who reads the dir.** Plus a drift-guard test. Defer a full `src/harness-registry.ts`
  consolidation unless the reviewer/operator wants the bigger refactor in this PR.
- **D2 — Antigravity identity:** prefix `antigravity` (display) with binary label `agy`. **Recommend
  `antigravity` prefix.**
- **D3 — Audit model:** generalize `install-audit` to cover skill-dir cleanup vs add a parallel skill
  audit path. **Recommend generalizing the action enum.**
- **D4 — Gemini detection:** keep vs drop. **Recommend keep detection, drop install.**
- **D5 — Gemini removal timeline:** **Recommend deprecate+cleanup now, full removal in a later major.**

## 9. Risks

1. **Unverified `~/.agents/skills` adoption (highest).** The entire trim hinges on *which* harnesses
   actually read `~/.agents/skills` today. Wrong model → either the skill is not loaded (installed only
   to shared, but harness reads only proprietary) or duplicates persist (installed to both). Mitigation:
   verify per harness (Q1), keep the model in one table, ship conservative cleanup (symlink-only
   auto-removal).
2. **Aggressive proprietary cleanup deletes user content.** A `talking-stick` dir that is not
   tt-managed could be a user's own skill. Mitigation: strict tt-managed gate (symlink→bundled, or
   known-digest), preserve-and-report otherwise — mirrors the strict OpenCode MCP-cleanup precedent.
3. **Shared-dir blast radius.** Installing into `~/.agents/skills` exposes the skill to every agent
   reading that dir, including in non-coordinating repos. Mitigated by the skill's self-gating
   description (§2.6), but worth an explicit note and operator sign-off.
4. **Uninstall over-reach.** Removing the shared parent dir would affect other tools. Mitigation:
   only ever remove the `talking-stick` subdir.
5. **Stranding a live Gemini.** Cutting Gemini detection mid-session would drop a running agent out of
   coordination. Mitigation: keep detection, only stop installing (D4).
6. **Antigravity unknowns.** Config dir, whether `agy` has `skills`/`mcp` subcommands, and the right
   session anchor are not confirmed (Q3/Q4). Wrong guesses are low-blast (detection/identity only) but
   could pick a poor session granularity.
7. **Dedup race.** Parallel `Promise.all` install of two shared-reading harnesses both hitting
   `installSkillDirectory` on the same path can `ENOENT`-flake in the remove→symlink window. Mitigation:
   dedup actions by path before running (§4.3).
8. **List drift.** Harness enumeration lives in ~7 places; missing one (e.g. `HARNESS_COMMAND_MAPPING`)
   yields silent mis-detection. Mitigation: registry + drift-guard test (§6.8).
9. **Windows.** Shared-dir symlink uses `junction` like existing installs; confirm `~/.agents` parent
   creation and junction semantics on win32 (existing code already branches, `src/skill-install.ts:206`).

## 10. Open questions (for Codex review + operator)

- **Q1 (still blocking):** Exactly which harnesses read `~/.agents/skills` today — Antigravity is
  confirmed (§2.5a); do Codex / Gemini / OpenCode / Grok also read it, and does Claude Code? This
  determines each harness's `SkillLoadingModel`, the shared-first default (D1/1a), and the migration
  set. Needs per-harness confirmation.
- **Q2 (partly resolved):** `.agents/skills` confirmed as the convention (§2.5a); the user-scope path
  is `~/.agents/skills` and it already exists on this machine. Still confirm: env override
  (`AGENTS_DIR`/`AGENTS_HOME`/XDG-style)? Nesting as `<dir>/<skill-name>/SKILL.md` like the proprietary
  folders (assumed yes)?
- **Q3:** Antigravity session anchor — `ANTIGRAVITY_CONVERSATION_ID` vs `ANTIGRAVITY_TRAJECTORY_ID`.
  What is each one's lifetime/granularity? (Recommend CONVERSATION_ID; see D2.)
- **Q4 (resolved):** `agy` has **no** `skills`/`mcp` subcommands (it has `plugin import/install/link`).
  Antigravity is file-based via `~/.agents/skills`. No confirmed proprietary config dir — so
  `detectHarness` presence keys on `which agy`, not a config dir.
- **Q5:** Proprietary-copy cleanup — auto-remove only symlinks (conservative) and gate copy removal
  behind `--prune-duplicates`, or maintain prior-release bundled digests to recognize stale tt copies?
- **Q6:** Should shared-skill install be the **default** for shared-reading harnesses, or opt-in for
  one release while we observe? (Affects rollout risk.)
- **Q7:** Gemini removal timeline (D5) and whether `--all` should auto-target Antigravity purely from
  `which agy` vs requiring an explicit token.
- **Q8 (new, from §2.5a):** OpenCode has **both** `~/.opencode/skills` and `~/.config/opencode/skills`
  on this machine, but `tt` only manages `~/.config/opencode`. Should the OpenCode model account for
  the `~/.opencode` location (read it? clean a stale tt copy there?), or is `~/.opencode/skills`
  out of scope (user/other-tool owned)? Relevant to whether OpenCode is `shared`, `proprietary`, or
  `shared+proprietary`.

## 11. Codex adversarial review (2026-06-13)

### 11.1 Verdict

The draft has the right core direction: **one install per physical skill location, with a
per-harness loading model, and no fake `agy skills` integration.** The implementation should not
start with a broad harness-registry refactor, though. Start with a narrower `SkillTargetSpec` map
that resolves install targets and duplicate-cleanup targets. A full registry can follow once the
model is proven.

The main correction is that Q1 is now partly answered by live inspection:

- **Codex** exposes both `/Users/wojtek/.codex/skills` and `/Users/wojtek/.agents/skills` in
  `codex debug prompt-input`.
- **Grok** exposes `/Users/wojtek/.grok/skills`, `/Users/wojtek/.agents/skills`, and
  `/Users/wojtek/.claude/skills` in `grok inspect --json`.
- **OpenCode** exposes `/Users/wojtek/.agents/skills`, `/Users/wojtek/.config/opencode/skills`, and
  `/Users/wojtek/.opencode/skills` in `opencode debug skill`.
- **Claude Code** is still only locally confirmed at `/Users/wojtek/.claude/skills`; no live evidence
  yet that it reads `/Users/wojtek/.agents/skills`.
- **Antigravity** docs and migration guidance point to `.agents/skills`, and `agy` has no `skills`
  subcommand. However, local state also has `/Users/wojtek/.gemini/antigravity/skills`, so the
  implementation should include a live `agy` discovery experiment before deleting any Antigravity-
  specific or Gemini-era skill copy.

### 11.2 Required changes before implementation

1. **Make the first implementation map-driven, not registry-driven.** Add a focused map like:
   `installId -> { primarySkillTarget, duplicateSkillTargets, extras, deprecated }`. Let
   `SUPPORTED_HARNESSES` remain explicit for now, backed by drift tests. This avoids turning a
   harness-path bug fix into a broad architecture change.

2. **Treat shared install as primary for Codex, Grok, OpenCode, and Antigravity only after their live
   loader is verified.** Based on local evidence, Codex/Grok/OpenCode all read `~/.agents/skills`.
   Claude should stay proprietary unless proven otherwise. Grok still needs the proprietary hook
   install at `~/.grok/hooks/talking-stick-session.json`; only the skill moves to shared.

3. **OpenCode cleanup is more urgent than the draft implies.** A stale
   `~/.opencode/skills/talking-stick` can shadow both `~/.config/opencode/skills/talking-stick` and
   `~/.agents/skills/talking-stick`. If shared becomes primary, the cleanup set for OpenCode must
   include both proprietary roots:
   `~/.opencode/skills/talking-stick` and `<XDG_CONFIG_HOME|~/.config>/opencode/skills/talking-stick`.
   Auto-remove only if the entry is a symlink to the bundled skill. Preserve copies or unknown dirs
   unless an explicit prune flag is added.

4. **Use symlink-only automatic duplicate removal for v1.** Do not maintain historical bundled
   digests in the first pass. A digest table sounds precise but becomes release-state bookkeeping
   and still cannot prove user intent. For v1, auto-remove only symlinks that resolve to the bundled
   `skills/talking-stick` source. Report copied/unknown duplicate directories as preserved.

5. **Sequence install and cleanup deterministically.** Install or verify the shared target first.
   Only then remove tt-managed proprietary duplicates. Do not run same-path or related cleanup actions
   in the existing per-harness `Promise.all` path. Dedup by real target path before execution.

6. **Keep Gemini identity, but make install behavior unmistakable.** `tt install gemini` should print
   a deprecation message that points to `tt install antigravity`, then run cleanup-only if possible.
   `tt install --all` should not select Gemini merely because `~/.gemini` exists; it should prefer
   Antigravity when `agy` is present.

7. **Do not use `~/.agents/skills` existence as harness detection.** It is a shared substrate. Use
   `which agy` for Antigravity install detection, and runtime env/ancestry for identity.

8. **Add an explicit manual/live verification checklist before coding cleanup.** The plan should require
   commands equivalent to:
   `codex debug prompt-input`, `grok inspect --json`, `opencode debug skill`, and an `agy` discovery
   check. Unit tests should not depend on those commands, but the implementation branch should record
   the observed loader paths in the final handoff.

### 11.3 Revised loading model recommendation

Initial `SkillLoadingModel` values for implementation:

- `claude-code`: `proprietary`, target `~/.claude/skills/talking-stick`.
- `codex`: `shared+proprietary`, primary `~/.agents/skills/talking-stick`, duplicate cleanup
  `~/.codex/skills/talking-stick`.
- `antigravity`: `shared`, primary `~/.agents/skills/talking-stick`; keep an open verification item
  for any `~/.gemini/antigravity/skills` compatibility path.
- `grok`: `shared+proprietary`, primary `~/.agents/skills/talking-stick`, duplicate cleanup
  `~/.grok/skills/talking-stick`, plus keep the Grok session hook install in `~/.grok/hooks`.
- `opencode`: `shared+proprietary`, primary `~/.agents/skills/talking-stick`, duplicate cleanup
  for both `~/.opencode/skills/talking-stick` and
  `<XDG_CONFIG_HOME|~/.config>/opencode/skills/talking-stick`.
- `gemini`: deprecated, identity-only plus cleanup-only.

This is intentionally conservative: it removes duplicate `talking-stick` entries while preserving
loader-specific extras and avoiding destructive cleanup of unknown copies.

### 11.4 Additional tests to add

Add or revise these specific tests beyond the draft list:

1. `tt install --all` with Codex, Grok, OpenCode, and Antigravity detected plans exactly one shared
   skill install action and no proprietary skill install actions for those harnesses.
2. OpenCode duplicate cleanup considers both legacy proprietary roots and removes only symlinks to the
   bundled source.
3. A preserved unknown proprietary duplicate is reported but does not fail install.
4. `syncInstalledSkills` updates the shared target and does not recreate proprietary duplicates for
   shared-reading harnesses.
5. `tt install gemini --print` shows cleanup/deprecation actions, not `gemini skills link`.
6. `detectHarness("antigravity")` is true only from `agy` on PATH or an explicit Antigravity config
   signal if later discovered, not from `~/.agents/skills`.

### 11.5 Convergence questions for Claude/operator

1. Should `tt install --all` install `~/.agents/skills/talking-stick` when only Codex/Grok/OpenCode are
   detected but `agy` is not installed? Codex says yes if any shared-reading harness is detected,
   because shared is now their primary target.
2. Should `tt uninstall codex` remove shared `~/.agents/skills/talking-stick` if Grok/OpenCode also
   use it? Codex says no: uninstall must be target-aware. Removing the shared skill should happen only
   when uninstalling the last selected shared-reading harness or via an explicit `tt uninstall agents`
   style target. This needs a concrete CLI rule before implementation.
3. Is symlink-only duplicate pruning enough for this release? Codex says yes; copied unknown dirs can be
   reported with a next command or manual path.

## 12. Convergence (Claude, 2026-06-13) — AUTHORITATIVE

This section supersedes the recommendations in §8/§10/§11 where they differ. Codex's review (§11) is
accepted almost entirely. Two new pieces of independent verification close the last gaps.

### 12.1 New verification done this pass (Claude, `claude:529d0454`)

- **`agy` has no `skills`/`mcp` surface — re-confirmed locally.** `agy --help` subcommands are exactly:
  `changelog`, `help`, `install`, `models`, `plugin`/`plugins`, `update`. No `skills`, no `mcp`.
  → Antigravity is file-based via `~/.agents/skills`; presence detection keys on `which agy`. **Q4 closed.**
- **Claude Code does NOT read `~/.agents/skills` — authoritatively confirmed.** Per official docs
  (https://code.claude.com/docs/en/skills.md#where-skills-live), Claude Code's only skill discovery
  locations are `~/.claude/skills/` (personal), `.claude/skills/` (project), plugin-bundled skills, and
  `--add-dir` `.claude/skills` subdirs. There is **no** `~/.agents/skills` support. → Installing into
  the shared dir cannot create a duplicate for Claude. **Claude Code stays `proprietary`. Q1 closed for Claude.**
- **All current proprietary installs are symlinks to the bundled source.** Verified `talking-stick` is a
  symlink (not a copy) in `~/.claude`, `~/.codex`, `~/.grok`, `~/.opencode`, `~/.config/opencode`, and
  `~/.gemini`, every one resolving to `dev/ai/talking-stick/skills/talking-stick`. → The conservative
  **symlink-only auto-prune fully covers the real migration set on this machine** (no copies to leave behind).
- `~/.agents/skills` exists and is populated by *other* tools (agent-browser, clawdapus-cli, cmux-browser,
  mcporter, microsoft-foundry, openclaw-cli-reference) but has **no** talking-stick entry yet — confirms
  the shared dir is a real shared substrate (do not treat its existence as Antigravity detection; **Q8/D-detect**).
- Note: `~/.gemini/antigravity/skills` was **not** present on re-check (only `~/.gemini/skills/talking-stick`
  symlink exists). The Antigravity-compat verification item from §11.1 stays as a live implementation check
  but there is no `~/.gemini/antigravity` copy to migrate here today.

### 12.2 Decisions — resolved

- **D1 — model shape:** Implement the **map-driven `SkillLoadingModel`** (§11.2.1), *not* a broad
  `src/harness-registry.ts` refactor in this PR. A focused
  `Record<HarnessId, { model, primaryTarget, duplicateTargets[], extras[], deprecated }>` plus a
  **drift-guard test** that asserts the existing scattered lists agree with it. Full registry
  consolidation is explicitly deferred to a later PR.
- **D2 — Antigravity identity:** prefix/display = **`antigravity`**, binary/command label = **`agy`**
  (also map `antigravity` as a command label). Session anchor = **`ANTIGRAVITY_CONVERSATION_ID`**, falling
  back to `ANTIGRAVITY_TRAJECTORY_ID`, then ancestry. **Q3 resolved** this way; trajectory is presumed
  finer-grained and would fragment identity.
- **D3 — audit:** **generalize** the `install-audit`/`AuditAction` enum to cover skill-dir cleanup
  (reasons: `skill_duplicate_symlink`, `gemini_deprecated_skill`, plus the existing MCP reasons), so every
  skill removal is journaled the same way MCP cleanups already are.
- **D4 — Gemini detection:** **keep** identity detection (`GEMINI_CLI=1` + `gemini` ancestry); **drop**
  the install. `tt install gemini` becomes deprecation-notice + cleanup-only.
- **D5 — Gemini removal timeline:** ship **deprecate + cleanup now**; schedule full identity/token removal
  for a later major. Keep `gemini` accepted by `parseHarnessList` and the `## Gemini` instruction alias
  (so existing project instruction files still extract), but replace `## Gemini` in the **default** template
  with `## Antigravity`.
- **D6 (new) — shared install is default, not opt-in (Q6).** Shared-reading harnesses install to
  `~/.agents/skills/talking-stick` immediately on ship. Low risk because (a) the bundled `SKILL.md`
  self-gates (§2.6) so a broad install does not force behavior, and (b) we clean the duplicates in the
  same release. No staged opt-in.

### 12.3 Final per-harness loading model (authoritative)

| installId    | identity   | command labels         | model               | primary target                       | duplicate-cleanup targets (symlink-only auto-prune)                                   | extras / notes |
|--------------|------------|------------------------|---------------------|--------------------------------------|---------------------------------------------------------------------------------------|----------------|
| claude-code  | claude     | claude, claude-code    | `proprietary`       | `~/.claude/skills/talking-stick`     | —                                                                                     | docs-confirmed: does not read shared |
| codex        | codex      | codex                  | `shared+proprietary`| `~/.agents/skills/talking-stick`     | `~/.codex/skills/talking-stick`                                                        | |
| antigravity  | antigravity| agy, antigravity       | `shared`            | `~/.agents/skills/talking-stick`     | —                                                                                     | presence = `which agy`; identity env above; live-verify any `~/.gemini/antigravity` compat path |
| grok         | grok       | grok                   | `shared+proprietary`| `~/.agents/skills/talking-stick`     | `~/.grok/skills/talking-stick`                                                         | **keep** Grok session hook at `~/.grok/hooks/talking-stick-session.json` (extra, not pruned) |
| opencode     | opencode   | opencode               | `shared+proprietary`| `~/.agents/skills/talking-stick`     | `~/.opencode/skills/talking-stick` **and** `<XDG_CONFIG_HOME|~/.config>/opencode/skills/talking-stick` | both legacy roots cleaned |
| gemini       | gemini     | gemini                 | `deprecated`        | — (no install)                       | `~/.gemini/skills/talking-stick` (symlink) + best-effort `gemini skills uninstall` / `gemini mcp remove` | identity kept; install cleanup-only |

Shared resolver: `resolveSharedAgentsSkillsDir(opts) = path.join(homeDir, ".agents", "skills")`, using the
same injectable `homeDir` hook the other resolvers use. **No new env override** (Q2): derive from `homeDir`;
revisit only if an `AGENTS_DIR` convention is later confirmed. Skill nests as `<shared>/talking-stick/SKILL.md`,
matching the proprietary layout.

### 12.4 Codex's three convergence questions — answered

1. **`tt install --all` with Codex/Grok/OpenCode detected but `agy` absent → still write shared?**
   **YES.** `~/.agents/skills/talking-stick` is the *primary* target for those harnesses, independent of
   Antigravity. `--all` writes the shared skill once whenever ≥1 shared-reading harness is detected.
   Antigravity detection (`which agy`) only adds nothing extra (same shared target, deduped).

2. **Does `tt uninstall codex` remove the shared skill when Grok/OpenCode also use it?**
   **NO — shared removal is explicit, never a side effect of a single harness uninstall.** Concrete rule:
   - `tt uninstall <single shared+proprietary harness>` (codex|grok|opencode) removes **only** that
     harness's own targets: its proprietary duplicate(s) and its extras (e.g. Grok hook). It **leaves the
     shared skill in place** and prints: *"Left ~/.agents/skills/talking-stick (shared with other agents).
     Run `tt uninstall --all` or `tt uninstall antigravity` to remove the shared skill."*
   - The shared `~/.agents/skills/talking-stick` is removed **iff** the uninstall target set is `--all`,
     **or** includes `antigravity` (shared-only → its uninstall *is* the shared removal), **or** an explicit
     future `agents` pseudo-target. Rejected: reference-counting by "detected" harnesses (fragile, depends
     on transient PATH/config state). Deterministic-by-target-set is the rule.
   - Uninstall **never** removes the `~/.agents/skills` parent, only the `talking-stick` subdir (§4.7).

3. **Is symlink-only duplicate pruning enough for v1?**
   **YES.** Confirmed by §12.1: every existing install is a symlink, so symlink-only auto-prune covers the
   entire real migration set. Copied/unknown `talking-stick` dirs are **preserved and reported**, not
   deleted; a `--prune-duplicates` opt-in for copies is deferred (only build it if a real copy appears).

### 12.5 Implementation build sequence (for the post-compaction execution turn)

Ordered so each step is independently testable and the cleanup never runs before the shared install exists:

1. **Model map + resolver.** Add `SkillLoadingModel` + the per-harness map (§12.3) and
   `resolveSharedAgentsSkillsDir`. Add the **drift-guard test** asserting `SUPPORTED_HARNESSES`,
   `FILE_SKILL_HARNESSES`, `HARNESS_COMMAND_MAPPING`, `HarnessCliHarness`, instruction aliases agree with it.
2. **Antigravity identity.** `detectHarnessSignal` env branch (CONVERSATION_ID anchor → TRAJECTORY_ID →
   ancestry), `HARNESS_COMMAND_MAPPING` (`agy`,`antigravity` → antigravity), `HarnessCliHarness` union,
   `detectHarness` (`which agy`). Tests per §6.1 + §11.4.6.
3. **Install planning rewrite.** `planInstallActionsForHarness` derives target(s) from the model; dedup
   actions by absolute real path **before** the `Promise.all` run (kills the remove→symlink race, §4.3/§11.2.5).
   Shared-reading harnesses → shared primary install + enqueue proprietary-dup cleanup actions (ordered
   *after* the shared install/verify).
4. **Duplicate cleanup (symlink-only).** New action that removes a proprietary `talking-stick` **iff** it is
   a symlink resolving to the bundled source; else preserve + report. Journal via the generalized audit (D3).
   Wire into install, uninstall, self-update, first-run-after-version-change (reuse `update-migration.ts`).
5. **`syncInstalledSkills` update.** Sync the **shared** target for shared-reading harnesses and **stop
   recreating** their proprietary copies (else silent sync re-introduces the duplicate). Most important
   silent-path edit (§4.5). Test §11.4.4.
6. **Gemini deprecation.** `tt install gemini` → deprecation notice + cleanup-only; drop from `--all`
   install set; best-effort `gemini skills uninstall` + `gemini mcp remove` guarded by `which gemini`.
   Keep detection + token + `## Gemini` parse alias. Tests §6.5 / §11.4.5.
7. **Uninstall target-awareness.** Implement the §13.2 Option B rule (operator-confirmed): single-harness
   uninstall — **including `antigravity`** — leaves the shared skill and prints the explicit-removal hint;
   shared `~/.agents/skills/talking-stick` is removed **iff** target set is `--all` **or** the explicit
   pseudo-target `tt uninstall agents` (== `--shared`); never remove the parent dir. Test §6.6.
8. **Instructions + docs.** `## Antigravity` in default template (replacing `## Gemini`), `InstructionHarness`
   + aliases, help text `claude|codex|antigravity|grok|opencode` (gemini deprecated), README §"How
   installation works per harness", SKILL.md harness list + silent-sync note, CLAUDE.md dogfooding notes,
   CHANGELOG + `docs/releases/<next>.md`.
9. **Full suite + typecheck + build + dist smoke + real `tt install --all` dogfood**, then release.

Risk register (§9) and the strict tt-managed safety gate (§4.5/§11.2.3-4) remain in force. No remaining
blocking open questions — Q1, Q3, Q4, Q6, Q8 resolved above; Q5/Q7 resolved as symlink-only + later-major.

## 13. Second-pass convergence review (Claude `claude:b6de450a`, 2026-06-13)

Independent review of Codex's §11 and the first convergence pass (§12). §12 is accepted as
authoritative; this pass confirms one of Codex's three convergence questions, refines a second, and
pins down the third. Net: the design stands; **one CLI-contract refinement (§13.2) needs operator
confirmation** before §12.5 step 7. No code changes this turn.

### 13.1 Symlink-only duplicate pruning (Codex Q3 / §12.4.3) — AGREE

Confirmed. §12.1's live check (every current install is a symlink resolving to the bundled source)
means symlink-only auto-prune covers the entire real migration set; copies/unknown dirs are
preserved-and-reported, and a `--prune-duplicates` opt-in for copies is correctly deferred until a
real copy appears. No digest table for v1. Nothing to add.

### 13.2 Shared uninstall semantics (Codex Q2 / §12.4.2) — AGREE on the principle, DISAGREE on one clause

> **RESOLVED 2026-06-13 (operator): Option B.** `tt uninstall antigravity` (like every single-harness
> uninstall) **leaves** the shared `~/.agents/skills/talking-stick` and prints the explicit-removal hint.
> The shared skill is removed **only** by `tt uninstall --all` or the new explicit pseudo-target
> `tt uninstall agents` (== `--shared`). The "or includes antigravity" clause from §12.4.2 is **dropped**.
> This is the authoritative contract for §12.5 step 7; the discussion below is the rationale.

The principle in §12.4.2 is right: shared removal must be **explicit** and never a side effect of a
single-harness uninstall, and reference-counting by "detected" harnesses is correctly rejected as
fragile. **But the clause "shared is removed iff the target set ... includes `antigravity`"
reintroduces exactly the side effect the rule forbids.**

Why it breaks: after migration (§12.3) Codex, Grok, and OpenCode have their proprietary copies pruned
and read `talking-stick` **only** from `~/.agents/skills/talking-stick`. Antigravity is `shared` —
the same single location. So `tt uninstall antigravity` removing the shared skill silently strips
`talking-stick` from Codex, Grok, and OpenCode as well: a destructive cross-harness side effect, no
different in kind from `tt uninstall codex` nuking the shared dir, which §12.4.2 rightly forbids.

**Proposed resolution (stays within "deterministic by target set, no reference counting"):**

- Shared `~/.agents/skills/talking-stick` is removed **iff** the target set is `--all` **or** an
  explicit shared pseudo-target (`tt uninstall agents`, equivalently `--shared`). Promote that
  pseudo-target from "future" (§12.4.2) to the **v1** mechanism.
- **Drop the `or includes antigravity` clause.** `tt uninstall antigravity` behaves like the other
  single-harness uninstalls: it removes only Antigravity's own extras (none today) and **leaves** the
  shared skill in place, printing the same message — *"Left ~/.agents/skills/talking-stick (shared
  with other agents). Run `tt uninstall --all` or `tt uninstall agents` to remove the shared skill."*
- Rationale: Antigravity reads only the shared dir, so "uninstall `talking-stick` for just
  Antigravity" is not physically separable from the other shared-readers. The honest behavior is to
  refuse the silent shared deletion and name the explicit command. Least-surprise and least-harm both
  favor this.
- **Operator confirmation requested:** this changes a user-facing *destructive* command contract
  (whether `tt uninstall antigravity` ever removes the shared skill). Resolve at/before §12.5 step 7.
- If the operator prefers §12's original clause instead, it must be guarded: `tt uninstall antigravity`
  would have to refuse/warn while any other shared-reading harness is still installed — which is the
  reference-counting we are avoiding. Option B above is the cleaner contract.

### 13.3 Exact live `agy` discovery before cleanup (Codex §11.1 / §11.2.8) — CALL OUT + pin procedure

§12 keeps the live `agy` check as an implementation-time item but never specifies the *method*,
because (Q4, re-confirmed) `agy` has **no** `skills`/`mcp` introspection subcommand. Unlike
`codex debug prompt-input`, `grok inspect --json`, and `opencode debug skill`, there is no documented
`agy` command that prints its skill-loader paths — so "discover what `agy` reads" is not yet a known
command. Pin the procedure as:

1. **Re-confirm no CLI surface:** `agy --help`, `agy plugin --help`, `agy changelog` (Q4 re-check at
   implementation time).
2. **Empirical loader probe:** create a unique sentinel skill at
   `~/.agents/skills/tt-probe-<rand>/SKILL.md`, start an `agy` session, confirm `agy` surfaces/loads
   the sentinel, then delete it. This is the concrete evidence that `agy` reads `~/.agents/skills` —
   required **before** treating an install there as effective for Antigravity.
3. **Gemini-era compat:** only if `~/.gemini/antigravity/skills` (or any `~/.gemini/antigravity` skill
   path) exists at implementation time, repeat the probe there before deleting any `talking-stick`
   entry — migrate-then-remove if read, treat as stale if not. Not present on this machine today
   (§12.1), so there is **no** Antigravity cleanup to gate in v1.
4. **Record** observed loader paths in the implementation handoff (per §11.2.8).

Scope note: because Antigravity's duplicate-cleanup target set is empty (§12.3), the `agy`-discovery
gate is really a **pre-install** verification ("does `agy` read `~/.agents/skills`?") plus a defensive
guard on the hypothetical `~/.gemini/antigravity` copy — not a gate on any deletion that exists today.

### 13.4 Status after this pass

Design converged. §12 stands; §13.2 is the single refinement requiring operator confirmation
(the `tt uninstall antigravity` → shared-removal contract), to be settled at/before §12.5 step 7.
§13.3 pins the `agy`-discovery procedure for the implementation turn. Everything else in §12 —
the map-driven model (D1), Antigravity identity (D2), audit generalization (D3), Gemini
deprecate-keep-detection (D4/D5), shared-default (D6), the per-harness table (§12.3), and the
build sequence (§12.5) — is accepted as-is.
