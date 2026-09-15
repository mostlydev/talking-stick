import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { ChatInputController } from "./chat-input.js";
import {
  ChatTranscript,
  renderChatScreen,
  diffChatFrame,
  completeChatInput,
  chatTranscriptHeight,
  CHAT_COMMANDS,
  type ChatFrame
} from "./chat-view.js";
import type { Readable, Writable } from "node:stream";

import { ProtocolError } from "../errors.js";
import { deriveHumanCliIdentity, type DerivedIdentity } from "../identity.js";
import {
  HUMAN_CHAT_SESSION_KIND,
  type EventType,
  type RoomEvent,
  type RoomMember
} from "../types.js";
import {
  buildNameResolver,
  formatChatEvent,
  formatChatAgent,
  parseChatInput,
  resolveChatRecipient,
  sanitizeChatText
} from "./chat-format.js";
import {
  getStringOption,
  hasOption,
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import type { Runtime } from "./runtime.js";

const DEFAULT_HISTORY = 20;
const HISTORY_SCAN_EVENTS = 500;
const DEFAULT_POLL_MS = 250;
const PRESENCE_REFRESH_MS = 30_000;
const STATUS_REFRESH_MS = 10_000;
const STATE_CHANGE_EVENTS = new Set<EventType>([
  "join",
  "leave",
  "kick",
  "session_superseded",
  "claim",
  "release",
  "pass",
  "takeover",
  "reservation_expired"
]);
const OWNERSHIP_EVENTS: EventType[] = ["claim", "takeover"];
const CONVERSATION_EVENTS: EventType[] = [
  "message_sent",
  "join",
  "leave",
  "kick",
  "close"
];

export interface ChatSessionOptions {
  runtime: Runtime;
  identity: DerivedIdentity;
  context_path: string;
  input: Readable;
  output: Writable;
  terminal: boolean;
  color: boolean;
  history: number;
  show_turn_events: boolean;
  poll_ms?: number;
  mouse?: boolean;
}

export async function handleChatCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const agentId = getStringOption(parsed, "agent");
  const identity = createChatIdentity(agentId);
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  await runChatSession({
    runtime,
    identity,
    context_path: parsed.positionals[0] ?? process.cwd(),
    input: process.stdin,
    output: process.stdout,
    terminal,
    color: terminal && !process.env.NO_COLOR,
    history: parseOptionalInteger(parsed, "history") ?? DEFAULT_HISTORY,
    show_turn_events: hasOption(parsed, "events"),
    mouse: !hasOption(parsed, "no-mouse")
  });
}

export function createChatIdentity(agentId?: string): DerivedIdentity {
  const identity = deriveHumanCliIdentity({
    agentId,
    displayName: agentId?.replace(/^[^:]+:/, ""),
    sessionKind: HUMAN_CHAT_SESSION_KIND
  });
  return {
    ...identity,
    agent_id: `${identity.agent_id}:chat:${randomUUID().slice(0, 8)}`
  };
}

// An operator console for a room: joins as a `human_chat` observer (never
// part of turn scheduling), prints recent conversation, then streams every
// room event as chat lines while reading messages from the input.
export async function runChatSession(
  options: ChatSessionOptions
): Promise<void> {
  const { runtime, identity, output, terminal } = options;
  const selfId = identity.agent_id;
  const joined = runtime.commands.joinPath(identity, {
    context_path: options.context_path
  });
  const roomId = joined.room_id;

  let members: RoomMember[] = [];
  let owner: string | null = null;
  let ownerSince: string | null = null;
  let reservedFor: string | null = null;
  let nameOf = buildNameResolver([selfId], selfId);
  let showTurnEvents = options.show_turn_events;
  let closed = false;
  let lastPresenceRefresh = 0;
  let namesSignature = "";
  let exitReason: string | null = null;

  const transcript = new ChatTranscript();
  let editor: ChatInputController | null = null;
  let rl: readline.Interface | null = null;
  let previousFrame: ChatFrame | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let screenActive = false;
  let failure: unknown;
  let hint: string | null = null;
  let lastStatusDraw = Date.now();
  const dimensions = () => ({
    columns: Math.max(1, (output as { columns?: number }).columns ?? 80),
    rows: Math.max(1, (output as { rows?: number }).rows ?? 24)
  });
  const formatContext = () => ({
    self_agent_id: selfId,
    name_of: nameOf,
    color: options.color,
    show_turn_events: showTurnEvents
  });
  const redraw = () => {
    if (!terminal || closed || frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (closed || !screenActive) return;
      try {
        const frame = renderChatScreen({
          transcript,
          format: formatContext(),
          status: {
            members,
            owner,
            owner_since: ownerSince,
            reserved_for: reservedFor,
            now: new Date()
          },
          draft: editor?.draft ?? { line: "", cursor: 0 },
          hint,
          ...dimensions()
        });
        output.write(diffChatFrame(previousFrame, frame));
        previousFrame = frame;
      } catch (error) {
        failure = error;
        stop();
      }
    }, 16);
  };
  const print = (text: string) => {
    if (terminal) {
      transcript.appendNotice(text);
      redraw();
    } else output.write(`${text}\n`);
  };
  const reportRoomClosed = () => {
    exitReason = "tt chat: the room has closed.";
    if (!terminal) print("The room has closed.");
  };
  const restore = () => {
    editor?.close();
    if (!screenActive) return;
    screenActive = false;
    output.write(
      "\u001b[?2026l\u001b[?1000l\u001b[?1006l\u001b[?2004l\u001b[?1049l\u001b[?25h"
    );
  };
  const stop = () => {
    if (closed && !screenActive && !rl) return;
    closed = true;
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = null;
    rl?.close();
    rl = null;
    restore();
  };
  const onResize = () => {
    editor?.resize(dimensions().columns - 1);
    previousFrame = null;
    redraw();
  };

  // getRoomState is a read RPC that also refreshes this observer's presence,
  // which keeps it addressable by agents replying with `tt msg send`.
  const refreshMembers = () => {
    const state = runtime.commands.getRoomState({
      room_id: roomId,
      agent_id: selfId,
      process_metadata: identity.process_metadata
    });
    members = state.members;
    if ((state.room.owner ?? null) !== owner) {
      ownerSince = null;
    }
    owner = state.room.owner ?? null;
    reservedFor = state.room.reserved_for ?? null;
    nameOf = buildNameResolver(
      [...members.map((member) => member.agent_id), selfId],
      selfId,
      new Map(
        members
          .filter(
            (member) =>
              member.agent_id.startsWith("human:") && member.display_name
          )
          .map((member) => [member.agent_id, member.display_name!])
      )
    );
    const signature = JSON.stringify(
      members
        .map((member) => ({
          id: member.agent_id,
          name: member.agent_id.startsWith("human:")
            ? member.display_name
            : null
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    );
    if (signature !== namesSignature) {
      namesSignature = signature;
      transcript.invalidate();
    }
    lastPresenceRefresh = Date.now();
  };

  const render = (event: RoomEvent) =>
    formatChatEvent(event, {
      self_agent_id: selfId,
      name_of: nameOf,
      color: options.color,
      show_turn_events: showTurnEvents
    });

  const coloredName = (agentId: string) =>
    formatChatAgent(
      {
        self_agent_id: selfId,
        name_of: nameOf,
        color: options.color,
        show_turn_events: showTurnEvents
      },
      agentId
    );

  const describeRoom = () => {
    const others = members.filter((member) => member.agent_id !== selfId);
    const who =
      others.length > 0
        ? others.map((member) => coloredName(member.agent_id)).join(", ")
        : "no agents yet";
    const stick = owner
      ? `${coloredName(owner)} has the stick`
      : "nobody has the stick";
    return `In the room: ${who} · ${stick}`;
  };

  const send = (to: string | null, body: string, interrupt: boolean) => {
    let targets: (string | null)[] = [null];
    if (to) {
      refreshMembers();
      const resolved = resolveChatRecipient(to, members, selfId);
      if ("error" in resolved) {
        print(`! ${sanitizeChatText(resolved.error)}`);
        return;
      }
      targets = resolved.agent_ids;
    }
    for (const toAgentId of targets) {
      void runtime.commands.sendMessageAndWake(identity, {
        room_id: roomId,
        body,
        to_agent_id: toAgentId,
        delivery_hint: interrupt ? "interrupt" : "normal"
      })
      .then((result) => {
        if (closed || !result.delivery_target) return;
        const state = result.delivery_status === "receiver" ? "listening" :
          result.delivery_state === "queued" || result.delivery_state === "woken" ? result.delivery_state :
          result.delivery_status === "pending" ? "pending" : "not listening";
        print(`${sanitizeChatText(nameOf(result.delivery_target))}: ${state}`);
      })
      .catch(() => { if (!closed) print("! Message delivery could not be confirmed."); });
    }
  };

  const runCommand = (name: string) => {
    switch (name) {
      case "quit":
      case "exit":
      case "q":
        stop();
        return;
      case "bottom":
        transcript.scrollToBottom();
        redraw();
        return;
      case "who":
        refreshMembers();
        print(describeRoom());
        return;
      case "events":
        showTurnEvents = !showTurnEvents;
        transcript.invalidate();
        print(`Stick events ${showTurnEvents ? "shown" : "hidden"}.`);
        return;
      case "help":
        print(HELP_TEXT);
        return;
      default:
        print(`! Unknown command /${name}. Try /help.`);
    }
  };

  // Messages are separated by a blank line; consecutive stick/membership
  // lines stay compact underneath the message they follow.
  let lastPrinted: "message" | "system" | "info" = "info";
  const printEvent = (event: RoomEvent) => {
    if (terminal) {
      transcript.appendEvent(event);
      if (
        event.event_type === "message_sent" &&
        event.to_agent_id === selfId &&
        event.from_agent_id !== selfId
      )
        output.write("\u0007");
      redraw();
      return;
    }
    const line = render(event);
    if (line === null) {
      return;
    }
    const isMessage = event.event_type === "message_sent";
    if (isMessage || lastPrinted === "message") {
      print("");
    }
    const forMe =
      isMessage &&
      event.to_agent_id === selfId &&
      event.from_agent_id !== selfId;
    print(forMe && terminal ? `${line}\u0007` : line);
    lastPrinted = isMessage ? "message" : "system";
  };

  const handleLine = (line: string) => {
    const parsed = parseChatInput(line);
    switch (parsed.kind) {
      case "empty":
        return;
      case "error":
        print(`! ${parsed.message}`);
        return;
      case "command":
        transcript.scrollToBottom();
        runCommand(parsed.name);
        return;
      case "send":
        transcript.scrollToBottom();
        send(parsed.to, parsed.body, parsed.interrupt);
        return;
    }
  };

  const submit = (line: string) => {
    try {
      handleLine(line);
    } catch (error) {
      if (isRoomGone(error)) {
        reportRoomClosed();
        stop();
      } else
        print(
          `! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`
        );
    }
    redraw();
  };
  const onSignal = () => stop();
  const onInterrupt = () => editor?.clear();
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  if (terminal) {
    process.on("SIGINT", onInterrupt);
    process.on("exit", restore);
    process.on("uncaughtExceptionMonitor", restore);
    output.on("resize", onResize);
  }
  try {
    if (terminal) {
      screenActive = true;
      output.write(
        "\u001b[?1049h\u001b[?2004h" +
          (options.mouse !== false ? "\u001b[?1000h\u001b[?1006h" : "")
      );
      editor = new ChatInputController({
        input: options.input,
        columns: dimensions().columns - 1,
        onChange: () => {
          if (editor?.draft.line) hint = null;
          redraw();
        },
        onSubmit: submit,
        onClear: () => {
          hint = "type /quit to exit";
        },
        onQuit: stop,
        onBottom: () => {
          transcript.scrollToBottom();
          redraw();
        },
        onScroll: (kind, amount) => {
          const { columns, rows } = dimensions();
          const draft = editor?.draft ?? { line: "", cursor: 0 };
          const height = chatTranscriptHeight({ draft, columns, rows });
          if (height === 0) return;
          transcript.scrollBy(
            amount * (kind === "pages" ? Math.max(1, height - 1) : 1),
            height,
            columns - 1,
            formatContext()
          );
          redraw();
        },
        complete: (draft) =>
          completeChatInput(
            draft,
            members
              .filter((member) => member.agent_id !== selfId)
              .flatMap((member) => [nameOf(member.agent_id), member.agent_id])
          )
      });
    } else {
      rl = readline.createInterface({ input: options.input, terminal: false });
      rl.on("line", submit);
      rl.on("close", () => {
        closed = true;
      });
    }
    refreshMembers();
    if (owner) {
      const [lastGrant] = runtime.commands.getRecentRoomEvents({
        room_id: roomId,
        limit: 1,
        event_types: OWNERSHIP_EVENTS
      });
      ownerSince =
        lastGrant?.to_agent_id === owner ? lastGrant.created_at : null;
    }
    print(`Talking Stick chat · ${sanitizeChatText(joined.canonical_path)}`);
    if (!terminal) {
      print(describeRoom());
    }
    print(
      "Type to message the room, @agent <text> to message matching agents, /help for commands."
    );

    const head = runtime.commands.getLatestEventSeq({ room_id: roomId });
    const historyEvents =
      options.history === 0
        ? []
        : runtime.commands
            .getRecentRoomEvents({
              room_id: roomId,
              limit: HISTORY_SCAN_EVENTS,
              event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
            })
            .filter(
              (event) => event.event_seq <= head && render(event) !== null
            )
            .slice(-Math.max(0, options.history));
    for (const event of historyEvents) {
      printEvent(event);
    }

    redraw();

    let cursor = head;
    while (!closed) {
      let result;
      try {
        result = await runtime.commands.waitForEvents({
          agent_id: selfId,
          room_id: roomId,
          after_event_seq: cursor,
          target_agent_id: "any",
          max_wait_ms: options.poll_ms ?? DEFAULT_POLL_MS
        });
      } catch (error) {
        if (error instanceof ProtocolError && error.code === "room_not_found") {
          reportRoomClosed();
          break;
        }
        throw error;
      }

      const stateChanged = result.events.some((event) =>
        STATE_CHANGE_EVENTS.has(event.event_type)
      );
      const statusStale = Date.now() - lastStatusDraw >= STATUS_REFRESH_MS;
      if (
        stateChanged ||
        statusStale ||
        Date.now() - lastPresenceRefresh >= PRESENCE_REFRESH_MS
      ) {
        refreshMembers();
      }
      for (const event of result.events) {
        if (OWNERSHIP_EVENTS.includes(event.event_type)) {
          ownerSince = event.created_at;
        }
        printEvent(event);
        if (event.event_type === "close") {
          reportRoomClosed();
          closed = true;
        }
      }
      cursor = result.cursor_event_seq;
      if ((stateChanged || statusStale) && !closed) {
        redraw();
        lastStatusDraw = Date.now();
      }
    }
    if (failure) throw failure;
  } catch (error) {
    if (!isRoomGone(error)) throw error;
    reportRoomClosed();
  } finally {
    output.off("resize", onResize);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("SIGINT", onInterrupt);
    process.off("exit", restore);
    process.off("uncaughtExceptionMonitor", restore);
    stop();
    if (terminal && exitReason) output.write(`${exitReason}\n`);
    await runtime.commands.flushWakes(roomId);
    try {
      runtime.commands.leaveRoom(identity, { room_id: roomId });
    } catch {
      // The room may already be gone; leaving is best-effort on exit.
    }
  }
}

const HELP_TEXT = [
  "Plain text broadcasts; @agent, <text> messages matching members.",
  ...CHAT_COMMANDS.map(
    (command) => `  ${command.usage} — ${command.description}`
  ),
  "PgUp/PgDn, Shift+↑/↓, mouse wheel: scroll messages. Ctrl+End: latest.",
  "Ctrl+C / Esc: clear draft. Ctrl+D on empty: quit. Tab: complete.",
  "Paste stays in the draft until Enter. //text sends a leading slash."
].join("\n");

function isRoomGone(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === "room_not_found";
}
