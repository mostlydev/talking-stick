# Managed headless supervisor

Status: design agreed (room notes 2824973c, 01cd46da and 4ffa33a6, consolidated here). The core, room bridge, CLI, launchd integration, and the Codex, Claude, and Grok adapters are in `src/supervisor/`.
The Grok adapter only attempts a fresh session. An `XAI_API_KEY` Keychain reference can name a credential; using that variable to pass `session/new` is not yet shown. The "Slices" table records each slice.

The supervisor is optional. It starts Claude, Codex and Grok in their headless modes as
processes it owns, and keeps them running. It changes nothing for Herdr, tmux or terminal sessions,
and it never adopts or takes over a session it did not start. Process groups give it lifecycle
control only. They are not a security sandbox.

## Adapters

An adapter speaks one harness's headless protocol. The interface is `src/supervisor/adapter.ts`.

- `start(spec, generation, onSpawn, signal)` spawns and handshakes. It never takes a prompt.
  - The supervisor records the start intent before the spawn.
  - The adapter calls `onSpawn` with the child's pid, process start time and process group the
    moment the child exists, before the handshake, so the child is owned even if the supervisor
    crashes mid-handshake.
  - A child whose handshake fails is stopped before `start` rejects.
- `capabilities()` reports what the adapter has proven: `prompt`, `resume`, `interrupt`,
  `approvals`. False means unavailable, never assumed.
- `submit({ input_id, text, mode })` writes one journalled input. The mode is `start_turn` for an
  idle worker, or `steer` for a busy Codex worker, which joins the running turn. Outcomes:
  - `written`: the bytes reached the pipe;
  - `accepted`: a turn started, or a steer joined one;
  - `queued`;
  - `rejected`;
  - `uncertain`: written but never acknowledged. It is never retried.

  A pipe error or EPIPE alone is not proof that nothing was written.
- `answerApproval(native_request_id, …)` answers on that handle's own generation only.
  - It refuses an id the harness no longer has pending.
  - A native cancellation, such as Codex's `serverRequest/resolved` after an interrupt, is
    reported as `approval_resolved`. The supervisor then expires that exact pending occurrence,
    and a decision made afterwards is refused.
- `probe()` checks liveness without the model: the process, and a protocol ping where one exists.
- `stop(grace)`: stdin EOF, then the process group, then SIGKILL.
- Adapters drain the child's output continuously and bound their queues. An overflow of protocol
  events is reported as `overflow`, and the supervisor holds the worker. Events are never dropped.

### Permissions and environment

Each worker states its permissions, and nothing is inherited:

| Harness | Permissions |
| --- | --- |
| Claude | `--permission-mode default` or `plan`, `--permission-prompt-tool stdio`, `--setting-sources project,local`, `--strict-mcp-config`. Never `bypassPermissions` or `--dangerously-*`. |
| Codex | An explicit sandbox (`read-only` or `workspace-write`) and approval policy (`on-request` or `untrusted`) on each thread. Never `never` or `danger-full-access`. |
| Grok | `grok agent --no-leader stdio` with a private `GROK_HOME`. The user's config is never copied, since it may set always-approve. No leader attach, no plugin dir. `XAI_API_KEY` may be named with a Keychain env ref and is not copied into the home. |

A worker spec stores environment references only: names passed through from the supervisor's
own environment, names resolved from the macOS Keychain at spawn, and approved non-secret
literals. At each start the supervisor adds the runtime `supervisor_env`:
- the supervisor's own `TALKING_STICK_DATA_DIR`, for every worker, so its tt calls land in this
  room database;
- the endpoint and delivery token, for workers that can take a prompt.

Adapters start with only HOME and PATH (needed by native executables), then those references,
with protected supervisor values applied last. They never copy the daemon's whole environment,
so no inherited `TT_ROOM` or harness identity marker reaches the worker. Credential values are never stored. Hooks stay under the harness's own trust, and
nothing bypasses it.

The daemon and workers currently share an OS user. The human-only CLI checks and separate
control token prevent accidental cross-control; they do not prevent a worker deliberately
reading `<state>/control.token` and using it. The native workspace-write sandbox restricts writes
only, so it does not hide that readable file. Strong approval isolation needs a separate OS authority or
an authenticated human channel; do not treat this preview as that security boundary.

### Codex

The POSIX adapter owns a native `codex app-server --listen stdio://` process group. It resolves
an official npm wrapper to its native binary rather than recording the wrapper's PID. For a
version-manager or launchd environment with a minimal PATH, use explicit non-secret `PATH` and
`CODEX_EXECUTABLE` environment references; the latter names the absolute native executable.

By default it creates a private CODEX_HOME under `<state>/workers/<worker>/codex`.
It never copies credentials, user configuration, hooks or plugins there. Authenticate that home
separately, or explicitly reference a prepared CODEX_HOME. Missing authentication is visible as
`auth_required`, and the non-model probe detects a later login. Never put credentials in literals.
Workspace-write adds only the configured Talking Stick data directory to the native writable
roots and keeps network access disabled. Read-only workers may need human approval for their
room metadata writes. Returned sandbox and approval settings are checked before any prompt.

After registration the supervisor journals one enrolment prompt per native session: read the
skill, join the room, and wait without claiming work. It is not a keepalive. Resuming the same
session never repeats it. A failed or interrupted enrolment is held as `bootstrap_failed`;
a fresh restart creates a new conversation rather than replaying uncertain input. The enrolment
reservation and input journal commit atomically, including before any possible pipe write.

Input uses turn/start while idle and exact-turn turn/steer while busy. Interrupt success requires
a native interrupted completion, not merely an RPC acknowledgement. Command and file-change
approvals allow one request only; deny sends `decline`, which refuses that action and lets the
turn continue (`cancel` would also interrupt). Native resolution expires the pending occurrence,
including request ID 0. Unsupported tool-input, permission and plugin requests are refused and
audited, without leaving a synthetic input wait after the refusal.
Output is drained with bounded frames and queues; raw provider diagnostics are not logged.
When sandboxed `ps` cannot read a process start time, the supervisor writes private process
evidence before the handshake. The CLI fills only the missing start time of its already selected
PID, with matching endpoint and delivery-token hash. A stale or mismatched file leaves it unknown;
the file is removed on exit when possible, and a stale file cannot match a later generation's credential. This does not select a new PID or renew a room lease.
Native history remains in CODEX_HOME. Missing resume history holds the worker; no replacement
conversation is started implicitly. An idle thread that reports `notLoaded` or `thread/closed`
is resumed by exact ID in the same owned process during a non-model probe, with the same verified
permissions and no new prompt. A failed reload holds `resume_failed`; an unconfirmed active turn
or pending approval is held rather than resumed or replayed. Managed process groups on Windows
are not implemented yet.

Example setup from your own terminal (replace the paths):

```sh
# Authenticate an isolated prepared home; no credentials are copied by tt.
CODEX_HOME=/absolute/private/codex-home codex login
tt supervisor add coder --harness codex --cwd /absolute/repository \
  --sandbox workspace-write --approval on-request \
  --env CODEX_HOME=literal:/absolute/private/codex-home \
  --env CODEX_EXECUTABLE=literal:/absolute/native/codex \
  --env PATH=literal:/absolute/tt-bin:/usr/bin:/bin:/usr/sbin:/sbin
tt supervisor run
# Or install the macOS user service explicitly: tt supervisor install
```

The PATH must include `tt` and any tools the worker needs. A Node-linked development install
also needs Node; a standalone tt binary does not. No shell profile is sourced by launchd.

### Grok

All four Grok capabilities are false on every platform until each is proven safely. `start`
rejects a resume session instead of ignoring it, `probe` is the process plus `session/list`,
and the session id comes from `session/new`. A Grok worker never registers the supervisor
endpoint. It is reached only through its own `tt` calls.

- **How it runs:** `grok agent --no-leader stdio`. There is no `--always-approve`, `--plugin-dir`,
  `--debug`, or leader attach. A model flag is not passed.
- **Home:** `GROK_HOME` is always a private directory, mode 0700, at
  `<state>/workers/<worker>/grok`. A spec or inherited `GROK_HOME` is ignored. Nothing
  is copied into it, including `~/.grok/config.toml` and credentials, because the user config can
  set always-approve.
- **Environment:** the data directory, plus any explicit env refs. No supervisor endpoint or
  delivery token, and no inherited `TT_ROOM`, `GROK_AGENT`, or `GROK_SESSION_ID`.
  `--env XAI_API_KEY=keychain:SERVICE` is the supported way to name a credential. At start, tt
  reads that macOS generic-password item and places the value only in the child environment.
  A missing or unreadable item throws before the process is spawned. The error names
  `XAI_API_KEY` and does not include the secret or the Keychain tool's own text. tt does not
  create the item or answer a Keychain dialog. A resolved value has not been shown to make
  `session/new` succeed.
- **Handshake:** `initialize` (`protocolVersion` 1 and client info only; no file or terminal
  capabilities), then `session/new` with the working directory and an empty MCP server list.
  The session id is `result.sessionId`. A missing id, an authentication error, or any other
  handshake failure stops the child. `session/update` during setup is a notification, not a turn.
- **Later starts:** a recorded session holds `resume_failed`. `restart --fresh` is how an operator
  starts a new conversation. The adapter never calls `session/prompt`, `session/resume`, or
  `session/load`.
- **Input:** `submit` is rejected before any write. `interrupt` returns unsupported and sends
  nothing. `answerApproval` throws. A server request is refused with a JSON-RPC error and
  `request_refused`, and does not wait for input. A malformed line is an overflow and stops the
  child.
- **Liveness:** the process alone is not enough. `probe` is alive only when `session/list`
  names this worker's session id; an empty, other or unreadable list is unknown.
- **Approvals stay locked.** This adapter does not answer them.
- **Native evidence (grok 1.0.70, macOS, a disposable probe with an empty private home):**
  - `initialize` answers protocol version 1 with an `authMethods` list. The adapter never calls
    `authenticate`, so nothing starts a login.
  - `session/new` fails with -32000 "Authentication required". Grok writes its own `config.toml`,
    logs and session store into the private home, and no credentials are there.
  - `session/list` answers `{ sessions: [] }`, and EOF exits 0 within 3 seconds.
- **Without a resolved credential, no Grok worker stays up.** `session/new` fails as above, the
  child is stopped, and the worker is held `crash_loop` after five failures in 15 minutes. A
  Keychain reference that cannot be read fails earlier, before spawn, and follows the same
  crash backoff. Neither path is a proven login.

## State

### Where it lives

Supervisor-owned state lives in a protected root, `<state>`, outside the tt data directory, since
workers must be able to write the data directory for their own `tt` calls. That root holds the
database, control token, sockets, owner lock, logs, worker native homes and process evidence. A
gate helper, once one is installed, belongs there too.
- **Location:** `~/Library/Application Support/talking-stick/supervisor/<id>` on macOS, and
  `$XDG_STATE_HOME/talking-stick/supervisor/<id>` elsewhere, falling back to `~/.local/state`. An
  absolute `TT_SUPERVISOR_STATE_DIR` overrides the base, which tests use.
- **Identity:** `<id>` is the first 16 hex characters of the SHA-256 of the canonical data
  directory. Canonical means its nearest existing ancestor resolved through symlinks, plus the
  rest of the path. So aliases share one root, and one root never serves another directory:
  `root.json` records the data directory, and a mismatch is refused.
- **Socket length:** a root too long for its sockets (104 bytes on macOS) is refused, naming the
  override.
- **Reading creates nothing:** `status`, `approvals` and `logs` answer empty when there is no
  state. Only a writing command (`add`, `run` and the like) initializes a root.
- **One owner per data directory:** initializing or migrating writes `<data>/supervisor.root.json`,
  naming the root. With another base or HOME, every command refuses and names the
  `TT_SUPERVISOR_STATE_DIR` that finds it, rather than starting a second, empty supervisor. This
  guards against a changed environment, not a worker: the data directory is worker-writable.
- **launchd:** `install` writes the installed root's base into the agent's
  `TT_SUPERVISOR_STATE_DIR`, so the daemon launchd starts resolves that same root.

### Migration from the old layout

Older versions kept `<data>/supervisor.sqlite` (with `-wal` and `-shm`) beside the data, and
`<data>/supervisor/` for homes, evidence, logs, sockets and the token. While that database, or
`workers/` or `logs/` under that directory, exists,
every command except `migrate` and `uninstall` refuses and names `tt supervisor migrate`. That
includes reads, so nothing creates a new empty root that would hide the old state.

`tt supervisor migrate` is human-only. It refuses while the launchd agent is installed, because
launchd would restart a daemon on the old paths, and it takes both the old and the new owner
locks. Every attempt, a rerun after a crash included, refuses and moves nothing in two cases:
- Any recorded generation hasn't ended and its exact process is alive or unknown. A start intent
  with no pid or start time counts as unknown. A dead supervisor doesn't prove its children are
  dead, and a copy taken while one writes would lose what comes after. Stop it under the old
  supervisor; migration never kills or adopts one.
- A worker's native home (`workers/<worker>/codex` or `grok`) holds anything. A native session
  index may record absolute paths that a move would break, and relocating one is unproven.

Then it:
1. Copies the database as one consistent snapshot with `VACUUM INTO`, which includes rows still
   in the WAL. It runs SQLite's integrity check and compares every table's row count with the old
   database.
2. Copies `workers/` and `logs/` with their modes and timestamps, skipping sockets. The token,
   sockets and locks are made afresh by the next daemon.
3. Commits by writing `root.json`.
4. Moves the old files into `<data>/supervisor-legacy-<time>/`, keeping them rather than
   deleting them, and writes the owner marker with where they went. The old
   directory keeps only its held owner lock until then, so no older supervisor can start while
   its files move.

A journal in the root says a migration is in progress. It is trusted only if it names this root's
id, this data directory and a `supervisor-legacy-<time>` path inside it, and if any `root.json`
beside it was written by a migration. Whether the migration committed is `root.json`'s alone to
say: it is the single commit point, so no second write can disagree with it. Right after the
commit, and before any old file moves, the owner marker names the new root, so at every step
another base finds either the old state or the marker, never an empty data directory.
- **Interrupted before the commit:** a rerun discards that journal's own partial copy and starts
  over from the untouched old state.
- **Interrupted after the commit:** a rerun only finishes the moves. Tests crash it after each
  durable step and rerun it.
- **Never deleted or merged:** a root holding anything without a `root.json` or a valid journal
  is someone's state. Every command refuses it, and nothing is deleted. The same goes for state in
  both places. Either way, a human moves one aside. There is no reverse migration.

### The database

`<state>/supervisor.sqlite` (mode 0600) has its own migrations:

- `workers`: the spec, desired state (`running`, `paused`, `stopped`), `desired_version`, a hold
  reason, the next allowed start, and a one-shot fresh-start flag.
- `generations`: one row per started process, with its exact pid, start time, process group,
  native session id and observed state. The states are:
  - `starting`, `idle`, `busy`;
  - `awaiting_approval`, `awaiting_input`;
  - `disconnected`, `unknown`, `auth_required`;
  - `dead`.

  Model activity is kept here as `last_model_activity_at`, and never written to the room.
- `inputs`: every input, journalled before it is written and marked `dispatching` before the
  write is attempted. Inputs only move forward, through `written`, `queued`, `accepted` and
  `completed`, the last with the turn's outcome (`success`, `error` or `interrupted`).
  - `completed`, `rejected` and `uncertain` are final. A late `uncertain` or `rejected` result
    from `submit` can't undo a turn the worker reported starting.
  - When a generation ends, anything dispatched but not completed is uncertain, including an
    accepted turn whose completion is unknown. Only input never dispatched is rejected.
  - Input text is not stored.
- `approvals`: each request occurrence has its own `approval_id`.
  - Each keeps the whole native request as `detail`, with its SHA-256, beside a one-line summary.
    The detail is indented JSON. Every control, format (bidi marks and overrides included),
    separator and default-ignorable character is escaped, in the detail, the summary and the tool
    name alike, and the daemon escapes them again when it records a request. For Claude the detail
    is the very input an allow sends back. A request over 128 KiB is refused natively and
    never becomes pending, since no human could review it whole.
  - A native id may repeat across processes, like Codex's `0`, or within one generation once its
    earlier request settled. Each repeat is a new request.
  - A second request under an id that's still pending is a protocol error, and holds the worker.
  - The decision and the delivery of its answer are recorded separately, so a failed pipe write
    leaves the decision made and `answer_status` failed.
- `bootstrap_sessions`: the one enrolment input reserved per worker/native session, linked atomically
  to its journal row. Error, interruption or process death before successful completion holds
  `bootstrap_failed`, including after a daemon restart; it never causes automatic replay.
- `crashes`, and an `audit` log of every control action.

Supervisor migration 3 only adds the enrolment table; it does not change the room schema.
For rollback, stop the preview daemon first. Older builds leave the extra table and native
histories intact but cannot run this new adapter. Preserve CODEX_HOME when retaining a session.

## The reconcile loop

`src/supervisor/daemon.ts`:

- **One owner** per data directory: a lock file names the owner's exact process, and is taken
  over only once that process is gone. A daemon that can't read its own start time won't take
  ownership, and a recorded owner with no start time is never read as gone. Reapers are serialized by a guard directory, so two
  contenders never both take a dead owner's lock.
- **Startup reconciliation** is mandatory: the first tick refuses to run before it.
  - A recorded generation whose exact process is alive, or can't be read, holds its worker
    (`prior_generation_alive`, `prior_generation_unknown`), and the operator decides. So does a
    start intent with no recorded child.
  - A gone one is ended.
  - The supervisor never runs a second copy of a worker, or adopts a process it didn't record.
- **The tick** (every 30 s) compares desired and observed state. It starts, stops and probes.
  - Workers are reconciled independently, and each may hold up a tick for at most 15 s, so a hung
    handshake freezes no other worker.
  - An unknown probe is recorded as `unknown`, and the worker's reported state comes back once it
    reads alive.
  - Probes never prompt or write room presence. One initial, journalled enrolment prompt is the
    explicit exception when a new native session is ready; no model prompt is used as a heartbeat.
- **Restarts** back off from 5 s to 5 min. Five crashes in 15 minutes hold the worker
  (`crash_loop`). A restart resumes the recorded native session. If the adapter can't resume, or
  the resume fails, the worker is held (`resume_failed`) instead of starting a new conversation.
  Each start intent records the session it means to resume, so a retry after a failed attempt
  still resumes the original conversation. A configured `resume_session_id` seeds only the first
  start; after that the latest generation decides.
  An operator's restart stops the running generation and resumes its session. Only a fresh
  restart begins a new conversation.
- **When a generation ends**, its written inputs become `uncertain`, its pending approvals expire,
  and nothing carries over to the next generation. A new generation never inherits a writer
  lease: tt's own lease and guardian rules apply to each worker like any member.
- **Fencing:** every control change increments `desired_version`. A start that completes after a
  newer pause or stop stops the process it spawned.
- **Human override** always wins: `pause` and `stop` tear down the process group. They also
  refuse new input at once, before the next tick. A stop that fails is audited and retried, and
  never crashes the loop.

## Approvals and control

**Control is locked for now.** Every process of this user, supervised workers included, can read
the control token, so the token can't prove that a human sent a request. Until a verified
human-control boundary exists, the control socket refuses every change: `approve`, `deny` and
`interrupt`, and audits each refusal. `tt supervisor approve`, `deny`, `interrupt` and `reconcile`
refuse before connecting. So does the library's `reconcileManagedDelivery`, whatever `human:` id
its caller claims.

That means:
- A supervised worker that reads the token and uses it on its own pending request gets nothing.
- Pending approvals stay visible in `tt supervisor approvals`, each in full with `tt supervisor
  approvals show <approval-id>`, and expire after 24 hours as a deny.
- A possibly delivered message stays fenced, never resent.

### Human control

The control token only admits a request to the daemon. Whether it takes effect is up to a
`HumanGate` (`src/supervisor/human-gate.ts`), which the daemon asks to confirm that exact request.
The built-in gate is locked: it refuses everything and asks nothing. Nothing in the shipped build
selects another gate.

What the daemon does with a gate (`Supervisor.control`):
- **Before asking:** the request must name a pending approval of the running generation, or a
  running worker with a turn in progress for an interrupt, which is bound to that native turn. An approve or deny must also name the detail digest its requester
  reviewed (`tt supervisor approvals show`), in full or as a 12+ hex prefix. A row recorded without
  full detail is refused. None of these reach the gate.
- **The question:** the daemon builds it from its own records: action, tool, summary, worker,
  generation, approval id and digest, and the native turn for an interrupt, all escaped
  (`gateReason`). The requester supplies none of that text, except a note to the worker. That must
  be plain text of at most 300 characters, and it is shown in full before it is sent.
- **One at a time:** a second request while one waits is refused, not queued, so a worker can't
  slip its request in behind a human's. "Waits" lasts until the gate has really ended. A timed-out
  helper is sent SIGTERM, then SIGKILL two seconds later, and no new question starts while its
  dialog may still be up.
- **Fail closed:** a gate that throws, or doesn't answer within two minutes, is a refusal. An
  unavailable gate answers as locked.
- **After the answer:** the daemon checks the request again, the same pending approval, generation,
  worker handle and digest. If anything changed while the human was asked, such as the generation
  exiting or the harness settling the request, the confirmation applies to nothing. Settling is
  single-use, so a replay finds nothing pending.
- **Audit:** every outcome is recorded: confirmed, refused, unavailable, busy, or changed.

`reconcileManagedDelivery`, on the room side, stays locked whatever the gate says. A resend or
drop decision is not wired to a gate yet.

#### The mechanism, and its limits

These limits come from Apple's documentation and this codebase. No dialog was opened to find them.

- **Keychain item ACLs are not a human gate.** The candidate in the earlier design was a control
  item with an empty trusted-app list.
  - Apple's ACL documentation: an untrusted caller gets "Deny, Allow, or Always Allow", and Always
    Allow "adds the app to the list of trusted apps". The app here would be `/usr/bin/security` or
    the runtime, which a worker can run too, so one Always Allow click opens the item to every later
    caller, the worker included.
  - The dialog names the item and the calling app, not the request, so a human can't tell a
    worker's read from their own.
  - A token read once can be replayed until it is rotated.
  - Rotating the token per approval doesn't help either: the click proves that some read happened,
    not which approval it was for.
- **LocalAuthentication is the chosen mechanism.** `native/human-gate/main.swift` is a helper the
  daemon runs itself. It evaluates `deviceOwnerAuthentication` with the daemon's reason text, then
  exits 0 (confirmed), 3 (refused) or 2 (unavailable).
  - Each run uses a new `LAContext`, with `touchIDAuthenticationAllowableReuseDuration` set to 0.
    That is Apple's default: "Touch ID authentication isn't reused".
  - It invalidates the context afterwards. Apple: once invalidated, a context "cannot be used for
    policy evaluation".
  - There is no Always Allow, and the result never leaves the helper except as its exit status to
    the daemon. So a confirmation can't be carried to a different request, and nothing is replayed.
  - The dialog shows the daemon's reason, so a human reads what they would allow.
- **A worker can still ask.** It can send a control request with the token and make the dialog
  appear for its own pending request. The dialog then describes that request truthfully, and only
  a human's Touch ID or password confirms it. One question at a time limits how often it can ask.
  The dialog doesn't say who asked.
- **The boundary assumes workers can't change the supervisor.** That means its program,
  `dist/`, the helper, the launch agent plist or its data directory. A same-user process that can
  write those can replace the gate itself, and an unconfined same-user worker defeats any same-user
  gate.
- **Gate eligibility (`src/supervisor/eligibility.ts`).** A gate other than the locked one may
  act only while every live worker is provably unable to write what the gate rests on.
  - **Protected set:** the state root, the runtime the supervisor runs on (its real
    `process.execPath`), and the package it was loaded from, or the standalone root.
    - Every symlink under that package is followed to its target, since a linked dependency can
      live anywhere. A tree too large to walk is unresolved.
    - It also covers the launch agent plist with its directory, and the gate's own files, such as
      its helper.
    - It covers the startup closure of every configured worker, live, stopped or paused: its
      native executable, that executable's package root, and any explicitly prepared
      `CODEX_HOME`, whose config and hooks run at the next start outside any tool sandbox. One
      worker that can rewrite another's executable is as bad as one rewriting its own.
    - Anything unresolvable makes the gate ineligible. That includes a Keychain-held `PATH`,
      `CODEX_EXECUTABLE` or `CODEX_HOME`, and a harness that can't say what it would run.
  - **Confinement comes from the native process, never the spec.** Codex's `thread/start` and
    `thread/resume` return the effective sandbox. `workspaceWrite` covers the cwd, every
    `writableRoots` entry, `/tmp` unless `excludeSlashTmp`, and the child's `TMPDIR` unless
    `excludeTmpdirEnvVar`. `readOnly` writes nothing. `dangerFullAccess`, `externalSandbox`, or an
    incompletely described policy is unconfined. Claude and Grok report no confinement, so they are
    always ineligible.
  - **Conflict:** a writable root conflicts with a protected path when it is that path, an
    ancestor of it (which could replace it), or inside it. Both are compared as written and as
    resolved. The protected side is also compared through every symlink its resolution passes, so
    whoever can replace a link is caught. Containment is by path segment, so a child named
    `..x` is still inside. A path that can't be resolved, such as a symlink loop, counts as a conflict.
  - **Enforcement, only with a gate other than the locked one:** a worker found ineligible is
    stopped and held `gate_ineligible`.
    - **Before it spawns,** a worker is held if any live worker can write what it would run. That
      live worker is then held and stopped too, since it could replace that file for as long as it
      runs.
    - **Every tick,** each running worker is checked again against everything configured then.
    - **After it starts,** and whenever it reports a new confinement or a failed resume, it is
      checked again.
    - **During a thread open,** a resume included, the adapter counts as unconfined until Codex
      returns the new sandbox. That placeholder is never reported, so a pending open stops no one,
      and a control check meanwhile is refused. Every control request checks all live
    workers before asking and again after the answer, so a worker that becomes ineligible while
    the human is asked voids the confirmation. With no protected set, nothing is eligible.
  - **What this leaves out:** an approved escalation runs outside the sandbox, and a human
    approving one bypasses the boundary for that command. A Codex worker whose writable roots
    include the tt data directory is eligible only while no protected path lies under it, or
    under its cwd or `/tmp`. The state root therefore must not be under `/tmp`.
  - **Still needed before enabling anything:** an attended acceptance of the dialog on a
    confined, eligible fixture. Nothing in the shipped build selects a gate.
- **An attended acceptance shows only that the dialog works.** It doesn't show confinement, so
  it runs against a fixture that the eligibility check above passes.
- **Unproven until attended.** It hasn't been shown that a launchd user agent can present the
  LocalAuthentication dialog, or how it fails without a console session (`notInteractive` is
  mapped to unavailable).
  - The attended acceptance builds the helper (`swiftc -O native/human-gate/main.swift`).
  - It runs a daemon in a disposable data directory with the gate.
  - Wojtek confirms one approval. One worker request is refused, and a confirmation for one request
    is shown not to settle another.
  - Until it passes, the gate stays locked and the CLI refuses control before connecting.

Once control is unlocked: approvals stay pending and visible until a human decides. Unanswered ones expire after 24 hours,
as a deny. A decision names the full key (worker, generation, native id), and is refused unless
that exact generation is running and the request is still pending.

An operator harness may use the same audited commands: status, pause, resume, restart, stop,
interrupt and logs. It may decide approvals only under a human-authored policy file, scoped by
worker, tool and pattern, with an expiry. A role alone grants nothing.

Plugin installs are never a direct command. A request records the plugin, worker, source, the
exact command and its rollback, and runs only after a human confirms that exact request. There
are no permission self-grants. The supervisor restarts the operator harness too, when it is a
managed worker.

## Room bridge

### Delivery

Managed workers get a dedicated native wake transport, `supervisor`. The daemon listens on
`<state>/control.sock` (0600), and each generation gets a random delivery token that
the daemon stores hashed. A managed worker registers only that endpoint, never `codex_queue` or
`claude_inbox`, so nothing points the default Codex daemon at an owned server.

tt's existing wake policy decides when to deliver: directed messages, operator room messages
and handoffs. Never peer broadcasts or ticks. The daemon answers:

- `queued` (received, not turn-started), only after durably journalling the intake under the
  batch token;
- `failed`, for an unknown worker, a stale generation, a bad token, or a worker that can't take a
  prompt;
- `ambiguous`, if the socket breaks after the write.

It then submits the input as above. The model acknowledges with the envelope's `tt ack <token>`,
as with Claude's inbox, so the original batch token and event ids are preserved.

### Before-write fence

Before the daemon writes a managed envelope to a worker's pipe, it calls a scoped room
operation, `fenceManagedDelivery`. That operation checks the agent, session, the supervisor
endpoint of that exact generation, and the hashed delivery token. It then marks the original tt
batch `managed_writing`, committed before the write, and `managed_written` after it.

Both modes join tt's existing steering fences, so a new endpoint registration or a generation
change never re-offers that batch as fresh text. The fence is released only when:

1. the model acknowledges the original token;
2. there is evidence from before any write that nothing was written, which clears it to `unsent`
   so tt may re-offer it once;
3. a human runs `tt supervisor reconcile <batch> --resend|--drop`. Resending something whose
   effects are unknown needs explicit, scoped human authority, so this is locked until a verified
   human-control boundary exists (see "Approvals and control"). Until then a possibly delivered
   message stays fenced.

Fencing for writing also refuses a batch any of whose events is gone, already read, or held by
another managed batch, since its text would repeat that event. The batch is released unwritten,
and tt builds a new envelope from what remains unread. A crash between fence and write is held for
that decision. Intake that was journalled but never
fenced may be re-offered by tt: when the next generation registers its endpoint, tt wakes it for
unread work outside every fenced batch.

The daemon writes one worker's envelopes in order: it starts a turn when the worker is idle,
steers when a Codex worker is busy, and otherwise waits for the turn to end. An envelope whose
writing fence is refused is rejected without being written. Envelope text is kept only in memory.

Events in a fenced batch are left out of every later envelope, from a wake, a Codex or Grok
hook, or an interrupt, and a member whose only pending work is fenced isn't woken at all. A member with a supervisor endpoint has no other native
endpoint: registering the supervisor removes them, and registering another is refused. Its active
delivery hooks (Codex's UserPromptSubmit and Stop, Grok's tool hooks) return no envelopes, so
no room work bypasses the supervisor's journal. Lifecycle hooks are unaffected, and unsupervised
sessions behave as before.

The delivery token only fences and clears its own generation's batches. Control authority is
separate, and neither ever grants the other.

### Recovery of owned workers

The tick reads room state, read-only, for each owned worker's agent and session. When an owned
worker's native session is a lost member (see the reference's session lifecycle), the supervisor
performs the explicit recovery join:

- it presents the worker's own recovery credential, kept in that worker's private data;
- it proves the worker's exact process identity;
- it then re-registers the endpoint.

A resumed generation of a session also re-binds memberships still bound to an earlier generation:
- A present membership moves to the new process only with the session's own credential, in one
  room transaction (`rebindSupervisedMember`). The membership must still be exactly the one the
  supervisor read, and one removed meanwhile is never recreated. Only a replaced process's stick or
  reservation is released (`release`, reason `process_replaced`), never moved. The same process
  whose endpoint was lost keeps its turn.
- A membership lost before the crash is recovered through the room's rules. The supervisor first
  records the session start it observed through the protocol on that exact process, since a
  headless worker loads no user hooks.

Recovery necessarily records presence through that join, but it renews no lease, sends no prompt
and fabricates no model activity. It stops at `member_revoked`, and never acts for a session it
didn't start.

The daemon writes nothing while a worker waits for an approval or input, reads unknown,
disconnected or unauthenticated, or has a turn it didn't see start. A Codex turn is steered only
while the supervisor knows it's running.

## Commands

`tt supervisor` (usage in `tt help`) works on the data directory's supervisor.

`run` starts the daemon in the foreground:
- It takes the owner lock and reconciles, then ticks every 30 s.
- It opens two sockets in `<state>/`:
  - `intake.sock` takes tt deliveries only, and is the one workers are given.
  - `control.sock` takes control requests only, each with the daemon's control token. The token
    is new for each daemon, kept in the owner-only file `control.token`, and never put in a
    worker's environment.
- It writes its own log, `logs/daemon.log`, appending by path so rotation at 5 MB (three older
  files kept) takes effect at once.
- On SIGTERM it stops its workers' process groups; that's a stop, not a crash. Starts still in
  their handshake are cancelled. A failure at any point after taking ownership closes what was
  opened and releases the lock.

`install` and `uninstall` add and remove a macOS user agent that keeps `run` going, with a 077
umask. Only crash output that escapes the daemon goes to `logs/launchd.log`, rotated at each
start. The agent runs `node <package>/dist/cli.js supervisor run` under Node, or an installed
release's `<install-dir>/current/tt supervisor run`, which follows self-update.

`add <worker> --harness … --cwd …`:
- Codex needs an explicit `--sandbox` and `--approval`. Claude takes `--permission-mode
  default|plan`, and nothing that bypasses approvals.
- `--env NAME` passes the daemon's value through; `NAME=keychain:SERVICE` and
  `NAME=literal:VALUE` (for non-secret values) are explicit.
- There's no `--resume`: nothing here can prove an existing session isn't running elsewhere, so a
  worker resumes only sessions it started itself.

`status`, `approvals` (with `show <approval-id>` for one request's whole detail) and `logs` are
readable by anyone. Every other command is for a human until
a scoped operator policy exists:
- `run`, `add`, `pause`, `resume`, `stop`, `restart [--fresh]`, `remove` (only when stopped),
  `interrupt`, `approve`, `deny`, `reconcile <batch> --resend|--drop`, `install` and `uninstall`.
  launchd starts `run` with no harness around it.
- They refuse `--agent`, and refuse to run inside a harness session, detected from the environment
  and from process ancestry. Each is audited with its actor.
- The daemon checks the control token, and while control is locked refuses every change anyway
  (see "Approvals and control").

These guards keep an agent from acting as the operator through what it's given: its environment,
its endpoint, and its delivery token. They aren't a boundary against a same-user process that
deliberately reads the owner-only token file or hides its origin; supervised workers can do both.
That's why control stays locked until a verified boundary exists.

Codex and Claude are available on macOS and Linux. A Grok worker is attempted there. Without a
resolved credential, `session/new` fails and the worker is held `crash_loop`. An operator can name
`XAI_API_KEY` with `--env XAI_API_KEY=keychain:SERVICE`; a missing item fails before spawn, and a
resolved value is not a proven login (see "Grok").
A Grok session that was already recorded is held `resume_failed` until resume is proven. Plugin install requests are not implemented.

### Claude workers

- **How it runs:** a Claude worker runs `claude -p` in stream-json mode with the stdio
  permission tool, user settings excluded (`--setting-sources project,local`) and no MCP servers
  (`--strict-mcp-config`).
- **Session id:** a fresh conversation gets its session id up front (`--session-id`), so the
  supervisor knows it before the first turn; a restart resumes it with `--resume`.
- **Turns:** a turn starts at the worker's first output after a prompt and ends at its `result`.
  Claude takes no input mid-turn, so the supervisor never steers it and waits for the turn to
  end. A prompt whose write may have reached Claude keeps the turn until that result or the
  process's exit, so no second prompt can take its output. A turn counts as interrupted only when
  an interrupt was asked for and Claude ends it as an aborted stream; any other failure is an
  error.
- **Session check:** each turn's `init` and `result` name the session. One naming any other
  session is a protocol error: the supervisor holds the worker and stops it, and the running input
  stays unconfirmed.
- **Liveness:** the stream has no cheap ping, so liveness is the exact process.
- **Permissions:** every tool call that needs permission becomes a pending approval, and approvals
  are locked for now (see "Approvals and control"). So a Claude worker can only do what its
  project's own `.claude/settings.local.json` allows without asking. For room work, that's at least
  `Bash(tt:*)` and reading the talking-stick skill, `Read(//<skill dir>/**)`. Claude's rules spell
  an absolute path with a leading `//`. Grant nothing broader than the work needs.

## What the supervisor does not prove

A managed worker's wake and recovery are proven for processes the supervisor owns. They don't
show that an existing terminal session whose native conversation was unloaded gets woken
hands-free. That gap, from the membership recovery work, stays open, and neither the overnight
incident nor existing sessions are claimed solved by headless-worker tests.

For unsupervised Codex, Talking Stick queues the envelope once, then starts that stored queue
item only when a read of the exact thread says it is loaded and no turn is running. Both steps
use the same configured daemon socket. An unavailable or `notLoaded` thread remains `queued`,
not `woken`; neither process liveness nor queue acceptance proves model awareness.

The [App Server protocol](https://learn.chatgpt.com/docs/app-server) distinguishes a read-only
`thread/read` from `thread/resume`, which loads a saved thread and subscribes the requesting
client. The installed 0.163.0 schema exposes no resume or frontend-ownership option on
`thread/queue/add` or `thread/queue/start`. A local authenticated client can resume a saved
thread, but these interfaces alone do not establish that its existing TUI has reattached or
that the original approval and hook routes are still owned. Talking Stick therefore does not
resume or adopt an unsupervised session during delivery. A durable, session-owned reconnect
contract is still needed before claiming hands-free recovery of that case. No live session
was adopted or interrupted to test this boundary.

## Slices

| Slice | Owner | Contents | State |
| --- | --- | --- | --- |
| S2a1 | Claude | adapter types, state, reconcile loop, owner lock, FakeAdapter tests | merged (#203) |
| S2a2a | Claude | room side: the `supervisor` transport, `fenceManagedDelivery`, the managed fence modes, `reconcileManagedDelivery` | merged (#204) |
| S2a2b | Claude | supervisor side: the intake socket, fence-before-write, recovery of owned workers, end-to-end crash tests over both databases | merged (#206) |
| S2a3 | Claude | `tt supervisor` commands, launchd install/uninstall, logs | merged (#207) |
| S2b | Claude | Claude stream-json adapter | merged (#212) |
| S2c | Codex | Codex app-server adapter and shared process helpers | merged (#210) |
| S2a4 | Claude | human control: the `HumanGate` the daemon must pass, the LocalAuthentication helper, attack tests; locked until attended acceptance | merged (#216) |
| S2a5a | Claude | protected supervisor state: one resolver, a root outside the data directory, crash-safe `migrate` | merged (#218) |
| S2a5b | Claude | gate eligibility: effective native sandbox and roots, execution closure, canonical protected paths | this change |
| S2d | Grok | Grok stdio adapter (the proven subset only) | this change |
