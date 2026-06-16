# Stable leases + actionable health + listener discipline (#55, #56)

Status: CONVERGED (claude + codex). Codex implements; both test/review.

## Problem

During a multi-agent run a **live** Codex harness was marked `harness_gone`,
its lease surrendered mid-implementation, and a peer claimed the room — while
the same Codex conversation continued and `tt whoami` still resolved it. Two
agents then disagreed about ownership during a release. Secondary: `tt health`
dumped 216 lines when the operator needed a one-glance "am I safe to work?"
answer; and `tt wait` returns made it easy to forget to restart the single
listener (or to accumulate duplicates).

## Root cause (the load-bearing finding)

`harness_gone` is the **guardian self-purging**. `tt guard`
(`src/cli/guardian.ts`) captures one `harness_pid` + `harness_process_started_at`
at spawn and, each tick, calls `checkGuardianLiveness`. The instant that pid is
absent from the process table it returns `"gone"` and the guardian calls
`relinquishOwnership` (reason `harness_gone`) and exits — **with no recency
check**.

That single-pid anchor is stable only for harnesses that run as **one
long-lived process per session** (Claude Code). For harnesses whose OS process
identity **rotates per turn** (Codex: `tt whoami` re-resolves the same `codex:`
agent under a new pid), the captured pid dies between turns and the guardian
surrenders a live owner's lease.

The asymmetry that makes this a *bug*, not a policy: the **service layer already
does the right thing**. `inspectRoom` → `isGonePersistent` (service.ts ~L3387)
only declares `owner_gone` when liveness is `gone` **AND**
`now - last_seen_at > goneGraceMs` (`2 × heartbeatIntervalMs = 10 min`). The
guardian skips that veto entirely. Because every `tt` command already refreshes
`last_seen_at` (`applyPresence`), an actively-working harness — even one
rotating pids — is provably alive, yet the guardian kills it anyway.

Key consequence: **presence refresh alone (Codex's draft) does NOT fix #55.**
The guardian runs in its own process on its captured ref, blind to `last_seen`.

## Converged design

### A. #55 core — guardian/service parity on "gone" (THE fix)

Single source of truth for "gone" = `isGonePersistent` (dead pid **and**
`last_seen` stale past `goneGraceMs`).

1. `relinquishOwnership` (service.ts): after the existing owner/turn/lease
   match, additionally require `isGonePersistent(ownerMember, liveness, now)`.
   If the owner is **not** persistently gone, change nothing and return a
   distinct status (`retained`). The surrender stays valid only when the
   service agrees the harness is really gone.
2. Guardian loop (guardian.ts L60-84): on a `"gone"` reading, still *call*
   `relinquishOwnership`, but only `process.exit(0)` when it actually
   relinquished (or owner/turn/lease no longer match). On `retained`, **do not
   exit** — fall through and keep heartbeating.

Net contract: ownership survives harness pid rotation as long as the harness
issues any `tt` command within the 10-min grace. A harness that is BOTH
pid-dead AND silent past grace is still reclaimed — immediately by the guardian
on its next tick, and independently by any waiting peer via the unchanged
service-layer `owner_gone` path. `owner_idle` (Tier-2, peer-gated) is untouched.
No risky merge-logic surgery: `shouldPreserveExactMemberProcessMetadata` already
declines to preserve a `gone` identity, so a live owner command re-stamps fresh
metadata on its own.

Optional follow-up (NOT required for this fix, lower priority): have the
guardian re-read the owner's current harness anchor from the DB each tick so it
trusts a rotated-but-alive pid without leaning on the grace window. Defer unless
testing shows the veto is insufficient.

### B. #55 presence — every command is a liveness heartbeat

Mostly already true via `applyPresence`. Close the gaps Codex found:

- `getRoomHealth` / `tt status` refresh the **caller's** `last_seen_at` +
  process metadata (liveness only). Health stays read-only w.r.t.
  room/turn/event state and never renews the lease. Non-member reads remain
  harmless no-ops.
- Owner mutating commands (`release`/`pass`/`takeover`/`notes add`) pass current
  process metadata so a live owner re-stamps a fresh anchor.
- Authority is unchanged: lease TTL is renewed only by the guardian heartbeat
  and validated by owner mutations. Reads never renew authority (preserves
  `owner_idle` reclaim).

### C. #55 health — concise by default

Default `tt health` / `tt status` = an action card (~8 lines), not the dump:

- owner + `you_own` (is it me?)
- lease: expiry + renewal status
- guardian: present/alive for this harness
- listener: canonical wait active? + duplicate count
- dirty-git summary
- `next_action`: the exact command to run

Concise JSON schema (stable):
`{ owner, you_own, lease:{expires_at, renewing}, guardian:{status},
listener:{active, duplicates}, git:{dirty, summary}, next_action,
hidden:{members_omitted, receivers_omitted} }`.

Full member rows + receiver process commands + diagnostics move behind
`--verbose` / `--all`. Decision on open Q1: **default concise, do not keep the
full dump for "compatibility"** — the dump is the actual complaint, and health
shipped only in 0.6.0 so churn is minimal. `hidden.*` counts tell JSON
consumers detail exists.

### D. #56 — listener restart reminder + duplicate call-out

- Every `tt wait` / `tt try` return appends a short, wait-specific reminder in
  both human and JSON output, e.g.
  `next: restart your listener, keep only one active` (JSON: a dedicated field,
  not a reuse of the generic `coordination_prompt`).
- If duplicate active listeners are detected for **the caller's own harness**
  scoped to this room+cwd, say so directly and suggest stopping extras.
  Decision on open Q2: **scope to the caller's harness, not all room
  candidates** — "keep only one" is a per-harness instruction and a peer's
  listeners aren't mine to kill. Apply ancestor-dedup so a wrapper shell + its
  child `node tt wait` count once.
- Keep wording short; full receiver diagnostics live in health `--verbose`.

### E. Skill / README

State explicitly: (1) `tt wait` returns are **bounded long-polls**, not durable
background coverage — restart the single listener each return; (2) ordinary `tt`
commands refresh presence; (3) **lease stability is carried by the guardian plus
command-level presence, never by a persistent foreground/background listener.**

## Harness-tools report (operator's explicit ask)

- **Claude Code**: one durable session process; can run `tt wait --events`
  truly in the background; guardian pid anchor is stable. Main failure mode is
  forgetting to *restart* the one loop or spawning duplicates (→ D).
- **Codex**: per-turn process model + weaker background-process persistence;
  cannot keep a background wait/guardian reliably alive across turns; its
  guardian pid anchor rotates → the #55 false positive lands specifically on it.
  Needs the guardian veto (A) + command-level presence (B) to hold a stable
  lease.
- **Design rule that falls out of this:** never assume a persistent listener for
  *lease* stability. The wait loop delivers turns/events; the guardian keeps
  the lease alive, and command-level presence prevents false `harness_gone`
  conclusions. A/B make that true for both process models.

## Test plan

- Regression for #55: owner member with a dead `harness_pid` but fresh
  `last_seen_at` → `relinquishOwnership` returns `retained`, room stays `owned`;
  with `last_seen_at` aged past `goneGraceMs` → relinquishes to `idle`.
- Guardian: on `retained`, does not exit; on real `gone`, relinquishes + exits.
- Presence: `getRoomHealth` / `status` refresh caller `last_seen` without
  touching room/turn/events or the lease; non-member read is a no-op.
- Health: default output is the concise card; `--verbose`/`--all` restores full
  rows; concise JSON matches the schema incl. `hidden.*`.
- #56: wait/try human + JSON include the listener reminder; duplicate
  same-harness listeners for the room/cwd are reported and ancestor-deduped;
  single listener → no false duplicate warning.
- `npm test` + `npm run typecheck` green.
