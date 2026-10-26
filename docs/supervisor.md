# Managed headless supervisor

Status: design agreed (room notes 2824973c, 01cd46da and 4ffa33a6, consolidated here). The core, room bridge, CLI, launchd integration, and the Codex, Claude, and Grok adapters are in `src/supervisor/`.
The Grok adapter only attempts a fresh session, which needs credentials it doesn't have yet. The "Slices" table records each slice.

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
| Grok | `grok agent --no-leader stdio` with a private `GROK_HOME`. The user's config is never copied, since it may set always-approve. No leader attach, no plugin dir. |

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
reading `<data>/supervisor/control.token` and using it. The native workspace-write sandbox does
not isolate that readable directory. Strong approval isolation needs a separate OS authority or
an authenticated human channel; do not treat this preview as that security boundary.

### Codex

The POSIX adapter owns a native `codex app-server --listen stdio://` process group. It resolves
an official npm wrapper to its native binary rather than recording the wrapper's PID. For a
version-manager or launchd environment with a minimal PATH, use explicit non-secret `PATH` and
`CODEX_EXECUTABLE` environment references; the latter names the absolute native executable.

By default it creates a private CODEX_HOME under `<data>/supervisor/workers/<worker>/codex`.
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
  `<data>/supervisor/workers/<worker>/grok`. A spec or inherited `GROK_HOME` is ignored. Nothing
  is copied into it, including `~/.grok/config.toml` and credentials, because the user config can
  set always-approve.
- **Environment:** the data directory only. No supervisor endpoint or delivery token, and no
  inherited `TT_ROOM`, `GROK_AGENT`, or `GROK_SESSION_ID`.
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
- **So no Grok worker starts today.** Each attempt fails at `session/new`, backs off, and the
  worker is held `crash_loop` after five failures in 15 minutes. Giving the private home
  credentials, such as an `XAI_API_KEY` environment reference, is not proven or supported yet.

## State

`<data>/supervisor.sqlite` (mode 0600) has its own migrations:

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
- Pending approvals stay visible in `tt supervisor approvals`, and expire after 24 hours as a deny.
- A possibly delivered message stays fenced, never resent.

The candidate boundary is a login-Keychain control item with an empty trusted-app list, so reading
it takes the macOS authorization dialog, a human's click. It would be recreated at each daemon
start and rotated after every approval, with no token file. It needs an attended acceptance; the
alternative is running workers as a separate macOS user.

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
`<data>/supervisor/control.sock` (0600), and each generation gets a random delivery token that
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
- It opens two sockets in `<data>/supervisor/`:
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

`status`, `approvals` and `logs` are readable by anyone. Every other command is for a human until
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

Codex and Claude are available on macOS and Linux. A Grok worker is attempted there, but without
credentials in its private home it fails at `session/new` and is held `crash_loop` (see "Grok").
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

## Slices

| Slice | Owner | Contents | State |
| --- | --- | --- | --- |
| S2a1 | Claude | adapter types, state, reconcile loop, owner lock, FakeAdapter tests | merged (#203) |
| S2a2a | Claude | room side: the `supervisor` transport, `fenceManagedDelivery`, the managed fence modes, `reconcileManagedDelivery` | merged (#204) |
| S2a2b | Claude | supervisor side: the intake socket, fence-before-write, recovery of owned workers, end-to-end crash tests over both databases | merged (#206) |
| S2a3 | Claude | `tt supervisor` commands, launchd install/uninstall, logs | merged (#207) |
| S2b | Claude | Claude stream-json adapter | merged (#212) |
| S2c | Codex | Codex app-server adapter and shared process helpers | merged (#210) |
| S2d | Grok | Grok stdio adapter (the proven subset only) | this change |
