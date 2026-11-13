# Managed headless supervisor

Status: preview. The core, room bridge, CLI, launchd integration, and the Codex, Claude, and Grok
adapters are in `src/supervisor/`. The Grok adapter only attempts a fresh session and takes no
prompt yet. The "Slices" table records each slice. What comes next is
[headless rooms](plans/2026-11-13-headless-rooms.md): `tt up --headless`, so any agent can start a
room of headless agents for a task.

The supervisor is optional. It starts Claude, Codex and Grok in their headless modes as
processes it owns, and keeps them running. It changes nothing for `tt up`, Herdr, tmux or
terminal sessions, which work as before without it, and it never adopts or takes over a session
it did not start.

It is for trusted local use. Workers run as you, on your own harness logins and settings, the
same as the agents you start in a terminal: your subscriptions, never an API key. Process groups
give the supervisor lifecycle control only; they are not a security sandbox, and the local room
database is the coordination boundary, as it is for every other agent.

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
- `answerApproval(native_request_id, …)` answers on that handle's own generation only, and
  refuses an id the harness no longer has pending. The supervisor uses it to deny every
  permission prompt at once (see "Permission requests").
- `probe()` checks liveness without the model: the process, and a protocol ping where one exists.
- `stop(grace)`: stdin EOF, then the process group, then SIGKILL.
- Adapters drain the child's output continuously and bound their queues. An overflow of protocol
  events is reported as `overflow`, and the supervisor holds the worker. Events are never dropped.

### Permissions and environment

Workers use your own harness settings and logins, with these per-worker options on top:

| Harness | Permissions |
| --- | --- |
| Claude | `--permission-mode default` or `plan`, `--permission-prompt-tool stdio`, and your settings (`--setting-sources user,project,local`). Never `bypassPermissions` or `--dangerously-*`. |
| Codex | An explicit sandbox (`read-only` or `workspace-write`) and approval policy (`on-request` or `untrusted`) on each thread, in your `CODEX_HOME`. Never `never` or `danger-full-access`. |
| Grok | `grok agent --no-leader stdio` in your `GROK_HOME`. No leader attach, no plugin dir. |

A worker spec stores environment references only: names passed through from the supervisor's
own environment, and non-secret literals. No reference may name a model API key or provider
override (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY`, `GROK_API_KEY`,
their `_AUTH_TOKEN`, `_ADMIN_KEY` and `_BASE_URL` forms): `add` refuses one, and so does every
start. At each start the supervisor adds the runtime `supervisor_env`:
- the supervisor's own `TALKING_STICK_DATA_DIR`, for every worker, so its tt calls land in this
  room database;
- the endpoint and delivery token, for workers that can take a prompt.

Adapters start with only HOME and PATH (needed by native executables and their logins), then
those references, with protected supervisor values applied last. They never copy the daemon's
whole environment, so no inherited `TT_ROOM`, API key or harness identity marker reaches the
worker. Hooks stay under the harness's own trust, and nothing bypasses it.

**Subscriptions only, checked before any input.** A worker must show a subscription login
before it can take a prompt, so nothing ever spends API funds. Otherwise it is held, not
counted as a crash, and its credentials are left alone: `auth_required` when nobody is signed
in, `wrong_auth_mode` for anything else. An unreadable or unknown answer fails closed.
- Claude: before the worker's process starts, `claude auth status --json` runs with the same
  executable, environment and directory. Only `loggedIn` with `authMethod` `claude.ai` (or a
  `claude setup-token` subscription token, `oauth_token`) and `apiProvider` `firstParty` passes;
  an API key, an `apiKeyHelper`, Bedrock, Vertex or any other provider doesn't. Only the verdict
  is kept, never the identity. Each turn's `init` is checked again (`apiKeySource` must be `none`).
- Codex: `account/read` at start must report a `chatgpt` account. An API key, another provider
  that needs no OpenAI login, or an unknown account type is refused. No login at all waits as
  `auth_required` for one. The login is read again after a reload, and when an auth error
  appears.

### Codex

The POSIX adapter owns a native `codex app-server --listen stdio://` process group. It resolves
an official npm wrapper to its native binary rather than recording the wrapper's PID. For a
version-manager or launchd environment with a minimal PATH, use explicit non-secret `PATH` and
`CODEX_EXECUTABLE` environment references; the latter names the absolute native executable.

It runs in your own CODEX_HOME (`CODEX_HOME`, else `~/.codex`), with your config and your
ChatGPT subscription login, unless the spec names another with `--env CODEX_HOME=literal:…`.
Nothing is created or copied there. Missing authentication is visible as `auth_required`, and the
non-model probe detects a later login. Whether several app-server processes share one home's
login refresh safely hasn't been shown, so treat a shared home as an acceptance check.
Workspace-write adds only the configured Talking Stick data directory to the native writable
roots and keeps network access disabled. Read-only workers may need human approval for their
room metadata writes. Returned sandbox and approval settings are checked before any prompt.

After registration the supervisor journals one enrolment prompt per native session: read the
skill, join the room, and wait without claiming work. It is not a keepalive. Resuming the same
session never repeats it. A failed or interrupted enrolment is held as `bootstrap_failed`;
a fresh restart creates a new conversation rather than replaying uncertain input. The enrolment
reservation and input journal commit atomically, including before any possible pipe write.

Input uses turn/start while idle and exact-turn turn/steer while busy. Command and file-change
approval requests are denied at once with `decline`, which refuses that action and lets the turn
continue (`cancel` would also interrupt). Unsupported tool-input, permission and plugin requests
are refused and audited, without leaving a synthetic input wait after the refusal.
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
# Uses your own Codex login: run `codex login` once if you haven't.
tt supervisor add coder --harness codex --cwd /absolute/repository \
  --sandbox workspace-write --approval on-request \
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
- **Home:** your own `GROK_HOME` (`GROK_HOME`, else `~/.grok`), where `grok login` keeps your
  subscription login, unless the spec names another. Nothing is created or copied.
- **Environment:** the data directory, plus any explicit env refs. No supervisor endpoint or
  delivery token, and no inherited `TT_ROOM`, `GROK_AGENT`, or `GROK_SESSION_ID`. An
  `XAI_API_KEY` or `GROK_API_KEY` reference is refused.
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
- **Native evidence (grok 1.0.70, macOS, a disposable probe with an empty home):**
  - `initialize` answers protocol version 1 with an `authMethods` list. The adapter never calls
    `authenticate`, so nothing starts a login.
  - `session/new` fails with -32000 "Authentication required". Grok writes its own `config.toml`,
    logs and session store into the private home, and no credentials are there.
  - `session/list` answers `{ sessions: [] }`, and EOF exits 0 within 3 seconds.
- **Without a login in its home, no Grok worker stays up.** `session/new` fails as above, the
  child is stopped, and the worker is held `crash_loop` after five failures in 15 minutes. A
  subscription login in your own home hasn't been shown to pass `session/new` yet.

## State

### Where it lives

Supervisor-owned state lives in a root, `<state>`, outside the tt data directory. That root holds
the database, the intake socket, the owner lock, logs and process evidence. A `control.token`
left by an earlier version is removed when the daemon starts.
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
`<data>/supervisor/` for homes, evidence, logs, sockets and a token. While that database, or
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
  - `awaiting_approval` (from an earlier version), `awaiting_input`;
  - `disconnected`, `unknown`, `auth_required`, `wrong_auth_mode`;
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
- `approvals`: every permission request a worker made, and its denial. Each occurrence has its
  own `approval_id`.
  - A denial that can't be delivered, or isn't within 10 seconds, holds the worker
    `deny_undelivered` and stops it, since it may still be waiting on the prompt. Its turn is
    left uncertain and nothing is resent. A second request under an id whose denial is still on
    its way is a protocol error, and holds the worker.
  - Each keeps the whole native request as `detail`, with its SHA-256, beside a one-line summary.
    The detail is indented JSON. Every control, format (bidi marks and overrides included),
    separator and default-ignorable character is escaped, in the detail, the summary and the tool
    name alike, and the daemon escapes them again when it records a request. A request over
    128 KiB is refused natively without a row.
  - A native id may repeat across processes, like Codex's `0`, or within one generation once its
    earlier request settled. Each repeat is a new request.
  - The denial and the delivery of its answer are recorded separately, so a failed pipe write
    leaves the request denied and `answer_status` failed.
- `bootstrap_sessions`: the one enrolment input reserved per worker/native session, linked atomically
  to its journal row. Error, interruption or process death before successful completion holds
  `bootstrap_failed`, including after a daemon restart; it never causes automatic replay.
- `crashes`, and an `audit` log of every operator action and denial.

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
- **When a generation ends**, its written inputs become `uncertain`, any request still pending
  expires, and nothing carries over to the next generation. A new generation never inherits a writer
  lease: tt's own lease and guardian rules apply to each worker like any member.
- **Fencing:** every control change increments `desired_version`. A start that completes after a
  newer pause or stop stops the process it spawned.
- **Human override** always wins: `pause` and `stop` tear down the process group. They also
  refuse new input at once, before the next tick. A stop that fails is audited and retried, and
  never crashes the loop.

## Permission requests

Nobody sits at a headless worker's keyboard, so the supervisor doesn't redesign approvals. Each
harness's own settings decide what a worker may do without asking: your Claude settings and
project allow rules, and the Codex sandbox and approval policy. Anything that still asks is
denied at once, so a worker never waits on a prompt:

- The request is recorded in full (`tt supervisor approvals`, and `approvals show <id>` for the
  whole request), denied, and audited as `approval_denied`.
- Claude's worker gets a deny with a note saying nobody can approve prompts here, and to work
  within what its settings allow or ask the operator through the room. Codex gets `decline`.
- The denial is visible: `tt supervisor status` counts each worker's denied requests.

There is no approve, deny, interrupt or reconcile command and no control socket. Earlier versions
locked these behind a human gate that was never accepted; they were removed rather than kept
locked. To let a worker do more, allow it in that harness's own settings, as you would for a
terminal session.

Plugin installs are never a direct command, and there are no permission self-grants.

## Room bridge

### Delivery

Managed workers get a dedicated native wake transport, `supervisor`. The daemon listens on
`<state>/intake.sock` (0600), and each generation gets a random delivery token that
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
   so tt may re-offer it once.

Otherwise a possibly delivered message stays fenced and is never resent: nothing can prove its
effect didn't happen.

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

The delivery token only fences and clears its own generation's batches. It grants nothing else.

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
- It opens one socket, `<state>/intake.sock`, which takes tt deliveries only.
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
- `--env NAME` passes the daemon's value through; `NAME=literal:VALUE` is for non-secret values.
  A model API key or provider override is refused (see "Permissions and environment").
- There's no `--resume`: nothing here can prove an existing session isn't running elsewhere, so a
  worker resumes only sessions it started itself.

`status`, `approvals` (recent permission requests, with `show <approval-id>` for one request's
whole detail) and `logs` are readable by anyone. Every other command is for a human for now;
headless rooms will let agents start workers within limits the operator sets:
- `run`, `add`, `pause`, `resume`, `stop`, `restart [--fresh]`, `remove` (only when stopped),
  `install` and `uninstall`. launchd starts `run` with no harness around it.
- They refuse `--agent`, and refuse to run inside a harness session, detected from the environment
  and from process ancestry. Each is audited with its actor.
- `approve`, `deny`, `interrupt` and `reconcile` were removed; they answer with why.

These guards keep an agent from acting as the operator by accident. They aren't a security
boundary against a same-user process, and aren't meant to be.

Codex and Claude are available on macOS and Linux. A Grok worker is attempted there. Without a
login in its home, `session/new` fails and the worker is held `crash_loop` (see "Grok").
A Grok session that was already recorded is held `resume_failed` until resume is proven. Plugin install requests are not implemented.

### Claude workers

- **How it runs:** a Claude worker runs `claude -p` in stream-json mode with the stdio
  permission tool and your own settings, MCP servers and login (`--setting-sources
  user,project,local`).
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
- **Permissions:** a tool call your settings don't already allow is denied at once (see
  "Permission requests"). So a Claude worker can do what your user and project settings allow
  without asking. For room work, that's at least `Bash(tt:*)` and reading the talking-stick skill,
  `Read(//<skill dir>/**)`. Claude's rules spell an absolute path with a leading `//`.

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
| S2a5b | Claude | gate eligibility: effective native sandbox and roots, execution closure, canonical protected paths | merged (#219) |
| S2a6 | Claude | attended gate acceptance kit, with a scripted self-test in CI, and its launchd step; enables nothing | merged (#220, #222) |
| S2d | Grok | Grok stdio adapter (the proven subset only), Keychain env references | merged (#214, #215) |
| H1 | Claude | trusted local use: your own homes, settings and subscription logins; prompts denied at once; wrong_auth_mode; the gate, eligibility, control socket and Keychain references removed | this change |
