# v6 converged design — harness instructions

> **Status:** converged claude + codex design.
>
> **Convergence path:** independent drafts written in parallel, then debated
> by cross-reference. Outcomes: claude conceded load-mechanism (separate
> `tt instructions show` call, not piggyback on `tt join`); codex conceded
> file-structure (single file per layer, not per-harness) and materialization
> (lazy on edit, never on install). Naming, CLI surface, project-file scope,
> and bundled-skill scope were already aligned.
>
> The pre-debate drafts (`v6-claude.md`, `v6-codex.md`) were deleted after
> convergence per Wojtek: "if they write something they need to delete the
> pre-debate versions after convergence."

## Problem

v5 collapsed the phase guidance into bundled `SKILL.md`. Wojtek's pushback:
*"The skill ships with the binary, which means people won't be able to edit. I
want them to be able to edit, but I still want it to be simple."* `tt install`
links the bundled skill by default and startup sync can refresh copied
installs — there is no durable user-edit affordance.

v6 fixes this with editable Markdown instructions, seeded lazily, opened with
`$EDITOR`. Not JSON profiles. Not a config subsystem.

## Shape

Two layers of concern, kept separate by design:

### 1. Bundled skill floor (`skills/talking-stick/SKILL.md`)

Immutable, package-owned. Covers join, wait, guardian checks, release/handoff,
event-wake safety, takeover, notes, messages, and the "keep using the stick
until done" rule. Tells agents how to load the editable collaboration
instructions. **Does not include phase vocabulary or typical fits** — those
live in the editable layer with bundled defaults as fallback inside the
instructions code path, not duplicated into the safety contract.

### 2. Editable collaboration instructions

Single Markdown file per layer, with optional per-harness sections inside:

```
~/.local/share/talking-stick/instructions.md      # user override (optional, XDG-aware)
<repo>/.talking-stick/instructions.md             # project override (optional)
```

Bundled defaults live as text constants in `src/instructions.ts` — they are
the seed text and the always-available fallback if no editable file exists.

The file uses `## <Harness>` section headers. The effective text for a given
harness is: shared preamble (everything before the first `##`) + the matching
harness section.

## Effective-text resolution

Additive concatenation in layer order: bundled → user → project. Later layers
add or override by plain language; the model weighs the concatenated text. No
merge semantics, no structured fields, no precedence rules beyond "later text
typically wins by recency." Bundled safety floor (the SKILL.md content)
remains higher than editable content always — operators cannot use
instructions to override the coordination safety contract.

## Loading

Agents call `tt instructions show --json` once after `tt join` on the first
substantial task in a room. The command infers the caller's harness from
identity detection (no `--harness` flag needed). The JSON result includes the
effective Markdown text and the file paths that contributed to it.

If the command fails, agents continue with the bundled `SKILL.md` guidance
alone. Coordination must never depend on instructions loading successfully.

`tt join` returns membership/coordination state only; instructions are
deliberately separate.

## CLI surface

```
tt instructions show   [--harness <name>] [--scope effective|user|project|bundled] [--json]
tt instructions edit   [--user|--project]
tt instructions reset  [--user|--project]
```

- `show` defaults to `--scope effective` and the detected current harness.
- `edit` opens `$VISUAL`, then `$EDITOR`, then a platform default if available;
  prints the file path if no editor is found. Defaults to `--user`.
- `edit` materializes the seed text on first use, then opens the editor.
  Subsequent edits open the existing file in place.
- `reset` requires explicit scope (no implicit `--user`); deletes the file at
  the chosen scope so the layer below wins again.

**Cut from both drafts:** `set`/`append`/`init`/`diff`. Editor-only for v1.
Agents holding the stick can write to `<repo>/.talking-stick/instructions.md`
directly via filesystem.

## Materialization

Lazy on first `tt instructions edit`, never on `tt install`. Reasoning:
- Operators who never customize stay on shipped defaults forever — package
  updates flow through automatically with no stale local copies.
- Operators who customize get a one-time materialization at the moment they
  show intent (running `edit`).
- `tt install` stays fast and scriptable; no extra files written.

`tt install` final output gains one hint:

```
Customize collaboration instructions with: tt instructions edit
```

No interactive prompt.

## Bundled defaults (content)

Text constants in `src/instructions.ts`. Short. Cover:

- the "keep using Talking Stick until the shared task is done" rule,
  including "prefer continued action unless the task is complete or the
  operator explicitly redirects/stops",
- the phase vocabulary: draft, adversarial review, convergence,
  implementation, implementation review, test review, release,
- typical fits (advisory, not enforced):
  - Claude: prose, first-pass synthesis, tool-running, implementation review,
    test review.
  - Codex: adversarial review, convergence, implementation, edge cases,
    release mechanics after operator approval.
  - Gemini/OpenCode: conservative starter guidance until dogfood gives
    evidence.

These are defaults, not a scheduler. Talking Stick does not auto-route turns
based on them.

## Parallel drafting without workspace clutter

Wojtek's target default is independent read-only planning first, then debate
until convergence. His concern was not the independent thinking; it was
workspace clutter and imposed file structure: *"I'm not sure I want to default
to the models writing drafts or imposing a file structure on the workspace. I
guess maybe if they write something they need to delete the pre-debate versions
after convergence."*

So the default is **read-only independent drafts**, not repo draft files.
Rules when this happens:

- **Drafts go in handoff `status` text or room notes by default**, not in
  workspace files. Coordination channels are the natural place for read-only
  position exchange.
- **If files are unavoidable** (drafts too long for handoffs/notes), use
  files in `docs/plans/` with clear `*-<harness>-draft.md` naming, and
  **delete them after convergence**. Only the converged artifact remains.
- Single-agent rooms and tiny tasks can skip parallel drafting.
- The default for larger multi-agent planning is: draft independently, debate,
  converge, then write only the converged artifact if a workspace file is
  useful.

This is still prompt guidance, not protocol. Talking Stick does not create
draft files, track phases, or auto-route turns based on this pattern.

## What we explicitly do not build

- No JSON config, no schema, no validator beyond a soft size cap on read.
- No structured merge semantics. Plain Markdown concatenation.
- No `set`/`append`/`init`/`diff` commands.
- No materialization on install.
- No phase tracking in the protocol. No `tt phase set`. No `phase` field in
  handoff types.
- No `tt state` rendering changes.
- No model overlays.
- No auto-routing by harness.
- No instruction-text override of the bundled safety floor.

## Implementation order

1. `src/instructions.ts` — bundled default text constants, layer resolver
   (bundled → user → project, additive concatenation), XDG-aware path
   resolution, `## <Harness>` section parser, soft size cap.
2. Add `tt instructions show` (CLI + service plumbing).
3. Add `tt instructions edit` with `$VISUAL` / `$EDITOR` / platform fallback.
   Materializes seed on first use.
4. Add `tt instructions reset`.
5. Edit bundled `SKILL.md`: keep current safety contract, add one short line
   pointing agents at `tt instructions show --json` after first `tt join`.
6. Update `tt install` final output with the customize hint.
7. Tests: `tests/instructions.test.ts` for layer resolution, missing files,
   materialization-only-on-edit, section parsing, additive concatenation,
   bundled-fallback when commands fail. Extend `tests/cli.test.ts` for the
   new commands.
8. README: replace `tt install-skill` references with `tt install`; add a
   short paragraph on `tt instructions edit` for customization.
9. Release notes entry.

## Acceptance criteria

- A fresh user can install with `npm i -g talking-stick && tt install --all`
  and get useful defaults without answering prompts.
- The same user can run `tt instructions edit` and customize collaboration
  behavior in `$EDITOR`.
- A package update never overwrites the user's instruction file.
- An agent runs one command after join (`tt instructions show --json`) and
  receives effective instruction text + source paths.
- If instruction loading fails, the bundled `SKILL.md` still gives enough
  guidance to coordinate safely (agents will lack phase vocabulary but
  coordination/safety remains intact).
- No new protocol state, no role enforcement, and no auto-routing are added.

## Process notes (meta)

This convergence used parallel-drafting one-off. Each harness wrote an
independent v6 draft without reading the other's first. Both landed near
the same shape but differed on three points (file structure, load
mechanism, materialization). Reading both drafts side by side made the
real trade-offs visible quickly; concessions went both ways within one
round.

The pre-debate draft files were deleted after convergence per Wojtek. The
parallel-drafting workflow is captured above as an *optional* operator-
driven pattern, not a shipped default — to avoid imposing file structure
on workspaces by default.
