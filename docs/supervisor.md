# Managed headless supervisor

Status: design agreed (room notes 2824973c, 01cd46da and 4ffa33a6, consolidated here). The core
(types, state, reconcile loop) is in `src/supervisor/`. The room bridge, CLI, launchd and the
harness adapters follow in later slices, and the "Slices" table says what exists.

The supervisor is optional. It starts Claude, Codex and Grok in their headless modes as
processes it owns, and keeps them running. It changes nothing for Herdr, tmux or terminal sessions,
and it never adopts or takes over a session it did not start. Process groups give it lifecycle
control only. They are not a security sandbox.

## Adapters

An adapter speaks one harness's headless protocol. The interface is `src/supervisor/adapter.ts`.

- `start(spec, generation)` spawns and handshakes. It never takes a prompt: the supervisor records
  the new generation's pid, process start time and process group, and subscribes to its events,
  before any input.
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
literals. Credential values are never stored. Hooks stay under the harness's own trust, and
nothing bypasses it.

### Grok

All four Grok capabilities are false until each is proven safely. `start` rejects a resume
session instead of ignoring it, `probe` is the process plus `session/list`, and the session id
comes from `session/new`. A Grok worker never registers the supervisor endpoint (below). It is
reached only through its own `tt` calls.

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
- `inputs`: every input, journalled before it is written. Inputs move through `journalled`,
  `written`, `accepted` and `completed`, or stop at `queued`, `rejected` or `uncertain`. Input
  text is not stored.
- `approvals`, keyed by worker, generation and native request id. Codex's id `0` is valid and
  repeats across processes.
- `crashes`, and an `audit` log of every control action.

## The reconcile loop

`src/supervisor/daemon.ts`:

- **One owner** per data directory: a lock file names the owner's exact process, and is taken
  over only once that process is gone.
- **Startup reconciliation** runs before anything is started. A recorded generation whose exact
  process is alive, or can't be read, holds its worker (`prior_generation_alive`,
  `prior_generation_unknown`), and the operator decides. A gone one is ended. The supervisor never
  runs a second copy of a worker, or adopts a process it didn't record.
- **The tick** (every 30 s) compares desired and observed state. It starts, stops and probes. It
  never prompts a worker, and never writes room presence.
- **Restarts** back off from 5 s to 5 min. Five crashes in 15 minutes hold the worker
  (`crash_loop`). A restart resumes the recorded native session. If the adapter can't resume, or
  the resume fails, the worker is held (`resume_failed`) instead of starting a new conversation.
  Only an operator's fresh restart does that.
- **When a generation ends**, its written inputs become `uncertain`, its pending approvals expire,
  and nothing carries over to the next generation. A new generation never inherits a writer
  lease: tt's own lease and guardian rules apply to each worker like any member.
- **Fencing:** every control change increments `desired_version`. A start that completes after a
  newer pause or stop stops the process it spawned.
- **Human override** always wins: `pause` and `stop` tear down the process group.

## Approvals and control

Approvals stay pending and visible until a human decides. Unanswered ones expire after 24 hours,
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
3. a human runs `tt supervisor reconcile <worker> <batch> --resend|--drop`, which is audited.
   Resending something whose effects are unknown needs explicit, scoped human authority.

A crash between fence and write is held for that decision. Intake that was journalled but never
fenced may be re-offered by tt.

The delivery token only fences and clears its own generation's batches. Control authority is
separate, and neither ever grants the other.

### Recovery of owned workers

The tick reads room state, read-only, for each owned worker's agent and session. When an owned
worker's native session is a lost member (see the reference's session lifecycle), the supervisor
performs the explicit recovery join:

- it presents the worker's own recovery credential, kept in that worker's private data;
- it proves the worker's exact process identity;
- it then re-registers the endpoint.

Recovery necessarily records presence through that join, but it renews no lease, sends no prompt
and fabricates no model activity. It stops at `member_revoked`, and never acts for a session it
didn't start.

## Slices

| Slice | Owner | Contents | State |
| --- | --- | --- | --- |
| S2a1 | Claude | adapter types, state, reconcile loop, owner lock, FakeAdapter tests | this change |
| S2a2 | Claude | `supervisor` transport, `fenceManagedDelivery`, recovery of owned workers, end-to-end crash tests over both databases | next |
| S2a3 | Claude | `tt supervisor` commands, launchd install/uninstall, logs | after S2a2 |
| S2b | Claude | Claude stream-json adapter | after S2a |
| S2c | Codex | Codex app-server adapter | after S2a |
| S2d | Grok | Grok stdio adapter (the proven subset only) | after S2a |
