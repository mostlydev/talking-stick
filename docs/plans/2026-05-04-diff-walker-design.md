# Diff Walker Design — Live Radiologist UX for Agent Edits

**Status:** design draft, pre-implementation. Authors: claude:45688d4d, codex:d4bc2492. Operator: Wojtek.

**Inspiration:** [umputun/revdiff](https://github.com/umputun/revdiff) — keyboard-first diff navigation. We extend the model from one-shot review to a live, persistent companion process that watches a workspace while agents work in it.

## Goals

- A separate operator-facing process (`tt walk`) that displays diffs as agents make them, navigable like a radiologist scrubs a film stack — keys for up/down/left/right, line/block selection, enter to annotate.
- Annotations route as messages back to the agent who made the change (or, if they are no longer reachable, the current stick holder, falling back to a durable note). Every annotation is persisted before any delivery attempt.
- Resilient under noisy editor saves, rapid sequential edits, atomic rename writes, and concurrent agents. The watcher should never lose a change, never claim a torn read as a real change, and never block the agents.
- Harness-neutral. v1 must work uniformly whether the agent is Claude Code, Codex CLI, Gemini, OpenCode, or a human at the keyboard. No hook integration required.

## Non-goals (v1)

- Hook-driven exact attribution per tool call. Schema leaves room (see §Attribution); v2 enriches.
- Inline editing of agent code from the walker UI. The walker is read-mostly with annotation as the only mutation.
- Multi-workspace aggregation. One walker pane = one room. Operator opens multiple panes for multiple rooms.
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
   w/s scroll feed   a/d prev-next change   space mark line
   enter annotate   tab toggle pane   /  search   ?  help
```

- The feed (left) is reverse-chronological by `change_seq`. Active edits appear at the top with a live cursor; resolved-and-quiet items dim.
- The diff body (right) shows the unified diff for the selected `change_seq`. `space` marks line ranges; `enter` opens the annotation modal pre-targeted at the attributed agent.
- A status bar shows the current room owner, the watcher's lag (events behind real time), and the snapshot store size.

## Storage model

The watcher's data lives **outside the repository**.

**Default location:** `${TALKING_STICK_DATA_DIR:-$XDG_DATA_HOME/talking-stick}/watch/<room_id>/` — sqlite at `watch.sqlite`, blobs in `blobs/<sha256-prefix>/<sha256>`. Keyed by `room_id`, not workspace path: a workspace can host multiple rooms over time, and each one gets its own watch tree.

**Override:** `--store <path>` flag on `tt watch` and `tt walk` for explicit repo-local mode (debugging, ephemeral worktrees). When repo-local mode is used, the implementation must add the store path to `.git/info/exclude` automatically so it never appears in `git status`.

**Why outside the repo by default:** snapshot blobs are high-churn and would dirty `git status`, defeat `git clean`, balloon backups, and force every consuming repo to add a `.gitignore` entry. The CAS journal is operator infrastructure, not project artifact.

### Schema (v1)

```sql
CREATE TABLE file_versions (
  version_id   TEXT PRIMARY KEY,         -- "<sha256>:<size>"
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  blob_path    TEXT NOT NULL,            -- relative to watch dir
  is_binary    INTEGER NOT NULL,         -- skip diff display, count only
  is_truncated INTEGER NOT NULL,         -- captured but body not stored (>max_blob_bytes)
  first_seen_at TEXT NOT NULL
);

CREATE TABLE change_batches (
  batch_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at       TEXT NOT NULL,
  closed_at       TEXT NOT NULL,
  attributed_to   TEXT,                  -- agent_id at batch open; NULL if room idle
  attribution_kind TEXT NOT NULL,        -- 'owner' | 'multi_owner' | 'none'
  room_event_seq_lo INTEGER,             -- first room event seq inside batch window
  room_event_seq_hi INTEGER,             -- last room event seq inside batch window
  source          TEXT NOT NULL DEFAULT 'fs_watch'  -- v2: 'hook'
);

CREATE TABLE file_changes (
  change_seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES change_batches(batch_id),
  path          TEXT NOT NULL,           -- workspace-relative
  rename_from   TEXT,                    -- non-null if detected rename
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
  line_start    INTEGER,                 -- inclusive, in after_version
  line_end      INTEGER,                 -- inclusive
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
CREATE INDEX idx_annotations_change ON annotations(change_seq);
CREATE INDEX idx_annotations_pending ON annotations(delivery_status) WHERE delivery_status = 'pending';
```

**Invariant:** deleting the shadow git cache (see §Diff projection) never loses review history. Deleting `watch.sqlite` and `blobs/` does. Operator-facing: `tt watch prune --room <room_id>` removes the journal; routine cleanup is just `tt watch gc` against blobs unreferenced by any `file_versions` row.

## Watcher algorithm

The watcher is a long-lived process started by `tt watch [--room <id>]`, scoped to one room/workspace. It is independent of the talking-stick MCP server — separate process, separate sqlite file, no shared schema.

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

close_batch:
    snapshot dirty_set; clear dirty_set
    for each path in snapshot:
        scan_one(path)                       # see below
    write change_batches row with attribution from room state
    write file_changes rows
    fsync
    notify subscribers (walker UIs) over local Unix socket

scan_one(path):
    s1 = stat(path)                          # may not exist (deletion)
    if not exists:
        emit deletion change against last known version
        return
    if s1.size > MAX_BLOB_BYTES or is_binary(path):
        record version with is_truncated/is_binary; no body stored
    body = read(path)
    s2 = stat(path)
    if s1.size != s2.size or s1.mtime_ns != s2.mtime_ns:
        log diagnostic; reschedule path into next dirty cycle (up to 3 retries)
        return
    sha = sha256(body)
    if version (sha,size) not in store: write blob, insert file_versions
    record file_change against previous version for this path
```

**Wake-vs-truth.** fs events only mark `dirty_set` and start the deadline. The actual statement of fact (this version replaced that version) comes from the post-quiet-window scan. Editor save patterns that emit weird sequences (atomic rename, `vim` swap dance, multi-write fsync) all collapse into one batch.

**Quiet window — adaptive and bounded.** First dirty event starts a batch. Close after 150ms of silence. Hard cap at 1000ms so an actively-generating script doesn't starve the UI. The 150ms default is a config knob; we expect to tune.

**Path discovery.** v1 uses chokidar with the workspace root as the watch root, honoring `.gitignore` via `git check-ignore --stdin` batched at scan time (not per fs event). The watcher's own `--store` path, the talking-stick data dir, and `.git/` are unconditionally ignored.

**Bootstrapping.** On first run for a room, the watcher records the current `git ls-files`-tracked + untracked-non-ignored set as version baseline (one big batch, `attribution_kind = 'none'`, `attributed_to = NULL`). All subsequent batches are deltas off this baseline.

## Attribution model

Attribution is observational, not authoritative. The watcher reads room state at batch open and brackets the batch with `room_event_seq` from `wait_for_events` cursor.

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

**v2 schema affordance.** `change_batches.source` and `file_changes.tool_call_id` / `harness_event_id` exist now but are populated only by `fs_watch` in v1. A future hook integration writes `source = 'hook'` rows alongside the watcher's `fs_watch` rows; the UI prefers hook-attributed rows when both cover the same change_seq.

## Diff / projection layer

The shadow git cache is **disposable** and **rebuildable**. It exists only to give us free three-way diff and rename detection without reimplementing them.

```
${watch_dir}/projection.git/   # bare git repo, --object-format=sha256
```

On batch close, after the CAS write, the watcher:

1. Reads the after-state of every changed file from the CAS blobs.
2. Stages them into `projection.git`'s index against the prior batch's tree.
3. Commits with metadata: `author = attributed_to`, `committer = "watcher"`, message `batch:<batch_id>`.

Diff requests from the walker UI are served as `git diff -M --find-renames=85% <prev_tree> <next_tree> -- <path>`. The CAS already has the bodies; git just gives us the algorithm.

**If `projection.git` is corrupted or deleted**, the watcher detects on next start, recreates it by replaying `change_batches` in `batch_id` order. No history is lost; only the projection rebuild costs time.

**Renames.** Detected by git's similarity heuristic and recorded back into `file_changes.rename_from`. v1 displays the rename in the change feed as `path/old → path/new` with the diff against the most-similar prior version.

## Annotation delivery

Annotations are the only mutation the walker performs. The path is durable-first, deliver-second.

```
on operator confirms annotation modal:
    insert annotations row, delivery_status = 'pending'
    fsync
    pick recipient:
        if attributed_agent_id is set and currently active in room: target = attributed_agent
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

1. Attributed agent if `currently active` AND (`is_owner` OR `last owner within 30s`). The "recently owned" window catches the common case where the operator annotates a change moments after the agent passed.
2. Else current owner via `send_message`.
3. Else `add_note` (durable). No room broadcast — that loses agent-targeting and pollutes the message log.

## Lifecycle and cleanup

- **Start:** `tt watch` autospawns when `tt walk` is opened on a room with no live watcher. Operator can also start explicitly with `tt watch --room <id> --background`.
- **Stop:** the watcher exits when (a) operator runs `tt watch stop --room <id>`, (b) the room is closed/deleted, (c) all members of the room go inactive for > `idleRoomTtlMs / 4` (configurable). The walker can reconnect to a paused/exited watcher's state — `tt walk` against a stopped room shows historical changes read-only.
- **GC:** `tt watch gc` removes blobs not referenced by any `file_versions` row, plus any `file_versions` rows orphaned by a `tt watch prune` of older batches. Operator-driven; never automatic.
- **Archive:** `tt watch archive --room <id> --to <path>` produces a self-contained tarball of `watch.sqlite + blobs/ + projection.git`. For the "I want to come back to this review next week" case.

## Failure modes

| Mode | Detection | Behavior |
|---|---|---|
| fs watcher dies | health check + heartbeat from watcher process | walker shows red banner; offers `tt watch restart` |
| disk full mid-batch | sqlite write fails | watcher exits with diagnostic; partial batch rolled back; UI shows last good batch |
| sqlite corruption | startup PRAGMA quick_check | move corrupt file aside as `watch.sqlite.bad-<ts>`; replay from `projection.git` if intact, else cold start with new baseline |
| projection.git corrupted | rebuild on detection | rebuild from CAS; no data loss |
| annotation delivery flake | MCP/CLI error | row stays `pending`; UI offers retry; periodic background retry |
| operator annotates while watcher is offline | walker writes pending annotation against last known `change_seq` | watcher on restart processes pending queue and delivers |
| ambiguous rename | git heuristic uncertain | record as add+delete pair; UI hint "possibly renamed from X" |
| binary file change | scan_one classifies | record version with `is_binary=1`; UI shows size delta only |
| huge file (> max_blob_bytes, default 8 MiB) | scan_one classifies | `is_truncated=1`; UI shows "+/- bytes" with no body diff |

## Concrete surface (v1)

CLI:
- `tt watch [start|stop|status|gc|prune|archive] [--room <id>] [--store <path>]`
- `tt walk [--room <id>] [--store <path>]` — interactive TUI

MCP:
- No new MCP tools in v1. The walker is operator-side; agents do not interact with it directly. v2 may add `mcp__talking-stick__list_recent_diffs` for agents that want to see what just happened.

Configuration (env / config file under `~/.config/talking-stick/watch.toml`):
- `max_blob_bytes` (default `8388608`)
- `quiet_window_ms` (default `150`)
- `batch_hard_cap_ms` (default `1000`)
- `recent_owner_window_ms` (default `30000`)
- `idle_watcher_grace_ms` (default `idleRoomTtlMs / 4`)

## v1 / v2 cut

**v1:**
- Watcher process + CAS journal + projection.git
- TUI walker with feed/diff panes, keyboard nav, line/block annotation
- Owner-inferred attribution
- Durable annotation persistence + message/note delivery
- Workspace-scoped, single room per walker pane

**v2 candidates:**
- Hook integration for exact tool-call attribution (Claude Code PostToolUse, Codex equivalent)
- Multi-room aggregation in one walker pane
- Inline annotation reply in the walker (when an agent annotates back)
- Web-based walker for non-terminal contexts
- Diff replay scrubber ("rewind to batch 287")
- Cross-workspace project-board view

## Open questions

1. **Watcher implementation language.** Same TS codebase as `tt`, or a sibling Go binary for tighter fs-watch performance? Lean: keep TS for v1, profile, fork to Go only if chokidar overhead bites.
2. **Walker TUI library.** Ink (React for CLI), blessed, or hand-rolled with raw ANSI? Lean: Ink for v1; the radiologist UX has enough state that React's reconciliation pays off.
3. **`get_room_state` polling cost.** The watcher needs a near-realtime read of room owner. Polling at batch open is one read per ~150ms-1s — fine. We could subscribe to `wait_for_events` instead, but that's more complex and the savings are tiny.
4. **Concurrent walkers.** Two operator panes on one room — both write annotations. The CAS journal is shared; writes go through sqlite WAL. Should be fine, but worth a stress test.
5. **`.gitignore` re-evaluation cost.** Calling `git check-ignore --stdin` on every batch's dirty set is cheap, but if a batch has 10k files we should cache by path prefix.
