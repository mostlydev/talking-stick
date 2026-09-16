import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { ChatInputController } from "./chat-input.js";
import { resolveChatKick } from "./chat-kick.js";
import {
  ChatTranscript,
  renderChatScreen,
  diffChatFrame,
  getChatCompletions,
  formatChatHelp,
  CHAT_PROMPT,
  chatTranscriptHeight,
  chatWheelRegion,
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
  chatSectionLabel,
  startsChatConversation,
  isChatConversationActivity,
  formatChatAgent,
  describeMemberState,
  parseChatInput,
  resolveChatRecipients,
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
const RECEIPT_POLL_MS = 1_000;
const RECEIPT_BATCH = 200;
const MAX_AWAITED_RECEIPTS = 1_000;
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
  // Inline mode prints into the terminal's normal screen instead of taking it
  // over, so the terminal (or multiplexer) keeps scrollback, selection, and
  // copy. The pinned full-screen layout stays available behind --fullscreen.
  inline?: boolean;
}

// Inline is the default: a full-screen pane has no scrollback, so a terminal
// or multiplexer can neither scroll nor select it. --fullscreen keeps the
// pinned layout for anyone who prefers it.
export function chatInlineEnabled(parsed: ParsedCommand): boolean {
  return !hasOption(parsed, "fullscreen");
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
    mouse: hasOption(parsed, "mouse") && !hasOption(parsed, "no-mouse"),
    inline: chatInlineEnabled(parsed)
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
  const fullscreen = terminal && options.inline !== true;
  const inline = terminal && !fullscreen;
  const selfId = identity.agent_id;
  const joined = runtime.commands.joinPath(identity, {
    context_path: options.context_path
  });
  const roomId = joined.room_id;

  // Agents seen leaving, so addressing one explains why it can't be reached.
  const departedAgents = new Set<string>();
  let members: RoomMember[] = [];
  let owner: string | null = null;
  let ownerSince: string | null = null;
  let reservedFor: string | null = null;
  let nameOf = buildNameResolver([selfId], selfId);
  let showTurnEvents = options.show_turn_events;
  let closed = false;
  let lastPresenceRefresh = 0;
  let namesSignature = "";
  let historyBefore: string | undefined;
  let historyCursor = 0;
  let historyExhausted = false;
  let previousConversationEvent: RoomEvent | undefined;
  let printedSection: string | undefined;
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
    show_turn_events: showTurnEvents,
    now: new Date(),
    history_before: historyBefore
  });
  const completionsFor = (draft: { line: string; cursor: number }) => getChatCompletions(draft,
    members.filter((member) => member.agent_id !== selfId && member.process_liveness !== "gone")
      .flatMap((member) => [nameOf(member.agent_id), member.agent_id]),
    members.filter((member) => member.agent_id !== selfId && member.session_kind !== HUMAN_CHAT_SESSION_KIND)
      .sort((a, b) => Number(b.process_liveness === "gone") - Number(a.process_liveness === "gone") || a.agent_id.localeCompare(b.agent_id))
      .map((member) => ({ agent_id: member.agent_id, name: member.display_name || nameOf(member.agent_id),
        status: member.process_liveness === "gone" ? "ended" : describeMemberState(member, {
          members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(), columns: dimensions().columns
        }) })));
  // Inline output must not land on top of the readline prompt: clear the
  // prompt row, print, then let readline redraw its line.
  const writeInline = (text: string) => {
    output.write(`\r\u001b[2K${text}\n`);
    rl?.prompt(true);
  };
  const redraw = () => {
    if (!fullscreen || closed || frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (closed || !screenActive) return;
      try {
        const frame = renderChatScreen({
          room_path: joined.canonical_path,
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
          completions: editor?.completionVisible ? completionsFor(editor.draft) : [],
          completion_index: editor?.completionIndex ?? 0,
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
  const print = (text: string): number | null => {
    if (inline) {
      writeInline(text);
      return null;
    }
    if (fullscreen) {
      const id = transcript.appendNotice(text);
      redraw();
      return id;
    }
    output.write(`${text}\n`);
    return null;
  };
  // Directed messages whose recipient hasn't received them yet, keyed by event
  // seq. A receipt means the recipient's own tt wait returned the message.
  const awaitingReceipt = new Map<number, { notice: number | null; text: string }>();
  let lastReceiptCheck = 0;
  const trackReceipt = (eventSeq: number, pending: { notice: number | null; text: string }) => {
    awaitingReceipt.set(eventSeq, pending);
    // Oldest first: a recipient that never reads can't grow this without bound.
    while (awaitingReceipt.size > MAX_AWAITED_RECEIPTS) {
      awaitingReceipt.delete(awaitingReceipt.keys().next().value!);
    }
  };
  const checkReceipts = () => {
    if (awaitingReceipt.size === 0 || Date.now() - lastReceiptCheck < RECEIPT_POLL_MS) return;
    lastReceiptCheck = Date.now();
    const seqs = [...awaitingReceipt.keys()];
    const receipts = [];
    for (let start = 0; start < seqs.length; start += RECEIPT_BATCH) {
      receipts.push(...runtime.commands.getMessageReceipts({
        room_id: roomId,
        event_seqs: seqs.slice(start, start + RECEIPT_BATCH)
      }));
    }
    for (const receipt of receipts) {
      const pending = awaitingReceipt.get(receipt.event_seq);
      if (!pending) continue;
      awaitingReceipt.delete(receipt.event_seq);
      const text = `${sanitizeChatText(nameOf(receipt.agent_id))}: received`;
      if (pending.notice !== null && transcript.updateNotice(pending.notice, `${pending.text} → received`)) {
        redraw();
      } else {
        print(text);
      }
    }
  };
  const reportRoomClosed = () => {
    exitReason = "tt chat: the room has closed.";
    if (!fullscreen) print("The room has closed.");
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

  const render = (event: RoomEvent) => formatChatEvent(event, formatContext());

  const scrollHistory = (amount: number) => {
    const { columns, rows } = dimensions();
    const draft = editor?.draft ?? { line: "", cursor: 0 };
    const height = chatTranscriptHeight({ draft, columns, rows, room_path: joined.canonical_path });
    if (!height) return;
    if (transcript.following && transcript.oldestEventSeq !== undefined) {
      historyCursor = transcript.oldestEventSeq;
      historyExhausted = false;
    }
    if (amount < 0 && !historyExhausted && transcript.needsEarlier(amount, height, columns - 1, formatContext())) {
      // Skip pages containing only hidden system events, but bound the work
      // per keystroke. A later upward scroll continues from the saved cursor.
      for (let page = 0; page < 10 && !historyExhausted; page++) {
        const earlier = runtime.commands.getRecentRoomEvents({
          room_id: roomId, limit: 100, before_event_seq: historyCursor,
          event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
        });
        if (earlier.length === 0) { historyExhausted = true; break; }
        historyCursor = earlier[0].event_seq;
        historyExhausted = earlier.length < 100;
        const visible = earlier.filter((event) => render(event) !== null);
        transcript.prependEvents(visible, height, columns - 1, formatContext());
        if (visible.length) break;
      }
    }
    transcript.scrollBy(amount, height, columns - 1, formatContext());
    redraw();
  };

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
    const present = others.filter((member) => member.process_liveness !== "gone");
    const ended = others.filter((member) => member.process_liveness === "gone");
    const who =
      present.length > 0
        ? present.map((member) => coloredName(member.agent_id)).join(", ")
        : "no agents yet";
    const stick = owner
      ? `${coloredName(owner)} has the stick`
      : "nobody has the stick";
    const endedNote =
      ended.length > 0
        ? ` · ended: ${ended.map((member) => coloredName(member.agent_id)).join(", ")}`
        : "";
    return `In the room: ${who} · ${stick}${endedNote}`;
  };

  const send = (to: string[], body: string, interrupt: boolean) => {
    let targets: (string | null)[] = [null];
    if (to.length > 0) {
      refreshMembers();
      const resolved = resolveChatRecipients(to, members, selfId);
      if ("error" in resolved) {
        const departed = [...departedAgents].filter((agentId) =>
          resolved.unmatched.some(
            (selector) =>
              agentId.toLowerCase().startsWith(selector) ||
              nameOf(agentId).toLowerCase().startsWith(selector)
          )
        );
        print(
          departed.length > 0
            ? `! ${sanitizeChatText(departed.map((agentId) => nameOf(agentId)).join(", "))} left the room and can't receive messages until it rejoins.`
            : `! ${sanitizeChatText(resolved.error)}`
        );
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
          result.delivery_status === "pending" ? "waiting for agent to read" :
          result.delivery_state === "queued" && result.interrupt_status === "unsupported" ? "queued; immediate interrupt unavailable" :
          result.delivery_state === "queued" && result.interrupt_status === "injected" ? "urgent prompt injected" :
          result.delivery_state === "queued" || result.delivery_state === "woken" ? result.delivery_state :
          result.delivery_state === "ambiguous" ? "wake unconfirmed" :
          "not listening";
        const text = `${sanitizeChatText(nameOf(result.delivery_target))}: ${state}`;
        const notice = print(text);
        const received = runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: [result.event_seq] });
        if (received.length > 0) {
          if (notice !== null) transcript.updateNotice(notice, `${text} → received`);
          else print(`${sanitizeChatText(nameOf(result.delivery_target))}: received`);
          redraw();
        } else {
          trackReceipt(result.event_seq, { notice, text });
        }
      })
      .catch(() => { if (!closed) print("! Message delivery could not be confirmed."); });
    }
  };

  const runCommand = (name: string, args = "") => {
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
      case "kick": {
        refreshMembers();
        const { target, force, reason } = resolveChatKick(args, members, selfId);
        let ownershipNote = "";
        try {
          const result = runtime.commands.kickMember(identity, { room_id: roomId, target_agent_id: target.agent_id, force, reason });
          if (result.target_was_owner) ownershipNote = " Its turn was revoked.";
          else if (result.target_was_reserved_for) ownershipNote = " Its next-turn reservation was cleared.";
        } catch (error) {
          if (error instanceof ProtocolError && error.code === "target_active") {
            const state = target.process_liveness === "alive" ? "is still running" :
              target.process_liveness === "gone" ? "has just ended; the liveness grace period has not elapsed" : "is not confirmed ended";
            print(`! ${sanitizeChatText(target.agent_id)} ${state}. Use /kick --force ${sanitizeChatText(target.agent_id)} to remove it from the room.`);
            return;
          }
          throw error;
        }
        refreshMembers();
        print(`Removed ${sanitizeChatText(target.agent_id)} from the room.${ownershipNote} The harness was not stopped.`);
        return;
      }
      case "events":
        showTurnEvents = !showTurnEvents;
        transcript.invalidate();
        print(`Stick events ${showTurnEvents ? "shown" : "hidden"}.`);
        return;
      case "help":
        print(formatChatHelp(dimensions().columns - 1, options.color, args.trim() === "keys"));
        return;
      default:
        print(`! Unknown command /${name}. Try /help.`);
    }
  };

  // Messages are separated by a blank line; consecutive stick/membership
  // lines stay compact underneath the message they follow.
  let lastPrinted: "message" | "system" | "info" = "info";
  const printEvent = (event: RoomEvent) => {
    if (render(event) !== null && isChatConversationActivity(event)) {
      if (startsChatConversation(previousConversationEvent, event) &&
          (!historyBefore || Date.parse(event.created_at) > Date.parse(historyBefore))) {
        historyBefore = event.created_at;
        transcript.invalidate();
      }
      previousConversationEvent = event;
    }
    if (event.event_type === "leave" && event.from_agent_id) {
      departedAgents.add(event.from_agent_id);
    } else if (event.event_type === "kick" && event.to_agent_id) {
      departedAgents.add(event.to_agent_id);
    } else if (event.event_type === "join" && event.from_agent_id) {
      departedAgents.delete(event.from_agent_id);
    }
    if (fullscreen) {
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
    const section = chatSectionLabel(event, formatContext());
    if (section !== printedSection) {
      print(`── ${section} ──`);
      printedSection = section;
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
        runCommand(parsed.name, parsed.args);
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
  if (fullscreen) {
    process.on("SIGINT", onInterrupt);
    process.on("exit", restore);
    process.on("uncaughtExceptionMonitor", restore);
    output.on("resize", onResize);
  }
  try {
    if (fullscreen) {
      screenActive = true;
      output.write(
        "\u001b[?1049h\u001b[?2004h" +
          (options.mouse === true ? "\u001b[?1000h\u001b[?1006h" : "")
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
          const height = chatTranscriptHeight({ draft, columns, rows, room_path: joined.canonical_path });
          if (height === 0) return;
          scrollHistory(amount * (kind === "pages" ? Math.max(1, height - 1) : 1));
        },
        onWheel: (row, direction) => {
          const size = dimensions();
          const draft = editor?.draft ?? { line: "", cursor: 0 };
          const layout = { ...size, draft, room_path: joined.canonical_path };
          const region = chatWheelRegion(layout, row);
          if (region === "prompt") editor?.scrollPrompt(direction);
          else if (region === "transcript") {
            scrollHistory(direction * 3);
          }
          redraw();
        },
        completionCount: (draft) => completionsFor(draft).length,
        complete: (draft, index) => {
          const matches = completionsFor(draft);
          return matches[Math.min(index, matches.length - 1)]?.draft ?? null;
        }
      });
    } else if (inline) {
      // The terminal keeps its normal screen: readline owns one prompt row,
      // messages print above it, and scrollback/selection stay native.
      rl = readline.createInterface({
        input: options.input,
        output,
        terminal: true,
        prompt: `${CHAT_PROMPT}`,
        historySize: 100,
        completer: (line: string): [string[], string] => {
          const matches = completionsFor({ line, cursor: line.length });
          return [matches.map((match) => match.draft.line), line];
        }
      });
      rl.on("line", (line) => {
        submit(line);
        if (!closed) rl?.prompt();
      });
      rl.on("SIGINT", () => {
        rl?.write(null, { ctrl: true, name: "u" });
        rl?.prompt(true);
      });
      rl.on("close", () => {
        closed = true;
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
    if (!fullscreen) {
      print(describeRoom());
    }
    print(
      "Type to message the room, @agent anywhere in the text to message matching agents, /help for commands."
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
    historyCursor = historyEvents[0]?.event_seq ?? head + 1;
    // Determine the latest conversation before rendering so its predecessor
    // is dimmed even on the first frame (including non-terminal output).
    const conversationEvents = historyEvents.filter(isChatConversationActivity);
    for (let index = 1; index < conversationEvents.length; index += 1) {
      if (startsChatConversation(conversationEvents[index - 1], conversationEvents[index])) {
        historyBefore = conversationEvents[index].created_at;
      }
    }
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
      if (!closed) checkReceipts();
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
    if (fullscreen && exitReason) output.write(`${exitReason}\n`);
    else if (inline && exitReason) output.write(`\r\u001b[2K${exitReason}\n`);
    await runtime.commands.flushWakes(roomId);
    try {
      runtime.commands.leaveRoom(identity, { room_id: roomId });
    } catch {
      // The room may already be gone; leaving is best-effort on exit.
    }
  }
}


function isRoomGone(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === "room_not_found";
}
