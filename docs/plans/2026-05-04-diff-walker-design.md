# Diff Walker Design — Live Radiologist UX for Agent Edits

**Status:** design draft, pre-implementation. Authors: claude:45688d4d, codex:d4bc2492. Operator: Wojtek.

**Inspiration:** [umputun/revdiff](https://github.com/umputun/revdiff) — keyboard-first diff navigation. We extend the model from one-shot review to a live, persistent companion process that watches a workspace while agents work in it.

## Goals

- A separate operator-facing process (`tt walk`) that displays diffs as agents make them, navigable like a radiologist scrubs a film stack — live follow by default, keys for up/down/left/right, line/block selection, enter to annotate.
- Annotations route as messages back to the agent who made the change (or, if they are no longer reachable, the current stick holder, falling back to a durable note). Every annotation is persisted before any delivery attempt.
- Resilient under noisy editor saves, rapid sequential edits, atomic rename writes, and external/manual edits. The watcher captures every stable state it observes, periodically reconciles to recover from dropped filesystem events, never claims a torn read as a real change, and never blocks the agents.
- Fresh by default. Opening `tt walk` for a folder makes that moment the new baseline and permanently scrubs prior walker-local history for that folder unless the operator explicitly asks to resume.
- Harness-neutral. v1 must work uniformly whether the agent is Claude Code, Codex CLI, Gemini, OpenCode, or a human at the keyboard. No hook integration required.
- **Scoped to human-readable source code.** The walker is for examining source diffs a human can read. Files with a known source extension get full content tracking and rendered diffs. Files with unknown extensions get hash-only tracking — the operator sees that they changed, but the walker does not store or render their bodies. Files past a hard size ceiling are not tracked at all.

## Non-goals (v1)

- Hook-driven exact attribution per tool call. Schema leaves room (see §Attribution); v2 enriches.
- Inline editing of agent code from the walker UI. The walker is read-mostly with annotation as the only mutation.
- Multi-workspace aggregation. One walker pane = one room. Operator opens multiple panes for multiple rooms.
- Long-term local diff archives. The default invocation is intentionally destructive for old walker history. Operators who need an archive must request one before the reset.
- Conflict resolution / merging. We surface what changed; we do not arbitrate.
- Replacing `git diff` for review of merged work. The walker is for the live coordination phase, not historical review.

## UX loop

```
┌──────────────────────────────┬──────────────────────────────────┐
│ Change feed (left pane)      │ Diff body (right pane)           │
│  ▸ src/service.ts +12 −3     │ @@ line 412                      │
│    codex 14:02:11 ↩          │ - throw new Error("not_found")   │
│    src/db.ts +1 −0           │ + throw new TypedError(...)      │
│    codex 14:02:09            │  …                               │
│  ▸ tests/x.test.ts +8 −0     │                                  │
│    claude 13:58:44 ✎ note    │                                  │
└──────────────────────────────┴──────────────────────────────────┘
   w/s scroll feed   a/d prev-next change   space hold pause
   m mark line       enter annotate        esc live follow
   tab toggle pane   / search              ? help
```

- The feed (left) is reverse-chronological by visible `change_seq`. Active edits appear at the top with a live cursor; resolved-and-quiet items dim.
- The diff body (right) shows the unified diff for the selected `change_seq`. `m` marks line ranges; `enter` opens the annotation modal pre-targeted at the attributed agent.
- In follow mode, the selected row automatically advances to each new completed batch after a short settle delay, so the operator can watch complete diffs appear at agent pace without chasing the feed manually.
- Any navigation key, mouse scroll, line mark, search, or annotation entry switches into review mode. Review mode preserves the current selection while new changes continue collecting above it.
- `Esc` exits annotation/search/selection state first; repeated `Esc` returns all the way to follow mode. When not editing text, `Esc` is "show me live again."
- Review mode automatically returns to follow mode after `follow_idle_timeout_ms` with no navigation or annotation activity. Holding the follow-pause key keeps review mode active; releasing it lets the idle timer resume.
- A status bar shows the current room owner, the watcher's lag (events behind real time), follow/review state, and the snapshot store size.

### Follow / review state machine

The default viewing behavior is closer to `tail -f` than to a static review list.

| State | Entry | Behavior | Exit |
|---|---|---|---|
| `follow` | initial `tt walk`, repeated `Esc`, idle timeout | after `follow_settle_delay_ms`, select the newest visible change and scroll the diff body to top | navigation, mouse scroll, search, mark, annotation entry, or hold-pause |
| `review` | navigation, mouse scroll, search, mark, annotation entry | keep current selection stable while new changes accumulate; show a "N new" indicator | repeated `Esc`, idle timeout |
| `hold` | hold the pause key, default `Space` | freeze selection and suppress idle return while key is held | key release returns to `review` and restarts idle timer |
| `compose` | annotation modal or search input | preserve draft text and selection; never auto-follow while text entry is active | `Esc` closes current layer; repeated `Esc` eventually returns to `follow` |

`follow_settle_delay_ms` defaults to 1500 ms. This avoids dragging the UI through every intermediate save event and lets a completed batch land before the viewer advances. `follow_idle_timeout_ms` defaults to 30000 ms. The idle timeout is reset by navigation, mouse movement/scroll, search, marking, or annotation edits.

## Storage model

The watcher's data lives **outside the repository**.

**Default location:** `${TALKING_STICK_DATA_DIR:-$XDG_DATA_HOME/talking-stick}/watch/workspaces/<workspace_key>/` — sqlite at `watch.sqlite`, blobs in `blobs/<sha256-prefix>/<sha256>`, projection cache at `projection.git/`, and a small `manifest.json`. A separate non-resettable registry lives at `${...}/watch/registry.sqlite`.

`workspace_key = sha256(realpath(canonical_workspace_path))[:32]`. The manifest stores the canonical path, the active room id, the active watcher session id, and the last reset timestamp. The store is keyed by canonical folder, not by room id, because the operator's mental model is "this current folder starts fresh when I open the walker." If the same folder gets a new Talking Stick room later, the old folder-local walker lint must not survive under an obsolete room id.

**Override:** `--store <path>` flag on `tt watch` and `tt walk` for explicit repo-local mode (debugging, ephemeral worktrees). When repo-local mode is used, the implementation must add the store path to `.git/info/exclude` automatically so it never appears in `git status`.

**Why outside the repo by default:** snapshot blobs are high-churn and would dirty `git status`, defeat `git clean`, balloon backups, and force every consuming repo to add a `.gitignore` entry. The CAS journal is operator infrastructure, not project artifact.

**Why folder-scoped instead of room-scoped:** room ids are coordination epochs, not storage ownership boundaries. A folder can accumulate multiple rooms during planning, implementation, and review. Resetting by canonical folder makes `tt walk` a reliable "start watching from now" command and keeps old room stores from growing forever.

### Watch registry (v1)

The registry is the only watcher state that survives default resets. It is small, path-indexed, and exists so a destructive session reset can safely delete the per-workspace journal without deleting the writer lease that protects that reset.

```sql
CREATE TABLE watch_workspaces (
  workspace_key      TEXT PRIMARY KEY,
  canonical_path     TEXT NOT NULL UNIQUE,
  store_path         TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  current_room_id    TEXT,
  current_session_id TEXT,
  last_reset_at      TEXT
);

CREATE TABLE watcher_leases (
  workspace_key     TEXT PRIMARY KEY REFERENCES watch_workspaces(workspace_key),
  holder_id         TEXT NOT NULL,
  host_id           TEXT,
  pid               INTEGER,
  heartbeat_at      TEXT NOT NULL,
  lease_expires_at  TEXT NOT NULL
);
```

The lease lives in `registry.sqlite`, not in `watch.sqlite`. That boundary is load-bearing: the reset path can atomically rename and recreate the entire workspace store while the registry lease remains valid.

On startup, the registry must compare `workspace_key` against the stored `canonical_path`. A hash collision or manifest mismatch is a hard error, not a reason to reuse another folder's store.

### Session schema (v1)

This schema lives in the resettable per-workspace `watch.sqlite`.

```sql
CREATE TABLE watch_session (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id      TEXT NOT NULL,          -- uuid for the current fresh baseline
  canonical_path  TEXT NOT NULL,
  room_id         TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  reset_mode      TEXT NOT NULL,          -- 'fresh' | 'resume'
  baseline_event_seq INTEGER,
  baseline_git_head TEXT
);

CREATE TABLE file_versions (
  version_id   TEXT PRIMARY KEY,         -- "<sha256>:<size>"
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  blob_path    TEXT,                     -- relative to watch dir; NULL until/no body stored
  first_seen_at TEXT NOT NULL
);

CREATE TABLE path_heads (
  path          TEXT PRIMARY KEY,         -- workspace-relative
  version_id    TEXT REFERENCES file_versions(version_id),
  class         TEXT,                     -- 'source' | 'opaque' | 'skipped'; NULL when deleted
  exists_now    INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE change_batches (
  batch_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at       TEXT NOT NULL,
  closed_at       TEXT NOT NULL,
  attributed_to   TEXT,                  -- agent_id at batch open; NULL if room idle
  attribution_kind TEXT NOT NULL,        -- 'owner' | 'multi_owner' | 'none'
  room_event_seq_lo INTEGER,             -- first room event seq inside batch window
  room_event_seq_hi INTEGER,             -- last room event seq inside batch window
  source          TEXT NOT NULL DEFAULT 'fs_watch'  -- 'fs_watch' | 'reconcile'; v2: 'hook'
);

CREATE TABLE file_changes (
  change_seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES change_batches(batch_id),
  path          TEXT NOT NULL,           -- workspace-relative
  rename_from   TEXT,                    -- non-null if detected rename
  class         TEXT NOT NULL,           -- render/projection class: 'source' | 'opaque' | 'skipped'
  visible       INTEGER NOT NULL DEFAULT 1, -- 0 for internal projection-maintenance rows
  before_version_id TEXT REFERENCES file_versions(version_id),  -- NULL on add
  after_version_id  TEXT REFERENCES file_versions(version_id),  -- NULL on delete
  observed_at   TEXT NOT NULL,
  tool_call_id  TEXT,                    -- v2 hook attribution
  harness_event_id TEXT                  -- v2 hook attribution
);

CREATE TABLE annotations (
  annotation_id TEXT PRIMARY KEY,        -- uuid
  change_seq    INTEGER NOT NULL REFERENCES file_changes(change_seq),
  before_version_id TEXT,                -- snapshot of versions at annotation time
  after_version_id  TEXT,
  line_side     TEXT NOT NULL DEFAULT 'after', -- 'before' | 'after'
  line_start    INTEGER,                 -- inclusive, in selected side
  line_end      INTEGER,                 -- inclusive
  selected_text TEXT,                    -- short excerpt for offline review / delivery
  body          TEXT NOT NULL,
  author        TEXT NOT NULL,           -- 'human:<user>' or harness id
  created_at    TEXT NOT NULL,
  delivery_status TEXT NOT NULL,         -- 'pending' | 'sent' | 'noted' | 'failed'
  delivered_to  TEXT,                    -- agent_id once delivered
  delivery_attempted_at TEXT,
  message_event_seq INTEGER,             -- talking-stick event seq if message route
  note_id       TEXT                     -- talking-stick note_id if note route
);

CREATE INDEX idx_file_changes_batch ON file_changes(batch_id);
CREATE INDEX idx_file_changes_path  ON file_changes(path);
CREATE INDEX idx_file_changes_feed  ON file_changes(change_seq) WHERE visible = 1;
CREATE INDEX idx_path_heads_version ON path_heads(version_id);
CREATE INDEX idx_annotations_change ON annotations(change_seq);
CREATE INDEX idx_annotations_pending ON annotations(delivery_status) WHERE delivery_status = 'pending';
```

The database represents one live watcher session for the folder. In the default `fresh` mode, startup deletes and recreates `watch.sqlite`, `blobs/`, and `projection.git/` before inserting a new `watch_session` row, so old `change_batches`, `file_changes`, `path_heads`, `file_versions`, and local annotations cannot leak into the new operator view. `reset_mode='resume'` exists only when the operator explicitly opts out of the default wipe.

`file_versions` is content-addressed; it does not own classification because classification is path- and scan-context-dependent. The same bytes may be a rendered source diff at `README.md` and an opaque attachment under another path. `file_changes.class` records how this change is reviewed and projected, while `path_heads.class` records the current path state. For adds and modifications, `file_changes.class` is the after-state class. For deletions, it is the previous `path_heads.class`, because the UI still needs to know whether the delete is renderable as a source diff. If content is first observed as opaque and later appears as source, the implementation may backfill `blob_path` for the existing `version_id`.

`file_changes.visible=0` exists for internal maintenance only. The main case is a previously projected source path becoming skipped because it crossed `max_track_bytes`: the operator should not see a huge-file diff item, but the projection still needs a tombstone so rebuilds do not keep stale source content.

`path_heads` is the fast "what did we last believe this path contained?" table. `file_changes` is the immutable audit trail. This avoids deriving current state by scanning the tail of `file_changes` on every filesystem event, makes deletes/re-adds explicit, and lets `version_id = NULL, class = 'skipped', exists_now = 1` represent "the file exists but is intentionally outside the walker's tracking budget."

**Invariant:** deleting the shadow git cache (see §Diff projection) never loses current-session review history. Deleting `watch.sqlite` and `blobs/` does, and that deletion is now the normal default when a fresh walker session starts. Operator-facing: `tt walk` / `tt watch start` resets the folder-local journal; `tt walk --resume` is the explicit "keep the previous session" escape hatch.

## File classification

Every path the watcher considers falls into one of three buckets:

| Class | Trigger | Storage | Feed display | Diff body |
|---|---|---|---|---|
| `source` (body stored) | extension in allowlist AND size ≤ `max_blob_bytes` AND content sniff is text | `file_versions` row + blob written; `file_changes.class='source'` | `+12 −3 src/service.ts` | unified diff rendered |
| `source` (truncated) | extension in allowlist AND size > `max_blob_bytes` | `file_versions` row, `blob_path = NULL`; `file_changes.class='source'` | `~ src/big.sql (12.4 MB → 12.6 MB)` | "file too large to render" |
| `opaque` | extension NOT in allowlist OR content sniff trips binary detection | `file_versions` row, `blob_path = NULL`; `file_changes.class='opaque'` | `~ assets/logo.png (hash a3f1… → b29c…)` | "binary or unknown file type — hash delta only" |
| `skipped` | size > `max_track_bytes` (any extension) | no `file_versions`; `path_heads.class='skipped'`, `version_id=NULL`; hidden `file_changes.visible=0` row only when needed to remove prior projected source | not shown as a diff item | — |

**Default source extension allowlist** (compiled in, extendable via `source_extensions` config):

```
ts, tsx, js, jsx, mjs, cjs, py, pyi, go, rs, java, kt, kts, scala,
c, h, cc, cpp, cxx, hh, hpp, hxx, cs, fs, fsx, swift, m, mm,
rb, erb, php, lua, pl, r, ex, exs, erl, hs, clj, cljs, cljc, ml, mli,
sh, bash, zsh, fish, ps1,
html, htm, css, scss, sass, less, vue, svelte, astro,
json, yaml, yml, toml, ini, conf, xml, env,
md, mdx, rst, adoc, txt, tex,
sql, proto, gql, graphql, prisma,
gitignore, gitattributes, editorconfig, dockerignore, npmrc
```

**Default source filename allowlist** (no extension, matched by basename):

```
Dockerfile, Containerfile, Makefile, CMakeLists.txt, Rakefile, Gemfile,
Procfile, Justfile, Vagrantfile, Brewfile, Pipfile, package.json,
tsconfig.json, jest.config.ts, vite.config.ts, .env, .gitignore
```

The operator can extend either list (or replace defaults) in `watch.toml`:

```toml
source_extensions = ["ts", "tsx", "py", "...", "csv"]   # add csv if you treat it as source
source_filenames  = ["Dockerfile", "..."]
source_extensions_extra = ["mdc"]                       # additive without replacing defaults
```

**Binary detection.** Even if a path has a source extension, the watcher peeks the first 8 KiB. If the file has a UTF-8/UTF-16 BOM and decodes cleanly, it stays source. Otherwise, any NUL byte in the peek window reclassifies the path as `opaque` for that change. This protects against accidentally rendering a `.json` that turned out to be a binary blob without incorrectly demoting legitimate UTF-16 source files.

**Why three classes, not two:**

- `opaque` exists so the operator still sees that `assets/logo.png` or `data.parquet` *changed* — useful context when an agent regenerates a build artifact — without forcing the walker to read or render arbitrarily large or binary bodies.
- `skipped` exists so a 2 GB `node_modules` dump or a generated 500 MB JSON file doesn't make the watcher waste I/O hashing it on every save. We record the current path head so future shrink/delete events do not diff against stale older content; there is no content hash and no feed item. If the path used to be projected source, we also record a hidden projection tombstone so `projection.git` does not retain stale text.
- `source` is the human-readable middle. The walker's whole reason for existing.

## Watcher algorithm

The watcher is a long-lived process started by `tt watch start [--room <id>]`, scoped to one room and one canonical workspace. It is independent of the talking-stick MCP server — separate process, separate sqlite file, no shared schema.

Only one writer may own a canonical workspace at a time. `tt walk` and `tt watch start` first try to acquire the registry `watcher_leases` row. If a healthy writer exists for the same room, they become readers/subscribers. If a healthy writer exists for another room in the same folder, startup fails with an active-watcher conflict. If the lease is expired and the process is gone, the next starter takes over and follows the session reset contract: fresh baseline by default, or reconciliation against the prior journal only when `--resume` was explicit.

```
on_fs_event(path):                          # via chokidar/watchman
    if ignored(path): return                # .git, watch_dir, .gitignore (re-evaluated)
    add path to dirty_set
    if no batch open: open_batch(now)
    bump batch_close_deadline = now + 150ms
    bump batch_hard_deadline   = batch_open + 1000ms

every tick (every 50ms):
    if batch open and (now >= batch_close_deadline or now >= batch_hard_deadline):
        close_batch()
    if no batch open and now >= next_reconcile_deadline:
        reconcile_workspace()

close_batch:
    snapshot dirty_set plus git_status_delta(); clear dirty_set
    for each path in snapshot:
        scan_one(path)                       # see below
    write change_batches row with attribution from room state
    write file_changes rows
    update path_heads rows for changed paths
    fsync
    notify subscribers (walker UIs) over local IPC or polling fallback

scan_one(path):
    s1 = stat(path)                          # may not exist (deletion)
    if not exists:
        emit deletion change against last known version
        return
    if s1.size > MAX_TRACK_BYTES:
        # huge file: outside tracking budget. Mark the path head so later
        # deletion/shrink does not diff against stale older content.
        if previous head was projected source:
            record hidden file_change with class='skipped', visible=0
        update path_heads(path, version_id=NULL, class='skipped', exists_now=1)
        log diagnostic ("skipped huge file {path} {size}"); return
    is_source = ext_in_allowlist(path) or basename_in_allowlist(path)
    if is_source and s1.size <= MAX_BLOB_BYTES:
        body = read(path)
        s2 = stat(path)
        if s1.size != s2.size or s1.mtime_ns != s2.mtime_ns:
            retry_as_torn(); return
        if first_8kib(body) contains NUL:
            # source extension but actually binary — downgrade to opaque
            sha = sha256(body)
            record version with blob_path=NULL
            record file_change with class='opaque'
            return
        sha = sha256(body)
        if version (sha,size) not in store: write blob, insert file_versions
        record file_change with class='source'
        return
    # source-but-truncated, or opaque: hash only, no body
    sha = streaming_sha256(path)
    s2 = stat(path)
    if s1.size != s2.size or s1.mtime_ns != s2.mtime_ns:
        retry_as_torn(); return
    cls = 'source' if is_source else 'opaque'
    record version with blob_path=NULL
    record file_change with class=cls against previous version for this path
```

**Wake-vs-truth.** fs events only mark `dirty_set` and start the deadline. The actual statement of fact (this version replaced that version) comes from the post-quiet-window scan. Editor save patterns that emit weird sequences (atomic rename, `vim` swap dance, multi-write fsync) all collapse into one batch.

**Quiet window — adaptive and bounded.** First dirty event starts a batch. Close after 150ms of silence. Hard cap at 1000ms so an actively-generating script doesn't starve the UI. The 150ms default is a config knob; we expect to tune.

**Periodic reconciliation.** Filesystem events are a wakeup, not a correctness proof. Every 30s while the room is active, and on watcher takeover/restart, the watcher runs a bounded reconciliation pass using `git status --porcelain -z`, `git ls-files -z`, and `git ls-files -z --others --exclude-standard`. This catches dropped fs events, branch checkouts, generated files that appeared before the watcher was ready, and manual edits from outside the agent harness.

**Path discovery.** v1 uses chokidar with the workspace root as the watch root. Tracked files are always eligible even if they match an ignore rule; untracked files are eligible only when `git ls-files --others --exclude-standard` would show them. In non-git workspaces, the watcher falls back to a bounded filesystem walk with `.gitignore`-style excludes where available. The watcher's own `--store` path, the talking-stick data dir, nested watch stores, and `.git/` are unconditionally ignored.

**Bootstrapping.** At the beginning of every fresh session, the watcher seeds `file_versions` and `path_heads` from the current tracked + untracked-non-ignored set without emitting thousands of normal feed items. The UI shows a single baseline summary row ("baseline captured: 1,284 files") that can be expanded for debugging. Normal `file_changes` start only after the baseline is complete. A `--show-baseline-changes` debug flag may materialize baseline rows, but it is not the default operator UX.

The bootstrap also seeds `projection.git` with one baseline tree containing every current `source` path whose version has a stored blob. That baseline commit has no visible `file_changes` row. Without it, the first real batch cannot produce correct deletes, renames, or modifications against the session starting point.

## Attribution model

Attribution is observational, not authoritative. The watcher reads room state at batch open and brackets the batch with the room event cursor. It may maintain that cursor through `wait_for_events --target any` or by reading `getLatestEventSeq` / `getRoomEvents` directly; the important point is that attribution is tied to an event-seq window, not just wall-clock timestamps.

```
on batch open:
    sample = get_room_state(room_id)
    attributed_to = sample.owner          # may be NULL if room idle
    room_event_seq_lo = current_event_cursor
on batch close:
    room_event_seq_hi = current_event_cursor
    if owner changed in [lo, hi]:
        attribution_kind = 'multi_owner'
        attributed_to    = NULL          # ambiguous
    elif attributed_to is None:
        attribution_kind = 'none'
    else:
        attribution_kind = 'owner'
```

The walker UI displays:
- `owner`: "by codex" — single attributed agent
- `multi_owner`: "during handoff" — visual indicator that ownership changed mid-batch
- `none`: "no owner" — change happened while room was idle (probably operator or unattributed automation)

**v2 schema affordance.** `change_batches.source` and `file_changes.tool_call_id` / `harness_event_id` exist now but are populated only by `fs_watch` in v1. A future hook integration may either enrich watcher-observed rows with hook metadata or write `source = 'hook'` batches that the UI coalesces with watcher rows by `(path, before_version_id, after_version_id)`. It cannot rely on two independent rows sharing the same `change_seq`, because `change_seq` is the primary key.

## Diff / projection layer

The shadow git cache is **disposable** and **rebuildable**. It exists only to give us free three-way diff and rename detection without reimplementing them.

```
${watch_dir}/projection.git/   # bare git repo, --object-format=sha256
```

On batch close, after the CAS write, the watcher:

1. Starts from the prior projected tree.
2. For source add/modify rows with a stored after-blob, writes that blob into the index.
3. For source delete rows, removes the path from the index.
4. For source paths that become opaque, skipped, or source-truncated, removes any prior projected path so stale text cannot survive in later diffs.
5. Commits with metadata: `author = attributed_to` when it can be converted into a valid git identity, otherwise `author = "watcher"`, message `batch:<batch_id>`.

Diff requests from the walker UI are served as `git diff -M --find-renames=85% <prev_tree> <next_tree> -- <path>`. The CAS already has the bodies; git just gives us the algorithm.

The projection's tree contains only paths whose current state is source with a stored blob. Source deletes, source-to-opaque transitions, source-to-truncated transitions, and hidden source-to-skipped tombstones remove prior projected paths even when the new state has no blob. Opaque changes and source-truncated changes appear in the feed (with size and hash deltas) but never render as text diffs. Skipped paths never appear as feed items. This means the projection's tree size is bounded by the stored source subset of the workspace, which is typically a small fraction of the total tree on disk — git's similarity heuristic stays fast and rename detection stays meaningful.

**If `projection.git` is corrupted or deleted**, the watcher detects on next start, recreates it by replaying `change_batches` in `batch_id` order. No history is lost; only the projection rebuild costs time.

**Renames.** Detected by git's similarity heuristic and recorded back into `file_changes.rename_from`. v1 displays the rename in the change feed as `path/old → path/new` with the diff against the most-similar prior version.

## Annotation delivery

Annotations are the only mutation the walker performs. The path is durable-first, deliver-second.

```
on operator confirms annotation modal:
    insert annotations row, delivery_status = 'pending'
    fsync
    pick recipient:
        if attributed_agent_id is active and owns-or-recently-owned: target = attributed_agent
        else if room.owner is set:                                  target = room.owner
        else:                                                       target = None
    if target is set:
        send_message(room_id, to_agent_id=target, body=formatted_annotation)
        update delivery_status = 'sent', message_event_seq, delivered_to
    else:
        add_note(room_id, body=formatted_annotation, turn_id=current_turn_or_null)
        update delivery_status = 'noted', note_id
    on any failure: delivery_status = 'failed'; surface in UI; offer retry
```

**Why durable before delivery:** the operator's annotation is real work. If the talking-stick server is down or the recipient flaked, the annotation must still exist locally so we can retry without re-typing. The walker UI shows pending annotations in the feed with a small clock icon.

**Annotation format (sent body):**

```
[diff-walker] src/service.ts:412-418 (change #4731, batch #312)
> - throw new Error("not_found");
> + throw new TypedError({ code: "not_found", ... });
This breaks callers in tests/cli.test.ts that match on .message; consider a compat shim.
```

The change/batch IDs let the recipient correlate back to the walker if they want to inspect surrounding state.

**Routing fallbacks tightened from §Goals:**

1. Attributed agent if `currently active` AND (`is_owner` OR `last owner within 5 minutes`). The "recently owned" window catches the common case where the operator reviews a batch after the agent has already handed off, without paging an agent about stale work from hours ago.
2. Else current owner via `send_message`.
3. Else `add_note` (durable). No room broadcast — that loses agent-targeting and pollutes the message log.

The annotation modal must allow manual retargeting before send. The automatic chain is a default, not a hidden policy trap.

## Lifecycle and cleanup

- **Start:** `tt watch start` autospawns when `tt walk` is opened on a workspace/room pair with no live watcher. Operator can also start explicitly with `tt watch start --room <id> --background`.
- **Default reset:** when a starter becomes the writer for a canonical workspace, it resets that workspace's watcher store before bootstrapping. This is true even if old history exists from a previous room for the same folder.
- **Attach:** if a healthy watcher already owns the workspace lease for the same room, a new `tt walk` attaches as a reader/subscriber and does not reset anything. Co-walking an active session must not wipe the writer's state. If the live writer is tied to a different room for the same folder, startup fails with an active-watcher conflict instead of mixing attribution windows.
- **Resume:** `tt walk --resume` or `tt watch start --resume` keeps the prior watcher store and skips the default reset. This flag is explicit because the safe ergonomic default is "show me changes from now."
- **Stop:** the watcher exits when (a) operator runs `tt watch stop --room <id>`, (b) the room is closed/deleted, (c) all members of the room go inactive for > `idleRoomTtlMs / 4` (configurable). A later plain `tt walk` starts a fresh baseline; a later `tt walk --resume` reopens the stopped session read-only or restarts it.
- **GC:** `tt watch gc` removes blobs not referenced by any current-session `file_versions` row. It is mostly a repair/debug command because default reset deletes the whole store instead of relying on incremental pruning.
- **Archive:** `tt watch archive --room <id> --to <path>` or `tt walk --archive <path>` produces a self-contained tarball of `watch.sqlite + blobs/ + projection.git` before any reset. Archiving is opt-in so the default cleanup actually keeps disk use down.

## Session reset

The reset path is part of the normal startup contract, not a maintenance command the operator has to remember.

```
tt walk / tt watch start:
    resolve canonical workspace path and room id
    workspace_key = sha256(realpath(canonical_workspace_path))[:32]
    acquire registry watcher lease for workspace_key

    if a healthy writer already holds the lease for the same room:
        attach as reader/subscriber
        return

    if a healthy writer already holds the lease for another room:
        fail with active-watcher conflict; operator can stop that watcher first

    if --resume:
        open existing store if present; otherwise create fresh store
        bootstrap if no baseline exists; otherwise reconcile prior journal
        continue as writer

    if pending annotations exist:
        flush_pending_annotations()
        if any remain pending and not --force:
            fail before deleting local state

    if --archive <path>:
        tar watch.sqlite + blobs/ + projection.git before deletion

    atomically rename current store to deleting-<timestamp>
    create empty store at watch/workspaces/<workspace_key>
    initialize schema and manifest
    insert watch_session(reset_mode='fresh')
    update registry current_session_id/current_room_id/last_reset_at
    bootstrap baseline from current filesystem state
    asynchronously remove deleting-<timestamp>
```

**What is scrubbed:** `watch.sqlite`, `blobs/`, `projection.git/`, local `annotations`, `file_versions`, `change_batches`, `file_changes`, `path_heads`, and any transient IPC/read-model state under the workspace watch store.

**What is not scrubbed:** Talking Stick room events, sent messages, and notes. Those belong to the coordination substrate. If an annotation was already delivered as a message or note, the walker reset removes only the local copy, not the room audit record.

**Pending annotations.** The design keeps the durable-before-delivery invariant for operator-authored annotations. Before a destructive reset, the watcher tries to deliver every `delivery_status='pending'` annotation through the normal routing chain. If the target agent is gone and no owner is present, it writes a Talking Stick note as the final durable sink. Only after the pending queue is empty does the reset delete local annotation rows. `--force` may hard-drop pending local annotations, but the UI must label that as data loss.

**Why atomic rename:** deleting a large blob tree can take time and can fail halfway on disk errors. Renaming the old store out of the active path first lets the new session start from a clean directory. If cleanup of `deleting-<timestamp>` fails, a later `tt watch gc --stores` can retry without exposing the old rows to the new walker.

## Failure modes

| Mode | Detection | Behavior |
|---|---|---|
| fs watcher dies | health check + heartbeat from watcher process | walker shows red banner; offers `tt watch restart` |
| fs event dropped | periodic reconciliation finds path hash mismatch | create normal batch with `source='reconcile'`; UI labels it as recovered |
| disk full mid-batch | sqlite write fails | watcher exits with diagnostic; partial batch rolled back; UI shows last good batch |
| sqlite corruption | startup PRAGMA quick_check | plain fresh startup moves old store aside and starts a new baseline; `--resume` refuses unless operator archives or forces a reset |
| projection.git corrupted | rebuild on detection | rebuild from CAS; no data loss |
| annotation delivery flake | MCP/CLI error | row stays `pending`; UI offers retry; periodic background retry |
| pending annotation before reset | reset preflight sees `delivery_status='pending'` | flush to message/note before wipe; fail unless `--force` if any cannot be durably handed off |
| reset interrupted mid-delete | active path missing or `deleting-<timestamp>` remains | recreate active store from scratch; retry old-store removal through `tt watch gc --stores` |
| second walker starts during live session | registry lease heartbeat fresh for same room | attach as reader; no reset |
| walker starts for different room in same folder | registry lease heartbeat fresh for another room | refuse with active-watcher conflict; attribution cannot safely mix rooms |
| operator annotates while watcher is offline | walker writes pending annotation against last known `change_seq` | watcher on restart processes pending queue and delivers |
| ambiguous rename | git heuristic uncertain | record as add+delete pair; UI hint "possibly renamed from X" |
| opaque file change (unknown extension or binary content) | scan_one classifies | record `file_changes.class='opaque'`, `blob_path=NULL`; UI shows hash delta only |
| source file over `max_blob_bytes` (default 8 MiB) | scan_one classifies | record `file_changes.class='source'`, `blob_path=NULL`; UI shows size delta with "too large to render" |
| huge file over `max_track_bytes` (default 64 MiB) | scan_one early-out | mark `path_heads.class='skipped'`; write only a hidden projection tombstone if prior source must be removed; logged as skip diagnostic; never appears in feed |

## Concrete surface (v1)

CLI:
- `tt watch start [--room <id>] [--store <path>] [--resume] [--archive <path>] [--force]`
- `tt watch [stop|status|gc|archive] [--room <id>] [--store <path>]`
- `tt watch gc --stores` — retry removal of abandoned `deleting-<timestamp>` stores and stale registry rows whose processes are gone
- `tt walk [--room <id>] [--store <path>] [--resume] [--archive <path>] [--force]` — interactive TUI

MCP:
- No new MCP tools in v1. The walker is operator-side; agents do not interact with it directly. v2 may add `mcp__talking-stick__list_recent_diffs` for agents that want to see what just happened.

Configuration (env / config file under `~/.config/talking-stick/watch.toml`):
- `max_blob_bytes` (default `8388608` — 8 MiB; source files larger than this are tracked as `class='source'` with `blob_path=NULL`)
- `max_render_bytes` (default `1048576` — 1 MiB; larger source blobs are stored but collapsed in the diff body by default)
- `max_track_bytes` (default `67108864` — 64 MiB; files larger than this are skipped entirely from the feed, with only path-head state and any needed hidden projection tombstone recorded)
- `source_extensions` (replaces default extension allowlist if present)
- `source_extensions_extra` (additive — appends to default allowlist)
- `source_filenames` (replaces default filename allowlist if present)
- `source_filenames_extra` (additive)
- `quiet_window_ms` (default `150`)
- `batch_hard_cap_ms` (default `1000`)
- `reconcile_interval_ms` (default `30000`)
- `recent_owner_window_ms` (default `300000`)
- `idle_watcher_grace_ms` (default `idleRoomTtlMs / 4`)
- `follow_settle_delay_ms` (default `1500`)
- `follow_idle_timeout_ms` (default `30000`)

## Implementation sequence

Build this in slices that can be reviewed and tested independently:

1. **Watch store and reset substrate.** Add registry/session sqlite modules, workspace key resolution, schema version checks, manifest validation, registry lease heartbeats, atomic reset, `--resume`, `--archive`, and `gc --stores`. No filesystem watcher yet.
2. **Scanner and classifier.** Implement git-aware path discovery, ignore handling, torn-read retries, source/opaque/skipped classification, CAS blob writes, and `path_heads` updates. Cover this with deterministic fixture directories before introducing live watcher events.
3. **Batch journal and reconciliation.** Add dirty-set batching, quiet/hard deadlines, periodic reconciliation, attribution windows, and subscriber notifications. At this point a polling/debug UI can list batches without rendering diffs.
4. **Projection and diff rendering.** Seed the baseline projection, apply source add/modify/delete rows, rebuild projection from CAS, detect renames, and serve unified diffs. Keep projection disposable; corruption must not poison the journal.
5. **Annotation delivery.** Add selection metadata, durable-first annotation writes, retry state, routing to attributed/recent owner/current owner/note, and reset preflight flushing of pending annotations.
6. **TUI walker.** Build the keyboard/mouse feed, diff pane, status bar, follow/review state machine, selection model, annotation modal, manual retargeting, and degraded states for offline watcher, opaque/truncated/skipped changes, and pending delivery.

## Test plan

- **Reset semantics:** default startup deletes old session rows/blobs/projection for the same canonical folder, preserves only registry metadata, and starts a new baseline. `--resume` keeps prior rows. A live same-room writer causes attach/no wipe; a live different-room writer fails.
- **Store safety:** workspace-key manifest mismatch hard-fails, reset uses atomic rename, interrupted deletion leaves a recoverable `deleting-<timestamp>` store, and `gc --stores` removes only stores not referenced by live leases.
- **Classification:** allowlisted text stores blobs, UTF-8/UTF-16 BOM source remains source, binary-looking source downgrades to opaque, unknown extensions hash-only, large source truncates, and huge files update `path_heads` as skipped without feed rows.
- **Watcher correctness:** rapid saves collapse into bounded batches, torn reads retry instead of recording false versions, atomic rename writes settle to one path, dropped fs events are recovered by reconciliation, and git ignored/untracked rules match `git ls-files` output.
- **Projection:** baseline projection exists before first visible batch; source adds/modifies/deletes produce correct diffs; source renames are detected; opaque/truncated/skipped changes never remain in the projected tree; hidden skipped tombstones remove prior projected source; projection rebuild from CAS matches the original tree sequence.
- **Annotation delivery:** annotations persist before delivery, route to attributed/recent/current owner before note fallback, survive delivery failures as retryable pending rows, and reset preflight flushes or blocks before destructive deletion unless `--force` is explicit.
- **TUI ergonomics:** default follow mode advances to new completed batches after the settle delay; navigation, mouse scroll, marking, search, and annotation entry enter review/compose mode; repeated `Esc` returns to live follow; idle review mode returns to live after the timeout; keyboard navigation is stable under live batch inserts; mouse and key selection produce the same line ranges; long lines and tiny terminals remain readable; offline/lag/pending-delivery states are visible without obscuring the diff.

## v1 / v2 cut

**v1:**
- Watcher process + CAS journal + projection.git
- TUI walker with live follow mode, feed/diff panes, keyboard nav, line/block annotation
- Owner-inferred attribution
- Durable annotation persistence + message/note delivery
- Folder-scoped default reset, single live writer per canonical workspace
- Single room per walker pane

**v2 candidates:**
- Hook integration for exact tool-call attribution (Claude Code PostToolUse, Codex equivalent)
- Multi-room aggregation in one walker pane
- Inline annotation reply in the walker (when an agent annotates back)
- Web-based walker for non-terminal contexts
- Diff replay scrubber ("rewind to batch 287")
- Cross-workspace project-board view

## Decisions and Remaining Questions

1. **Watcher implementation language.** Decision for v1: keep it in TypeScript with the existing `tt` package. A sibling Go binary is attractive for fs-watch performance, but it adds packaging, release, and cross-platform install surface before we know this is the bottleneck. Profile first; split only if the Node watcher proves inadequate.
2. **Walker TUI library.** Decision for v1: prefer a blessed/neo-blessed-style terminal renderer over Ink. The UX needs scroll panes, mouse support, stable diff layout, and low-level keyboard handling more than React component ergonomics. Keep the UI model separated enough that a future web or Ink renderer can reuse state.
3. **`get_room_state` polling cost.** The watcher needs a near-realtime read of room owner. Polling at batch open is one read per ~150ms-1s — fine. We could subscribe to `wait_for_events` instead, but that's more complex and the savings are tiny.
4. **Concurrent walkers.** Two operator panes on one room can both write annotations, but only one watcher process owns the registry lease and writes snapshots. Annotation writes still share the same sqlite WAL journal for the active workspace store. Should be fine, but worth a stress test.
5. **Ignore/reconciliation cost.** Running `git status` / `git ls-files` on every batch is cheap for normal dirty sets, but pathological generated trees can be large. Cache tracked/ignored sets between periodic reconciliations and fall back to path-prefix caches when a batch has thousands of files.
