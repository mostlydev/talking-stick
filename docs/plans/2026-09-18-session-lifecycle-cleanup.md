# Exact session lifecycle cleanup

The operator reported duplicate Claude and Codex entries after `/clear` in the
dicom-capacitor room. Both old/new pairs shared an unchanged harness PID and
process start time. Process liveness correctly reported the processes alive,
but could not establish whether each session was still attached.

## Decision

Install fail-open SessionStart/SessionEnd hooks for Claude, Codex, and Grok.
Retire only the session explicitly named by an end hook, bound to the local
host and exact harness PID/start time. Remove membership, receiver/wake
registrations, and any lease or reservation belonging to that session.
Retirement markers prevent a lingering old receiver from recreating membership.
SessionStart permits the named session to resume, including in a new process.

Never infer that one verified session replaced another merely because both
share a process. This preserves concurrent threads and subagents. An inferred
predecessor ledger was rejected: it can undercount sessions created before
installation and evict the wrong live thread.

The installer preserves foreign hooks, including hooks sharing an entry with
ours. Lifecycle and Stop actions use distinct deduplication keys even when
both patch Claude settings. Codex hooks require the harness's own trust review.

## Evidence and limits

- Disposable Claude 2.1.276/2.1.277 probes: `/clear` emits SessionEnd with the
  **old** ID and reason `clear`, then SessionStart with a new ID. `/resume`
  emits SessionEnd for the current session and SessionStart for the exact
  resumed ID. Coordinating and operator sessions were not cleared.
- Disposable Codex 0.154.0 probe: SessionStart fires at the first model prompt,
  with source `clear` after `/clear`; SessionEnd for old/new threads appeared
  on normal quit, not immediately at `/clear`.
- [Codex's documented contract](https://learn.chatgpt.com/docs/hooks#sessionend)
  also ends an idle thread after 30 minutes **only if it is not open in any
  connected client**. Open standby sessions are excluded. Immediate Codex
  `/clear` cleanup remains unsupported; no predecessor is guessed.
- Hooks cannot reconstruct events from before installation. Crash cleanup
  continues using existing process liveness checks.
- Process tombstones older than 30 days are reclaimed only after confirmed
  exact process death. Room-agent markers last until resume or room deletion.

## Verification

Regression coverage: concurrent same-PID sessions, other hosts, PID reuse,
lease/reservation revocation, endpoint cascade, duplicate end events,
metadata-less late receivers, same/new-process resume, malformed/subagent
hooks, hook merge/uninstall preservation, and conservative tombstone GC.

Final suite: 657 passed, one skipped; typecheck passed. Grok's review caught
snake-case event values; the handler now normalizes spelling, with a regression
covering native Grok input and shell-to-Grok ancestry.

Live verification of the compiled hook at `f8d500e`, with a disposable Claude
2.1.277 in an isolated data directory and workspace, loading only scratch
settings (`--setting-sources local`) so no real hook configuration changed. Every
lifecycle event went through `node dist/cli.js session-hook claude`:

| Step | Result |
| --- | --- |
| Session A joins via `tt join` inside the session | A is a member |
| `/clear` | SessionEnd `clear` for A; A removed with a `leave … session_ended` event; new session B |
| A's ID rejoins from the same process | Refused with `session_ended`: a lingering old listener cannot resurrect it |
| B joins | Joined |
| `/resume A` | SessionEnd `resume` removes B; SessionStart `resume` for the same ID A; A rejoins |

A second, independent run using a join fixture confirmed `/clear` and normal-exit
retirement. It did not exercise resume: its original session was empty, and an
empty session cannot be resumed at all, so no tombstone can trap one. Lease
release was not exercised live and rests on the regression suite.

Draft PR #87 is open; nothing has been merged or released. After live verification,
Codex enabled the lifecycle hooks in the operator's real Claude, Codex, and Grok
configuration for local validation. These are global harness settings, so they
apply across projects, not only to this repository. Existing foreign settings
and hooks were structurally checked against private backups and preserved.
Codex's hooks still require its `/hooks` trust review.

The installed commands resolve `tt` from PATH. On this machine `tt` is npm-linked
to this checkout's `dist/cli.js`, so behavior follows the last build of this
checkout, including this unmerged branch. Building an older branch without
`session-hook` makes these fail-open commands no-op. Local installation is not
evidence of a published release. The historical dicom-capacitor ghost entries
remain unchanged.

Private pre-install backups were retained locally. For rollback, remove only
the managed lifecycle hooks from the current settings, preserving any later
foreign changes; do not blindly replace current settings with the snapshots.
