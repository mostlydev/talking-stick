# Harness controls and temporary shims

Compaction checked: 2026-10-24 (Codex 0.163.0). Other controls last checked:
2026-10-21. Revisit this register when upgrading a harness or adding a control.
A documented API is a candidate until it works against the installed version and
the exact target session in an isolated acceptance test.

For opted-in operator sessions outside rooms, see the
[desktop push design](plans/desktop-room-events.md), checked 2026-10-22. It distinguishes
OpenAI MCP Events, Claude inbox/Channels and exact-thread Codex control from generic
MCP notifications. None of the proposed observer bridge is implemented yet.

## Keep room views separate from agent context

`tt chat`'s `/clear` clears the human's pane and saves a per-room view marker. It
does not clear an agent's context, delete room events, or acknowledge messages.

Member context controls are a separate proposed capability layer; `/clear @agent`
and `/compact @agent` are not implemented by this change. Prefer a supported
external harness API, then a generic tmux terminal adapter. Herdr, cmux and hooks
are fallbacks for capabilities that lack a suitable native interface. Existing
`tt up` backend selection is unchanged: Herdr currently wins when both Herdr and
tmux context are present.

Do not send a slash command through an ordinary message or hook envelope and
assume the harness executed it. A terminal adapter must prove the exact session
and pane, and a ready composer with no approval or selection prompt. Unknown
status is not proof of readiness. Preserve an existing draft. A transport's
accepted submission is separate from the harness completing the action.

`compact` preserves a summary; resetting context starts fresh. A reset needs its
own explicit target and a room re-orientation/re-registration step because the
new chat may have a different session identity. Never broadcast a reset as a
side effect of clearing the operator console.

## Native controls to prefer

- Codex documents [`thread/compact/start`](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction).
  It returns immediately; completion is reported by the `contextCompaction` item
  lifecycle. In an isolated Codex 0.163.0 rehearsal, this compacted a live,
  idle daemon-backed TUI and preserved a remembered phrase. A read-only control
  connection received status changes but no item-completion event; history
  read-back proved a new completed turn containing a `contextCompaction` item.
  This is **not shipped** in tt: the same RPC accepted an active disposable
  thread and interrupted its running turn. An idle precheck has a race with
  incoming work, so it cannot enforce the required idle-only contract. A fresh
  `--no-daemon` TUI was also unreachable from the shared control socket
  (`thread/read`: not loaded; compaction: not found). Do not resume a stored
  copy and mistake it for control of the live TUI. Recheck when native compaction
  has an atomic idle/turn guard and can target locally owned TUI threads (#166).
- Codex's [`/clear`](https://learn.chatgpt.com/docs/developer-commands#built-in-slash-commands)
  resets both the terminal and chat context. It is not the same operation as
  clearing tt's room view, and thread deletion is not a substitute.
- Claude Code documents [`/clear` and `/compact`](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet).
  Whether the inbox socket executes these as commands or treats them as text is
  unverified. Test a disposable session before selecting that route.

## Register

| Capability | Current implementation | Replacement / recheck trigger |
| --- | --- | --- |
| cmux idle wake | [wake.ts](../src/wake.ts) sends text, then a separate Enter key. | A native submit/inbox operation that wakes the exact session. Check submission and receipt separately. |
| Codex wake | [native-wake.ts](../src/native-wake.ts) uses `codex queue`; [codex-queue-start.ts](../src/codex-queue-start.ts) nudges a stored queued submission when needed. | Recheck native thread submission and whether the queue drains automatically after interrupts. Remove the nudge when its regression passes without it. |
| Codex compaction | Not shipped; deferred after the isolated 0.163.0 rehearsal above. | Native expected-idle/turn guard, plus verified control of `--no-daemon` TUI context. RPC acceptance or a cached daemon thread is insufficient. |
| Codex interrupt | [codex-interrupt.ts](../src/cli/codex-interrupt.ts) uses the control API; [codex-herdr-interrupt.ts](../src/cli/codex-herdr-interrupt.ts) sends Escape to a verified Herdr/tmux pane for a locally owned TUI turn. | Native `turn/interrupt` reaching locally owned turns too. Check `--no-daemon` separately from daemon-managed sessions. |
| Claude interrupt | [chat-interrupt.ts](../src/cli/chat-interrupt.ts) and [interrupt-hook.ts](../src/cli/interrupt-hook.ts) use a file flag consumed by hooks. | A supported external abort that interrupts an active tool, not just a priority inbox message. |
| Claude message delivery | [native-wake.ts](../src/native-wake.ts) uses the harness-provided inbox socket and token. | Recheck official inbox capabilities, lifecycle guarantees and command handling. Native delivery does not establish slash-command support. |
| Grok identity and active-turn delivery | [grok-session-hook.ts](../src/cli/grok-session-hook.ts) captures session identity; [grok-inbox-hook.ts](../src/cli/grok-inbox-hook.ts) supplies active-turn events. | Stable exported session identity and a native session inbox/idle wake API. Verify idle and active delivery independently. |
| Terminal backend adaptation | [pane-backend.ts](../src/pane-backend.ts) and [tmux.ts](../src/tmux.ts) adapt a Herdr-shaped runner to tmux. | Give future harness controls their own small capability interface; do not require a particular multiplexer command vocabulary. |
| Native pin dismissal | [herdr-plugin.ts](../src/herdr-plugin.ts) routes an OSC 8 HTTPS link to the exact console. `/ack` remains portable. | Recheck generic terminal click callbacks or supported custom schemes. This is a view feature, not an agent-control dependency. |
| Native scroll observation | [native-scroll.ts](../src/cli/native-scroll.ts) subscribes to Herdr pane scroll metrics. Other terminals retain eviction-based pinning. | A portable viewport/scroll event interface. Keep manual-scroll detection optional rather than enabling mouse capture. |

For each replacement, record the tested harness version and interface, exercise
idle and busy sessions plus ambiguous failures, and update this table in the
same PR. Never test clear/reset against a live working member merely to probe
support.
