# Headless rooms

Status: design agreed (Codex and Grok, room events #37712, #37716–#37719, room note b163f41b).
Slice H1 is built; the rest is planned. It supersedes the
[full headless roadmap](2026-10-26-full-headless-roadmap.md).

## Goal

An agent in any harness can spin up a room of headless agents for a task. They run on the
operator's own subscriptions, within limits the operator sets, and the operator can see the room
and talk to it in `tt chat`. `tt up`, Herdr and tmux panes, and terminal agents keep working
exactly as they do, with or without the daemon.

## Shape

`tt up --headless [dir] [--agents ...] --task TEXT|--stdin` is the same launch as `tt up`, but the
supervisor daemon owns the processes instead of Herdr panes. It:

1. runs `tt room ensure <dir>` and takes its `pin`;
2. starts the agents through the daemon, each with `TT_ROOM=<pin>`;
3. prompts each agent directly with the task. A room message is not a job: nobody in particular
   takes it.

`tt down --headless [dir]` stops that room's daemon-owned workers and leaves any console in place.
Any agent may call both, within a cap.

## Trust

There is no new trust mechanism.

- Headless agents run like `tt up` agents: your own harness config and subscription logins, with
  nothing private and nothing copied.
- The daemon doesn't mediate approvals. Each harness's own permission settings decide, and in
  headless mode an unapproved prompt is a deny.
- The start prompt passes trust along by stating the topology:
  - the room, its parent if any, and the agent's role;
  - who started the room, and the operator instruction it quotes, with its time and scope;
  - to report to the starter and stay inside the task.
- The local room database stays the boundary: membership, sticks and identity, as for every agent.

## Contracts

1. **Launch identity.** A managed launch has a stable identity, with its requested agents and
   task persisted. Capacity (pending plus running) is reserved atomically in the database. A retry
   returns the same launch, and adding workers is explicit. Accepted input that times out stays
   uncertain and is never replayed on restart.
2. **Ownership.**
   - Room-owned workers and their native generation bindings are durable.
   - `down` stops only daemon-owned workers, never terminal peers, and shows the stop and lease
     outcomes.
   - `TT_ROOM` is the ensure `pin` path, not a room id, and is injected through `supervisor_env`.
   - Room-bridge recovery is bound to the launch's room. Kick and revocation are kept, and
     recovery never reacquires a lease.
3. **Start prompt.** Exactly one per session (`claimBootstrap`): the task plus the topology, never
   the no-task text.
4. **Permissions.** The native deny handlers stay: Claude's `can_use_tool` and Codex's server
   requests are denied at once, with a visible outcome. No approve, deny, interrupt or reconcile
   control, and no control socket.
5. **Auth.** A worker signed in with an API key is held `wrong_auth_mode` rather than spending
   API funds, and credentials are never cleared. Whether several app-server processes can share
   one real home needs acceptance evidence before it is claimed.
6. **Grok.** `--headless` refuses Grok until its adapter reports `prompt: true`.
7. **TUI.** Spawning stays hidden or disabled until `/rooms` and `/go` show each state: starting,
   ready, blocked, auth required, partial, denied and down.

## Defaults and settings

Agents come from the existing launch defaults (`launch.json`, else the Claude and Codex pair). The
cap defaults to 3 headless rooms. It is changed only from a settings screen in `tt chat`, like
`/roles`, never by a harness and never by hand-editing a file.

## Coordinator

Any desktop or terminal agent can coordinate, using the `talking-stick-rooms` skill: `up`, `brief`,
`ask`, `replies` and `down`. It quotes the operator with the time and scope, never widens that
scope, and brings decisions back to the operator. Questions from visitors go to the room's
architect by default.

## Slices

| Slice | Contents | State |
| --- | --- | --- |
| H1 | Supervisor for trusted local use: real homes and settings, subscription logins only, `wrong_auth_mode`, prompts denied at once, with the gate, eligibility, control socket and Keychain references removed | built |
| H2 | `tt up --headless` and `tt down --headless`, the task start prompt and topology, launch identity and capacity, hidden until H3 | planned |
| H3 | Chat: the settings screen and headless state in `/rooms` and `/go`, which enables H2 | planned |
| H4 | Rooms skill: coordinating | planned |
