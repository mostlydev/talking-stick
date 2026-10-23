import { createSystemHerdrRunner, readHerdrContext, type HerdrRunner } from "../herdr.js";
import { readHerdrPluginState } from "../herdr-plugin.js";
import { startChatLinkServer, type ChatLinkServer } from "./chat-links.js";
import { InlinePinHistory, appendNativeHistory } from "./inline-pin-history.js";
import { NativeScrollLedger, subscribePaneScroll, type PaneScrollSubscription } from "./native-scroll.js";
import { isHumanAttentionMessage } from "../human-attention.js";
import { formatChatNotice, type ChatNoticeKind } from "./chat-notice.js";
import { resolveAttentionFrame, renderAttention, type HumanAttention } from "./chat-attention.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkRelease, readReleaseCache, releaseNotice, type ReleaseNotice } from "../release-status.js";
import { isStandalone, isManagedRelease, standaloneRoot, standaloneInstallDir } from "../standalone-mode.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { planChatInterrupts } from "./chat-interrupt.js";
import { interruptCodexThread } from "./codex-interrupt.js";
import { interruptCodexHerdr } from "./codex-herdr-interrupt.js";
import { ChatImages } from "./chat-images.js";
import { chatThemeName, paintStyle, setChatTheme, terminalColorMode, themeStyle } from "./theme.js";
import { ChatInputController, type ChatModalKey } from "./chat-input.js";
import { createRolesEditor, renderRolesEditor, rolesEditorKey, rolesEditorDraft, rolesEditorDirty, refreshRolesEditor, type RolesEditorState } from "./roles-editor.js";
import { applyRoleChanges, liveAgents, parseRoleList, parseRoleSubject, roomRoleBlock } from "./role-commands.js";
import { readUserRoleDefaults, harnessOf } from "../roles.js";
import { resolveInstructionPaths } from "../instructions.js";
import { loadRoleDefinitions, parseRoleDefinitionsDetailed, stripRolesSection, effectiveSharedInstructions } from "../role-definitions.js";
import { applyRoleDraft, previewRoleDraft } from "./role-draft.js";
import { editTextInTerminal, ExternalEditorError } from "./external-editor.js";
import { resolveRoomSelector, roomShortName, selectedRoom } from "./room-selector.js";
import { insideNestedRepository, isWithinOrSame, resolveContextPath } from "../path-resolution.js";
import { createMemberMenu, memberMenuKey, renderMemberMenu, type MemberMenu } from "./member-menu.js";
import { RoomNavigator, type NavigatorRoom } from "./room-navigator.js";
import { createDeclaredRoom } from "./room-admin.js";
import { resolveChatKick } from "./chat-kick.js";
import {
  ChatTranscript,
  renderChatScreen,
  diffChatFrame,
  getChatCompletions,
  formatChatHelp,
  renderInlinePanel,
  renderInlineTopPanel,
  inlineCursorRow,
  textWidth,
  truncateStyled,
  wrapStyledLine,
  chatTranscriptHeight,
  chatWheelRegion,
  chatMemberAt,
  CHAT_COMMANDS,
  type ChatFrame
} from "./chat-view.js";
import type { Readable, Writable } from "node:stream";

import { resolveDataDir } from "../config.js";
import { ProtocolError, isSqliteBusy } from "../errors.js";
import { hasHookInterrupt, requestHookInterrupt } from "../interrupt-flags.js";
import { deriveHumanCliIdentity, type DerivedIdentity } from "../identity.js";
import {
  HUMAN_CHAT_SESSION_KIND,
  type EventType,
  type MessageDelivery,
  type PathRoom,
  type RoomEvent,
  type RoomMember
} from "../types.js";
import type { ChatRoomCompletion } from "./chat-view.js";
import {
  formatRoomStrip,
  buildNameResolver,
  formatChatEvent,
  chatSectionLabel,
  startsChatConversation,
  isChatConversationActivity,
  formatChatAgent,
  describeMemberState,
  parseChatInput,
  resolveChatRecipients,
  sanitizeChatText,
  EVERYONE_SELECTORS
} from "./chat-format.js";
import {
  getStringOption,
  hasOption,
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import type { Runtime } from "./runtime.js";
import { ENHANCED_KEYS_OFF, ENHANCED_KEYS_ON } from "./terminal-keys.js";
import { readClipboardText } from "../clipboard.js";

const DEFAULT_HISTORY = 20;
const HISTORY_SCAN_EVENTS = 500;
const DEFAULT_POLL_MS = 250;
const PRESENCE_REFRESH_MS = 30_000;
const STATUS_REFRESH_MS = 10_000;
const STRIP_REFRESH_MS = 2_000;
// A running console delivers wakes that a restricted sender (a desktop app
// denied the agents' sockets) left pending, and retries unconfirmed ones.
const WAKE_RELAY_MS = 60_000;
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

// Shared across room switches within one `tt chat` process.
export interface ChatConsoleState {
  /** Images attached in this console; their markers survive room switches. */
  images?: ChatImages;
  theme_source?: string;
  /** Coordination root whose rooms the strip lists. */
  anchor: string;
  /** Rooms this console has joined; it stays a member until chat exits. */
  visited: Set<string>;
  /** Highest event seq viewed per room; unread counts start after it. */
  last_seen: Map<string, number>;
  /** Unread counting for never-viewed rooms starts at the console's start. */
  start_seq: number;
  /** Unsent draft per room, restored on return. */
  drafts: Map<string, string>;
  /**
   * Rooms joined as an observer only because they are listed, so agents there
   * can address the operator. Left again once a room drops off the strip.
   */
  subscribed: Set<string>;
  /** Highest seq of messages addressed to this console already shown inline. */
  directed_seen: Map<string, number>;
}

export type ChatSessionExit = { kind: "quit" } | { kind: "switch"; room: PathRoom };

export interface ChatSessionOptions {
  runtime: Runtime;
  identity: DerivedIdentity;
  context_path: string;
  /** Join exactly this room instead of resolving context_path. */
  room_id?: string;
  /** Multi-room state; without it chat stays in one room. */
  console?: ChatConsoleState;
  input: Readable;
  output: Writable;
  terminal: boolean;
  color: boolean;
  history: number;
  show_turn_events: boolean;
  poll_ms?: number;
  theme_source?: string;
  mouse?: boolean;
  herdr?: { pane_id: string; runner: HerdrRunner; socket_path?: string };
  // Inline mode prints into the terminal's normal screen instead of taking it
  // over, so the terminal (or multiplexer) keeps scrollback, selection, and
  // copy. The pinned full-screen layout stays available behind --fullscreen.
  inline?: boolean;
}

// Native terminal scrollback owns wheel scrolling and selection. --fullscreen
// retains the alternate-screen viewport and its keyboard scrolling controls.
export function chatInlineEnabled(parsed: ParsedCommand): boolean {
  return !hasOption(parsed, "fullscreen");
}

// A dumb terminal can neither draw the panel's cursor movement nor edit a
// draft: Node's readline swaps in its dumb line writer whenever TERM=dumb, even
// with terminal mode requested, so arrows and Ctrl+A arrive as literal text.
// Plain line mode is the honest experience there.
export function chatTerminalCapable(
  stdin: { isTTY?: boolean },
  stdout: { isTTY?: boolean },
  env: NodeJS.ProcessEnv
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && env.TERM !== "dumb";
}

// Labels say what is known, never more. "unreachable" needs a definite
// transport failure; an agent with nothing to wake it yet, such as a Grok that
// will pick the message up at its next tool call, is only "not acknowledged yet".
export function describeChatDelivery(delivery: MessageDelivery): string {
  if (delivery.state === "failed") return "unreachable";
  if (delivery.status === "receiver") return "queued";
  if (delivery.error === "manual_standby") return "waiting for resume";
  if (delivery.state === "queued" && delivery.interrupt_status === "unsupported") return "queued; immediate interrupt unavailable";
  if (delivery.state === "queued" && delivery.interrupt_status === "injected") return "urgent prompt injected";
  if (delivery.state === "ambiguous") return "wake unconfirmed";
  if (delivery.state === "steered") return "steering accepted";
  if (delivery.state === "woken") return "turn started";
  if (delivery.state === "queued") return "queued";
  if (delivery.status === "pending" || delivery.status === "endpoint") return "queued";
  return "not acknowledged yet";
}

export async function handleChatCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  if (parsed.options.get("theme") === true) throw new Error("--theme needs lantern, tide or dusk.");
  const agentId = getStringOption(parsed, "agent");
  const identity = createChatIdentity(agentId);
  const savedTheme = runtime.commands.getHumanChatTheme(identity.agent_id);
  const explicitTheme = getStringOption(parsed, "theme");
  const theme = explicitTheme ?? process.env.TT_THEME ?? savedTheme ?? "lantern";
  const themeSource = explicitTheme !== undefined ? "--theme" : process.env.TT_THEME !== undefined ? "TT_THEME" : savedTheme ? "saved" : "default";
  setChatTheme(theme);
  const terminal = chatTerminalCapable(process.stdin, process.stdout, process.env);

  // `tt chat #api` names a room; a plain positional is still a path.
  const positional = parsed.positionals[0];
  const explicit = positional?.startsWith("#")
    ? resolveRoomSelector(runtime.commands.listRooms({}).rooms, positional)
    : selectedRoom(runtime, parsed);
  const herdr = terminal ? readHerdrContext() : null;
  await runChatConsole({
    runtime,
    identity,
    // The caller's checkout stays the context even for an explicit room: a
    // room keyed under the main checkout may not exist in this worktree.
    context_path: positional && !positional.startsWith("#") ? positional : process.cwd(),
    room_id: explicit?.room_id,
    input: process.stdin,
    output: process.stdout,
    terminal,
    color: terminal && !process.env.NO_COLOR,
    theme_source: themeSource,
    history: parseOptionalInteger(parsed, "history") ?? DEFAULT_HISTORY,
    show_turn_events: hasOption(parsed, "events"),
    mouse: hasOption(parsed, "no-mouse") ? false : hasOption(parsed, "mouse") ? true : undefined,
    inline: chatInlineEnabled(parsed),
    herdr: herdr ? { pane_id: herdr.pane_id, runner: createSystemHerdrRunner(),
      socket_path: process.env.HERDR_SOCKET_PATH?.trim() || undefined } : undefined
  });
}

// One console across room switches: `/go` or Alt+←/→ ends the current room's
// session and opens the next with the same identity, drafts, and unread state.
export async function runChatConsole(options: Omit<ChatSessionOptions, "console">): Promise<void> {
  const consoleState: ChatConsoleState = {
    images: new ChatImages({ dataDir: resolveDataDir() }),
    theme_source: options.theme_source,
    anchor: "",
    visited: new Set(),
    last_seen: new Map(),
    start_seq: options.runtime.commands.globalEventSeq(),
    drafts: new Map(),
    subscribed: new Set(),
    directed_seen: new Map()
  };
  let target: { context_path: string; room_id?: string } = { context_path: options.context_path, room_id: options.room_id };
  try {
    for (;;) {
      const exit = await runChatSession({ ...options, ...target, console: consoleState });
      if (exit.kind !== "switch") break;
      target = { context_path: options.context_path, room_id: exit.room.room_id };
    }
  } finally {
    // Switching keeps memberships so agents can still reply; leave them now.
    for (const roomId of new Set([...consoleState.visited, ...consoleState.subscribed])) {
      try { options.runtime.commands.leaveRoom(options.identity, { room_id: roomId }); } catch { /* already gone */ }
    }
  }
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
): Promise<ChatSessionExit> {
  const { runtime, identity, output, terminal } = options;
  const fullscreen = terminal && options.inline !== true;
  const inline = terminal && !fullscreen;
  const selfId = identity.agent_id;
  const joined = runtime.commands.joinPath(identity, {
    context_path: options.context_path,
    room_id: options.room_id
  });
  const roomId = joined.room_id;
  let clearedThrough = selfId.startsWith("human:")
    ? runtime.commands.getHumanChatClearCursor({ room_id: roomId, human_id: selfId }) : 0;
  let attention: HumanAttention = selfId.startsWith("human:")
    ? runtime.commands.getHumanAttention({ room_id: roomId, human_id: selfId }) : { messages: [], total: 0 };
  let humanAcknowledged = new Set(attention.acknowledged ?? []);
  let unreadReview: number[] | null = null;
  let visitedUnread: RoomEvent | undefined;
  let unreadVisits = 0;
  let pendingVisit: number | undefined;
  const viewAttention = (): HumanAttention => unreadReview === null ? attention : {
    ...attention, reviewing: true, visited: visitedUnread?.event_seq, current: visitedUnread,
    position: unreadVisits, queued: unreadReview.length,
    messages: attention.messages.filter(event => unreadReview!.includes(event.event_seq))
  };
  let visibleAttention = new Set<number>();
  let mouseActive = false;
  let releaseStatus: ReleaseNotice | undefined;
  const noticeEnabled = terminal && selfId.startsWith("human:") && isStandalone() && process.env.TT_NO_AUTO_UPDATE !== "1";
  const runningRoot = isStandalone() ? standaloneRoot() : fileURLToPath(new URL("../../", import.meta.url));
  const versionAt = (root: string): string | undefined => {
    try { const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      return typeof value.version === "string" ? value.version : undefined;
    } catch { return; }
  };
  // Capture once: reading current's manifest later would call the old process new.
  const runningVersion = versionAt(runningRoot) ?? "unknown";
  let lastReleaseCheck = -Infinity;
  let releaseChecking = false;
  const refreshReleaseStatus = () => {
    if (!noticeEnabled) return;
    // Only an installer-managed layout can self-update or report an installed update.
    const managed = isManagedRelease(runningRoot);
    const installed = managed
      ? versionAt(path.join(standaloneInstallDir(runningRoot), "current")) : undefined;
    const notice = releaseNotice(runningVersion, readReleaseCache()?.latestVersion, installed);
    const next = notice && !managed ? { ...notice, manual: true } : notice;
    if (JSON.stringify(next) !== JSON.stringify(releaseStatus)) { releaseStatus = next; redraw(); }
    if (!releaseChecking && Date.now() - lastReleaseCheck >= 60_000) {
      lastReleaseCheck = Date.now();
      releaseChecking = true;
      void checkRelease().catch(() => undefined).finally(() => {
        releaseChecking = false;
        if (!closed) refreshReleaseStatus();
      });
    }
  };
  let chatLinks: ChatLinkServer | undefined;
  let nativeScroll: PaneScrollSubscription | undefined;
  const consoleState = options.console;
  let themeSource = consoleState?.theme_source ?? options.theme_source ?? "session";
  consoleState?.visited.add(roomId);
  consoleState?.subscribed.delete(roomId);
  // The active room's repository bounds its strip. Explicit host navigation
  // reanchors it; browsing the navigator alone never changes memberships.
  // A room chosen with --in from another repository brings its own anchor; a
  // keyed path absent on disk falls back to the caller's repository.
  if (consoleState && !consoleState.anchor) {
    consoleState.anchor = fs.existsSync(joined.canonical_path)
      ? resolveContextPath(joined.canonical_path).workspace_root
      : joined.workspace_root;
  }
  let switchTarget: PathRoom | null = null;
  let viewedSeq = 0;
  let roomStrip = "";
  let stripOrder: PathRoom[] = [];
  let cycleOrder: PathRoom[] = [];
  let roomNames = new Map<string, string>();
  // Every open room in this repository except the current one, for /go completion.
  let goRooms: ChatRoomCompletion[] = [];
  let lastStripRefresh = 0;
  // Other rooms in this repository that have live agents, unread messages, or
  // a past visit. The console joins listed rooms as an observer so agents there
  // can reply to it, and shows messages addressed to it inline. Its own
  // membership never keeps a room listed.
  const refreshStrip = (): boolean => {
    if (!consoleState) return false;
    lastStripRefresh = Date.now();
    const rooms = runtime.commands.listRooms({}).rooms.filter((room) =>
      room.state !== "closed" && room.room_id !== roomId && isWithinOrSame(room.canonical_path, consoleState.anchor) &&
      !insideNestedRepository(room.canonical_path, consoleState.anchor));
    const activity = new Map(runtime.commands.summarizeRoomActivity(selfId, rooms.map((room) => ({
      room_id: room.room_id,
      after_event_seq: consoleState.last_seen.get(room.room_id) ?? consoleState.start_seq
    }))).map((entry) => [entry.room_id, entry]));
    const listed = rooms.filter((room) => {
      const entry = activity.get(room.room_id);
      return (entry?.agent_members ?? 0) > 0 || (entry?.unread_messages ?? 0) > 0 || consoleState.visited.has(room.room_id);
    });
    const listedIds = new Set(listed.map((room) => room.room_id));
    for (const id of [...consoleState.subscribed]) {
      if (listedIds.has(id) || consoleState.visited.has(id)) continue;
      try { runtime.commands.leaveRoom(identity, { room_id: id }); } catch { /* already gone */ }
      consoleState.subscribed.delete(id);
    }
    for (const room of listed) {
      if (consoleState.visited.has(room.room_id) || consoleState.subscribed.has(room.room_id)) continue;
      try {
        runtime.commands.joinPath(identity, { context_path: options.context_path, room_id: room.room_id });
        consoleState.subscribed.add(room.room_id);
      } catch { /* the room closed between list and join */ }
    }
    roomNames = uniqueRoomNames([joined, ...listed], consoleState.anchor);
    const allNames = uniqueRoomNames([joined, ...rooms], consoleState.anchor);
    goRooms = rooms.map((room) => {
      const agents = activity.get(room.room_id)?.agent_members ?? 0;
      const where = path.relative(consoleState.anchor, room.canonical_path) || ".";
      return { name: allNames.get(room.room_id) ?? roomShortName(room), description: `${where} · ${agents} agent${agents === 1 ? "" : "s"}` };
    }).sort((left, right) => left.name.localeCompare(right.name));
    for (const room of listed) {
      // A visit already showed everything up to last_seen; never replay it.
      const after = Math.max(consoleState.directed_seen.get(room.room_id) ?? 0,
        consoleState.last_seen.get(room.room_id) ?? 0, consoleState.start_seq);
      const directed = runtime.commands.getDirectedMessages({ room_id: room.room_id, agent_id: selfId, after_event_seq: after });
      for (const event of directed) {
        if (!terminal) {
          print(`#${sanitizeChatText(roomNames.get(room.room_id) ?? "room")} › ${sanitizeChatText(nameOf(event.from_agent_id ?? "system"))} → you: ${sanitizeChatText(String(event.payload?.body ?? ""))}`, "message");
        } else {
          const rendered = formatChatEvent(event, formatContext());
          if (rendered) print(`#${sanitizeChatText(roomNames.get(room.room_id) ?? "room")} › ${rendered}`, "message");
        }
      }
      if (directed.length) consoleState.directed_seen.set(room.room_id, directed[directed.length - 1].event_seq);
    }
    stripOrder = listed;
    cycleOrder = rooms;
    const next = formatRoomStrip(listed.map((room) => ({
      name: roomNames.get(room.room_id) ?? roomShortName(room),
      unread: activity.get(room.room_id)?.unread_messages ?? 0,
      directed: activity.get(room.room_id)?.unread_directed ?? 0
    })), formatContext());
    const changed = next !== roomStrip;
    roomStrip = next;
    return changed;
  };
  const openRoomAtPath = (target: string, crossRepository = false): PathRoom | null => {
    if (!consoleState) return null;
    // Relative to the caller's checkout when it belongs to this console's
    // repository (a worktree keeps its branch's declarations), else the anchor.
    const caller = resolveContextPath(options.context_path);
    const checkout = caller.workspace_root === consoleState.anchor ? caller.checkout_root ?? consoleState.anchor : consoleState.anchor;
    const directory = path.resolve(checkout, target);
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return null;
    const resolved = resolveContextPath(directory);
    if (!crossRepository && (!isWithinOrSame(resolved.room_path, consoleState.anchor) ||
        (resolved.checkout_root !== null && resolved.workspace_root !== consoleState.anchor))) {
      throw new Error(`${directory} belongs to another repository.`);
    }
    return runtime.commands.openRoom({ context_path: directory });
  };
  let roomTree: RoomNavigator | null = null;
  const treeResolvedCache = new Map<string, string>();
  const treeRooms = (): NavigatorRoom[] => {
    const rooms = runtime.commands.listRooms({}).rooms.filter(room => room.state !== "closed");
    const activity = new Map(runtime.commands.summarizeRoomActivity(selfId, rooms.map(room => ({
      room_id: room.room_id, after_event_seq: consoleState?.last_seen.get(room.room_id) ?? consoleState?.start_seq ?? 0
    }))).map(entry => [entry.room_id, entry]));
    return rooms.map(room => {
      // Agentless reads never join or refresh presence in another room.
      const members = runtime.commands.getRoomState({ room_id: room.room_id }).members.filter(member =>
        member.process_liveness !== "gone" && (member.status === "active" || member.process_liveness === "alive"));
      const agents = members.filter(member => member.session_kind !== HUMAN_CHAT_SESSION_KIND).length;
      const consoles = members.length - agents;
      return { id: room.room_id, path: room.canonical_path, name: roomShortName(room), agents, consoles,
        active: members.length > 0,
        last_activity_at: runtime.commands.getRoomActivity({ room_id: room.room_id }).last_event_at ?? "",
        unread: room.room_id === roomId ? 0 : activity.get(room.room_id)?.unread_messages ?? 0 };
    });
  };
  const refreshTree = () => { if (roomTree) roomTree.rooms = treeRooms(); };
  const closeRoomTree = () => { roomTree = null; editor?.setModal(null); redraw(); };
  const resolvedTreeRoom = () => {
    if (!roomTree) return "";
    if (roomTree.view === "rooms") return roomTree.selected;
    const cached = treeResolvedCache.get(roomTree.selected);
    if (cached) return cached;
    const resolved = resolveContextPath(roomTree.selected);
    const nearest = roomTree.rooms.filter(room => isWithinOrSame(roomTree!.selected, room.path))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path;
    const result = nearest && nearest.length > resolved.room_path.length ? nearest : resolved.room_path;
    treeResolvedCache.set(roomTree.selected, result);
    return result;
  };
  const onRoomTreeKey = (key: ChatModalKey) => {
    if (!roomTree) return;
    try {
      const action = roomTree.key(key);
      if (action.kind === "close") closeRoomTree();
      if (action.kind === "go" || action.kind === "create" || action.kind === "room") {
        const room = action.kind === "room"
          ? runtime.commands.listRooms({}).rooms.find(room => room.room_id === action.id && room.state !== "closed")
          : action.kind === "create" ? createDeclaredRoom(runtime, action.path).room : openRoomAtPath(action.path, true);
        if (!room) throw new Error("Directory is no longer available.");
        closeRoomTree();
        switchTo(room, true);
      }
    } catch (error) {
      if (roomTree) { roomTree.confirm = null; roomTree.notice = sanitizeChatText(error instanceof Error ? error.message : String(error)); }
    }
    redraw();
  };
  const openRoomTree = () => {
    if (!consoleState || !editor) { print("Use /go <directory> to open a room."); return; }
    if (rolesPanel || memberMenu) { print("Close the current editor before opening rooms."); return; }
    treeResolvedCache.clear();
    roomTree = new RoomNavigator(consoleState.anchor, treeRooms(), joined.canonical_path);
    editor.setModal(onRoomTreeKey, text => roomTree?.text(text) ?? false);
    redraw();
  };
  let memberMenu: MemberMenu | null = null;
  const closeMemberMenu = () => {
    memberMenu = null;
    editor?.setModal(null);
    redraw();
  };
  const onMemberMenuKey = (key: ChatModalKey) => {
    if (!memberMenu) return;
    const action = memberMenuKey(memberMenu, key);
    const target = memberMenu.target;
    if (action === "close") closeMemberMenu();
    else if (action === "message" && target) {
      closeMemberMenu();
      editor?.setDraft(`@${target} ${editor.draft.line}`);
    } else if (action === "kick" && target) {
      closeMemberMenu();
      // The operator confirmed the exact session. The existing kick path
      // rechecks current membership and rejects console/self targets.
      submit(`/kick --force ${target}`);
    }
    redraw();
  };
  const openMemberMenu = (target?: string) => {
    if (roomTree) { print("Close /rooms before opening member actions."); return; }
    if (rolesPanel) { print("Close /roles before opening member actions."); return; }
    if (!editor) { print("Use /who to list members and /kick <agent> to remove one."); return; }
    refreshMembers();
    const agents = members.filter(member => member.agent_id !== selfId && member.session_kind !== HUMAN_CHAT_SESSION_KIND)
      .map(member => member.agent_id);
    if (target && !agents.includes(target)) { print("That member has left the room."); return; }
    if (!agents.length) { print("No agents in this room."); return; }
    rolesPanel = null;
    memberMenu = createMemberMenu(agents, target);
    editor?.setModal(onMemberMenuKey);
    redraw();
  };
  let rolesPanel: RolesEditorState | null = null;
  let rolesBase = { projectText: "", defaults: {} as Record<string, string[]>, versions: {} as Record<string, number>, version: 0 };
  let roleBusy = false;
  let rolePreviewKey: string | null = null;
  let externalEditorActive = false;
  const deferredInline: string[] = [];
  const roleOptions = { contextPath: joined.canonical_path };
  const panelHeight = () => Math.max(3, dimensions().rows - 7 - renderAttention(attention, dimensions().columns - 1, dimensions().rows, formatContext()).lines.length);
  const rolesPanelLines = () => roomTree ? roomTree.render(panelHeight(), resolvedTreeRoom(), Boolean(formatContext().color)) : memberMenu ? renderMemberMenu(memberMenu, panelHeight(), nameOf, formatContext()) : rolesPanel
    ? renderRolesEditor(rolesPanel, formatContext(), panelHeight(), Math.max(1, dimensions().columns - 1))
    : undefined;
  const closeRolesPanel = () => {
    rolesPanel = null;
    editor?.setModal(null);
    redraw();
  };
  const updateRolePreview = () => {
    if (!rolesPanel) return;
    const key = JSON.stringify(rolesEditorDraft(rolesPanel));
    if (key === rolePreviewKey) return;
    try {
      const preview = previewRoleDraft(runtime, roomId, rolesEditorDraft(rolesPanel), roleOptions);
      rolePreviewKey = key;
      rolesPanel = refreshRolesEditor({ ...rolesPanel,
        definitions: loadRoleDefinitions(roleOptions, preview.project ? { projectText: preview.project.after } : {}),
        notifications: preview.rooms.flatMap(room => [...room.agents].map(([id, reasons]) =>
          `${room.room_id === roomId ? "" : roomShortName(room) + ": "}${nameOf(id)} · ${id} ${reasons.join(", ")}`)) });
    } catch (error) {
      rolesPanel = { ...rolesPanel, notice: `! ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const openRolesPanel = (selection?: Pick<RolesEditorState, "tab" | "row" | "col">) => {
    if (roomTree || memberMenu) { print("Close the current panel before opening /roles."); return; }
    const { version, assignments } = runtime.commands.getRoomRoles({ room_id: roomId });
    rolePreviewKey = null;
    const file = resolveInstructionPaths(roleOptions).project;
    rolesBase = { projectText: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", defaults: readUserRoleDefaults(), version, versions: Object.fromEntries(runtime.commands.listRooms({}).rooms.map(room => [room.room_id, runtime.commands.getRoomRoles({ room_id: room.room_id }).version])) };
    rolesPanel = createRolesEditor({ agents: liveAgents(runtime, roomId), assignments, userDefaults: rolesBase.defaults,
      version, definitions: loadRoleDefinitions(roleOptions), globalDefinitions: loadRoleDefinitions(roleOptions, { projectText: "" }), nameOf });
    if (selection) rolesPanel = refreshRolesEditor({ ...rolesPanel, ...selection });
    editor?.setModal(onRolesKey);
    redraw();
  };
  const editRoleText = async (action: { kind: "edit_role"; name: string } | { kind: "new_role" } | { kind: "edit_instructions" }) => {
    if (!rolesPanel || !editor) return;
    const state = rolesPanel;
    const editKey = action.kind === "edit_role" ? `role:${action.name}` : action.kind;
    let editedText: string | undefined;
    roleBusy = true;
    try {
      const staged = previewRoleDraft(runtime, roomId, rolesEditorDraft(state), roleOptions).project?.after ?? rolesBase.projectText;
      const initial = action.kind === "new_role" ? "## Roles\n\n### new-role\nDescribe this role.\n"
        : action.kind === "edit_role" ? state.definitions.find(d => d.name === action.name)?.text ?? ""
        : stripRolesSection(staged);
      const text = state.rejectedText?.key === editKey ? state.rejectedText.text : initial;
      const edited = await editTextInTerminal(text, {
        suspend: () => {
          externalEditorActive = true;
          if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
          if (inline) eraseComposer();
          output.write("\u001b[?2026l\u001b[?2004l\u001b[?1000l\u001b[?1006l\u001b[?25h" + ENHANCED_KEYS_OFF + (fullscreen ? "\u001b[?1049l" : ""));
          mouseActive = false;
          editor?.suspend();
        },
        resume: () => {
          externalEditorActive = false;
          if (closed) return;
          output.write((fullscreen ? "\u001b[?1049h" : "") + "\u001b[?2004h" + ENHANCED_KEYS_ON + (fullscreen && options.mouse ? "\u001b[?1000h\u001b[?1006h" : ""));
          previousFrame = null;
          syncMouse();
          editor?.resume();
          if (inline) {
            // The editor may have moved the cursor anywhere on the normal screen.
            inlineFrame = null;
            inlineReceiptRows.clear();
            output.write("\r\n");
            for (const line of deferredInline.splice(0)) writeInline(line);
            // Re-establish absolute viewport anchors after an editor moved the cursor.
            onResize();
          }
          redraw();
        }
      }, { name: action.kind === "edit_role" ? `${action.name}.md` : "instructions.md" });
      editedText = edited;
      if (closed || rolesPanel !== state) return;
      if (action.kind === "new_role" && edited === initial && !state.rejectedText) return;
      const draft = { ...state.draft, definitions: { ...state.draft.definitions } };
      if (action.kind === "edit_instructions") {
        if (parseRoleDefinitionsDetailed(edited).definitions.length || parseRoleDefinitionsDetailed(edited).problems.length) throw new Error("Use e/n to edit role definitions; i edits shared project instructions only.");
        if (stripRolesSection(edited).trim() === stripRolesSection(rolesBase.projectText).trim()) delete draft.sharedInstructions;
        else draft.sharedInstructions = edited;
      } else {
        let name: string, body: string;
        if (action.kind === "new_role") {
          const parsed = parseRoleDefinitionsDetailed(edited);
          if (parsed.problems.length || parsed.definitions.length !== 1) throw new Error("Define exactly one valid role under ## Roles / ### role-name.");
          ({ name, text: body } = parsed.definitions[0]);
          if (state.definitions.some(d => d.name === name)) throw new Error(`Role ${name} already exists; select it and press e.`);
        } else { name = action.name; body = edited.trim(); }
        if (state.originalDefinitions.find(d => d.name === name)?.text === body) delete draft.definitions![name];
        else draft.definitions![name] = body;
      }
      // Validate the reconstructed file before accepting the editor text.
      previewRoleDraft(runtime, roomId, { ...rolesEditorDraft(state), ...draft }, roleOptions);
      rolesPanel = { ...state, draft, rejectedText: undefined, notice: "Draft updated. Enter applies; u undoes." };
      updateRolePreview();
    } catch (error) {
      const rejected = error instanceof ExternalEditorError ? error.draftText : editedText;
      if (rolesPanel) rolesPanel = { ...rolesPanel,
        ...(rejected !== undefined ? { rejectedText: { key: editKey, text: rejected } } : {}),
        notice: `! ${(error instanceof Error ? error.message : String(error)).replace(/[.!?]+$/, "")}. Press ${action.kind === "new_role" ? "n" : action.kind === "edit_role" ? "e" : "i"} again to correct the text.` };
    } finally { roleBusy = false; redraw(); }
  };
  const onRolesKey = (key: ChatModalKey) => {
    if (!rolesPanel || roleBusy) return;
    const { state, action } = rolesEditorKey(rolesPanel, key);
    rolesPanel = state;
    if (action.kind === "cancel") { closeRolesPanel(); return; }
    if (action.kind === "undo") { openRolesPanel(); return; }
    if (action.kind === "edit_role" || action.kind === "new_role" || action.kind === "edit_instructions") {
      void editRoleText(action); return;
    }
    if (action.kind === "preview") {
      try {
        const preview = previewRoleDraft(runtime, roomId, rolesEditorDraft(state), roleOptions);
        const row = (state.tab === "room" ? state.rows : state.defaultRows).find(r => r.agent_id === action.agent);
        const defs = state.tab === "room" ? state.definitions : state.globalDefinitions;
        const shared = state.tab === "room" ? effectiveSharedInstructions(harnessOf(action.agent), roleOptions,
          preview.project ? { projectText: preview.project.after } : {}) : "Harness defaults apply in every room without a room/session override. Each project supplies its own shared instructions.";
        rolesPanel = { ...state, preview: `${state.tab === "room" ? "Instructions for" : "Default roles for"} ${row?.label ?? action.agent}\n\n${shared}\n\n` +
          (row?.roles ?? []).map(name => `### ${name}\n${defs.find(d => d.name === name)?.text ?? "No definition."}`).join("\n\n") };
      } catch (error) { rolesPanel = { ...state, view: "grid", notice: `! ${error instanceof Error ? error.message : String(error)}` }; }
      redraw(); return;
    }
    if (action.kind === "apply") {
      if (!rolesEditorDirty(state)) { rolesPanel = { ...state, notice: "No changes to apply." }; redraw(); return; }
      roleBusy = true;
      rolesPanel = { ...state, notice: "Applying…" };
      void applyRoleDraft(runtime, identity, roomId, rolesEditorDraft(state), { ...roleOptions, base: rolesBase })
        .then(result => { if (!closed) { openRolesPanel({ tab: state.tab, row: state.row, col: state.col }); if (rolesPanel) rolesPanel.notice = result.summary; print(sanitizeChatText(result.summary), "ok"); } })
        .catch(error => { rolesPanel = { ...state, notice: `! ${error instanceof Error ? error.message : String(error)}` }; })
        .finally(() => { roleBusy = false; redraw(); });
      return;
    }
    updateRolePreview();
    redraw();
  };
  const switchTo = (room: PathRoom, reanchor = false) => {
    if (room.room_id === roomId) { print(`Already in ${sanitizeChatText(room.canonical_path)}.`); return; }
    if (reanchor && consoleState) consoleState.anchor = "";
    switchTarget = room;
    stop();
  };

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
  const images = consoleState?.images ?? new ChatImages({ dataDir: resolveDataDir() });
  let editor: ChatInputController | null = null;
  let rl: readline.Interface | null = null;
  let previousFrame: ChatFrame | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | null = null;
  let screenActive = false;
  let failure: unknown;
  let hint: string | null = null;
  let interruptHint: { text: string; until: number } | null = null;
  const interruptIndicators = new Map<string,
    { kind: "claude"; session_id: string } | { kind: "timed"; label: string; until: number }>();
  const interruptStatuses = (): ReadonlyMap<string, string> => {
    const now = Date.now();
    const statuses = new Map<string, string>();
    for (const [agentId, indicator] of interruptIndicators) {
      if (indicator.kind === "claude" && hasHookInterrupt("claude", indicator.session_id)) {
        statuses.set(agentId, "stopping");
      } else if (indicator.kind === "timed" && now < indicator.until) {
        statuses.set(agentId, indicator.label);
      } else {
        interruptIndicators.delete(agentId);
      }
    }
    return statuses;
  };
  const currentHint = () => {
    if (interruptHint && Date.now() >= interruptHint.until) interruptHint = null;
    return interruptHint?.text ?? hint;
  };
  const interruptSignature = () => JSON.stringify({
    statuses: [...interruptStatuses()], hint: currentHint()
  });
  let lastInterruptSignature = interruptSignature();
  // One room message can reach several agents, so each event keeps a state per
  // recipient and renders them on a single line under that message.
  const deliveryStates = new Map<number, Map<string, string>>();
  const rememberDelivery = (seq: number, agent: string, state: string) => {
    const states = deliveryStates.get(seq) ?? new Map<string, string>();
    states.set(agent, state);
    deliveryStates.set(seq, states);
    while (deliveryStates.size > 2_000) deliveryStates.delete(deliveryStates.keys().next().value!);
  };
  // Every icon is one terminal cell, so a delivery update never changes how
  // many rows a message header occupies: … pending, ✓ delivered, ! failed.
  const deliveryIcon = (event: RoomEvent, agent: string) => {
    const state = deliveryStates.get(event.event_seq)?.get(agent);
    if (!state || !terminal) return undefined;
    if (state === "delivered") return paintStyle(options.color, themeStyle("ok", terminalColorMode()), "✓");
    if (state === "unreachable") return paintStyle(options.color, themeStyle("error", terminalColorMode()), "!");
    return options.color ? "\u001b[2m…\u001b[0m" : "…";
  };
  // Events whose header shows delivery icons, kept so a receipt can repaint it.
  const trackedEvents = new Map<number, RoomEvent>();
  let lastStatusDraw = Date.now();
  const dimensions = () => ({
    columns: Math.max(1, (output as { columns?: number }).columns ?? 80),
    rows: Math.max(1, (output as { rows?: number }).rows ?? 24)
  });
  const formatContext = () => ({
    self_agent_id: selfId,
    name_of: nameOf,
    color: options.color,
    color_mode: terminalColorMode(),
    show_turn_events: showTurnEvents,
    now: new Date(),
    history_before: historyBefore,
    delivery_icon: deliveryIcon,
    pin_link: chatLinks?.url,
    human_acknowledged: (event: RoomEvent) => humanAcknowledged.has(event.event_seq),
    focused_event: visitedUnread?.event_seq,
    tracks_delivery: (event: RoomEvent) => terminal && (deliveryStates.get(event.event_seq)?.size ?? 0) > 0
  });
  const completionsFor = (draft: { line: string; cursor: number }) => getChatCompletions(draft,
    members.filter((member) => member.agent_id !== selfId && member.process_liveness !== "gone")
      .flatMap((member) => [nameOf(member.agent_id), member.agent_id]),
    members.filter((member) => member.agent_id !== selfId && member.session_kind !== HUMAN_CHAT_SESSION_KIND)
      .sort((a, b) => Number(b.process_liveness === "gone") - Number(a.process_liveness === "gone") || a.agent_id.localeCompare(b.agent_id))
      .map((member) => ({ agent_id: member.agent_id, name: member.display_name || nameOf(member.agent_id),
        status: member.process_liveness === "gone" ? "ended" : describeMemberState(member, {
          members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
          columns: dimensions().columns, interrupt_statuses: interruptStatuses()
        }) })), goRooms);
  // Inline drawing: the composer occupies the last rows of the normal screen.
  // Erasing walks back up every row it drew, so a wrapped draft never leaves
  // fragments behind in the scrollback.
  let inlineFrame: ChatFrame | null = null;
  let inlinePanelRows = 0;
  let inlineFrameColumns = { columns: 80, rows: 24 };
  let inlineActive = false;
  let inlineOutputRows = 0;
  const inlinePinHistory = new InlinePinHistory();
  let inlineHistoryInitialized = false;
  // Rows committed to Herdr's scrollback while pins show, so a pending
  // message the operator scrolls past natively stops pinning.
  const nativeScrollLedger = new NativeScrollLedger();
  // While the operator browses Herdr scrollback, chat writes nothing to the
  // pane: no repaint, no commits. Herdr returns a pane to the bottom on any
  // key, and the scroll event that follows brings the frame up to date.
  let nativeAway = false;
  let inlineNeedsRebuild = false;
  let inlineVisibleFloor = 0;
  const inlineReceiptRows = new Map<number, number>();
  const inlineHumanRows = new Map<number, number>();
  // Erase with the geometry the panel was drawn at: after a resize the current
  // width would compute the wrong row count and strand a stale copy.
  const eraseComposer = () => {
    if (!inlineFrame) return;
    const up = Math.min(
      inlineFrameColumns.rows - 1,
      inlineCursorRow(inlineFrame, inlineFrameColumns.columns)
    );
    output.write(`\r${up > 0 ? `\u001b[${up}A` : ""}\u001b[J`);
    inlineFrame = null;
  };
  const syncMouse = () => {
    // Mouse reporting captures the entire terminal, including wheel and drag.
    // Pending pins must never silently disable native scrollback or selection.
    const active = options.mouse === true;
    if (active === mouseActive || !terminal || externalEditorActive) return;
    output.write(active ? "\u001b[?1000h\u001b[?1006h" : "\u001b[?1000l\u001b[?1006l");
    mouseActive = active;
  };
  const drawTopViewport = () => {
    const size = dimensions();
    const context = formatContext();
    const draft = editor?.draft ?? { line: "", cursor: 0 };
    const input = {
      room_path: joined.canonical_path, room_strip: roomStrip, panel: rolesPanelLines(), attention: viewAttention(), release: releaseStatus, transcript, format: context,
      status: { members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(), interrupt_statuses: interruptStatuses() },
      draft, hint: currentHint(), completions: editor?.completionVisible ? completionsFor(draft) : [],
      completion_index: editor?.completionIndex ?? 0, ...size
    };
    const all = transcript.historyRows(Math.max(1, size.columns - 1), context);
    if (!inlineHistoryInitialized) {
      const footer = renderInlinePanel({ ...input, attention: undefined });
      inlinePinHistory.observe(all, Math.max(0, all.length - (size.rows - footer.lines.length)));
      inlineHistoryInitialized = true;
    }
    if (nativeAway) { inlineNeedsRebuild = true; return; }
    const frame = renderInlineTopPanel(input);
    const evicted = unreadReview === null ? inlinePinHistory.evict(all, frame.history_top ?? 0) : [];
    const history = evicted.map(entry => entry.text);
    nativeScrollLedger.commit(evicted.map(entry => transcript.eventSeqForRow(entry.row)));
    if (!history.length && inlineFrame?.inline_top && JSON.stringify(frame) === JSON.stringify(inlineFrame)) return;
    output.write("\u001b[?2026h" + appendNativeHistory(history, size.rows) + "\u001b[H\u001b[J" + frame.lines.join("\r\n") +
      `\u001b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\u001b[?2026l`);
    inlineFrame = frame;
    inlineFrameColumns = size;
    inlinePanelRows = 0;
    inlineReceiptRows.clear();
    inlineHumanRows.clear();
    visibleAttention = new Set([...(frame.attention ?? []), ...(frame.human_messages ?? [])].map(hit => hit.event_seq));
    syncMouse();
    completeUnreadVisit(frame);
  };
  const freezeInlineHistory = () => {
    transcript.setOutputBuffered(true);
    if (inlineHistoryInitialized) return;
    // Capture what was already printed before buffering any new events.
    // Initializing from the later catch-up tail would silently skip them.
    const size = dimensions();
    const all = transcript.historyRows(Math.max(1, size.columns - 1), formatContext());
    const bodyHeight = Math.max(0, size.rows - (inlineFrame?.lines.length ?? 0));
    inlinePinHistory.observe(all, Math.max(0, all.length - bodyHeight));
    inlineHistoryInitialized = true;
  };
  const resumeInlineTail = () => {
    const buffered = inlineNeedsRebuild;
    inlineNeedsRebuild = false;
    if (buffered && inlineHistoryInitialized) {
      // Evict every row after the frozen frontier, even if the last pending
      // message was acknowledged elsewhere while we were browsing.
      drawTopViewport();
      if (attention.total === 0) onResize();
    } else if (attention.total > 0) drawComposer();
    else onResize();
    transcript.setOutputBuffered(false);
  };
  // The top viewport repaints from home, so the transcript stops flowing into
  // native scrollback. Enter it only once an unread message has left the
  // screen (the bar has something to point at) or a review is open, and stay
  // until nothing is unread so the view does not flap at the edge.
  let inlineTopActive = false;
  const inlineTopMode = () => {
    if (unreadReview !== null) return true;
    if (!attention.total) return inlineTopActive = false;
    if (inlineTopActive) return true;
    const floor = Math.max(inlineVisibleFloor, inlineOutputRows + inlinePanelRows - dimensions().rows);
    const visible = new Set([...inlineHumanRows].filter(([row]) => row >= floor && row < inlineOutputRows).map(([, seq]) => seq));
    return inlineTopActive = attention.messages.some(event => !visible.has(event.event_seq));
  };
  const drawComposer = () => {
    if (!inline || closed || externalEditorActive) return;
    if (nativeAway) { inlineNeedsRebuild = true; return; }
    if (inlineTopMode()) { drawTopViewport(); return; }
    inlineHistoryInitialized = false;
    nativeScrollLedger.reset();
    const draft = editor?.draft ?? { line: "", cursor: 0 };
    const frame = resolveAttentionFrame(attention, pins => {
      const frame = renderInlinePanel({
        room_path: joined.canonical_path, room_strip: roomStrip, panel: rolesPanelLines(), attention: pins, release: releaseStatus, transcript, format: formatContext(),
        status: { members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
          interrupt_statuses: interruptStatuses() },
        draft, hint: currentHint(),
        completions: editor?.completionVisible ? completionsFor(draft) : [],
        completion_index: editor?.completionIndex ?? 0,
        ...dimensions()
      });
      const floor = Math.max(inlineVisibleFloor,
        inlineOutputRows + Math.max(inlinePanelRows, frame.lines.length) - dimensions().rows);
      return { frame, visible: [...inlineHumanRows].filter(([row]) => row >= floor && row < inlineOutputRows).map(([, seq]) => seq) };
    });
    // A modal may scroll the normal screen as it grows. Keep its bottom
    // anchored when it shrinks; subsequent transcript output reclaims the gap.
    inlinePanelRows = Math.max(inlinePanelRows, frame.lines.length);
    const padding = inlinePanelRows - frame.lines.length;
    if (padding) {
      frame.lines.unshift(...Array<string>(padding).fill(""));
      frame.cursor.row += padding;
      for (const hit of frame.attention ?? []) hit.row += padding;
    }
    if (inlineFrame && JSON.stringify(inlineFrame) === JSON.stringify(frame)) return;
    output.write("\u001b[?2026h");
    eraseComposer();
    output.write(frame.lines.join("\r\n"));
    inlineFrame = frame;
    visibleAttention = new Set([...(frame.attention ?? []), ...(frame.human_messages ?? [])].map(hit => hit.event_seq));
    inlineFrameColumns = dimensions();
    inlineVisibleFloor = Math.max(inlineVisibleFloor, inlineOutputRows + frame.lines.length - dimensions().rows);
    for (const [seq, row] of inlineReceiptRows) if (row < inlineVisibleFloor) inlineReceiptRows.delete(seq);
    for (const row of inlineHumanRows.keys()) if (row < inlineVisibleFloor) inlineHumanRows.delete(row);
    for (const seq of inlineHumanRows.values()) visibleAttention.add(seq);
    const up = frame.lines.length - 1 - frame.cursor.row;
    output.write(`\r${up > 0 ? `\u001b[${up}A` : ""}${frame.cursor.col > 0 ? `\u001b[${frame.cursor.col}C` : ""}\u001b[?2026l`);
    syncMouse();
  };
  // Inline output must not land on top of the composer: erase it, print the
  // line, then redraw the draft underneath.
  const writeInline = (text: string) => {
    if (externalEditorActive) { deferredInline.push(text); return; }
    if (nativeAway) { inlineNeedsRebuild = true; return; }
    if (inlineTopMode()) { drawTopViewport(); return; }
    eraseComposer();
    const lines = text.split(/\r?\n/).flatMap(line => wrapStyledLine(line, Math.max(1, dimensions().columns - 1)));
    output.write(lines.join("\r\n") + "\r\n");
    inlineOutputRows += lines.length;
    inlinePanelRows = Math.max(0, inlinePanelRows - lines.length);
    drawComposer();
  };
  const redraw = () => {
    if (externalEditorActive) return;
    if (inline) { drawComposer(); return; }
    if (!fullscreen || closed || frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (closed || !screenActive || externalEditorActive) return;
      try {
        syncMouse();
        const frame = renderChatScreen({
          room_path: joined.canonical_path,
          room_strip: roomStrip, panel: rolesPanelLines(), attention: viewAttention(),
          release: releaseStatus,
          transcript,
          format: formatContext(),
          status: {
            members,
            owner,
            owner_since: ownerSince,
            reserved_for: reservedFor,
            now: new Date(),
            interrupt_statuses: interruptStatuses()
          },
          draft: editor?.draft ?? { line: "", cursor: 0 },
          hint: currentHint(),
          completions: editor?.completionVisible ? completionsFor(editor.draft) : [],
          completion_index: editor?.completionIndex ?? 0,
          ...dimensions()
        });
        visibleAttention = new Set([...(frame.attention ?? []), ...(frame.human_messages ?? [])].map(hit => hit.event_seq));
        output.write(diffChatFrame(previousFrame, frame));
        previousFrame = frame;
        completeUnreadVisit(frame);
      } catch (error) {
        failure = error;
        stop();
      }
    }, 16);
  };
  const print = (text: string, kind?: ChatNoticeKind | "message"): number | null => {
    if (terminal && kind !== "message") text = formatChatNotice(text, options.color, terminalColorMode(), kind);
    if (inline) {
      transcript.appendNotice(text);
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
  // Receipts belong to event IDs, never to the latest send or the room footer.
  const awaitingReceipt = new Map<number, Set<string>>();
  let lastReceiptCheck = 0;
  const trackReceipt = (eventSeq: number, agent: string) => {
    awaitingReceipt.set(eventSeq, (awaitingReceipt.get(eventSeq) ?? new Set<string>()).add(agent));
    while (awaitingReceipt.size > MAX_AWAITED_RECEIPTS) {
      awaitingReceipt.delete(awaitingReceipt.keys().next().value!);
    }
  };
  const setDelivery = (seq: number, agent: string, state: string) => {
    rememberDelivery(seq, agent, state);
    transcript.invalidate();
    if (inline && nativeAway) { inlineNeedsRebuild = true; return; }
    if (inline && inlineTopMode()) { redraw(); return; }
    const row = inlineReceiptRows.get(seq);
    const event = trackedEvents.get(seq);
    const header = event ? render(event)?.split("\n")[0] : undefined;
    if (inline && !externalEditorActive && row !== undefined && row >= inlineVisibleFloor && header !== undefined) {
      // Only repaint rows still on the live terminal screen. Cursor movement
      // cannot rewrite native scrollback. Saved history reads durable receipts.
      // Icons are one cell wide, so the header wraps to the same rows as before.
      const rows = wrapStyledLine(header, Math.max(1, dimensions().columns - 1));
      output.write("\u001b[?2026h");
      eraseComposer();
      const up = inlineOutputRows - row;
      const down = up - rows.length + 1;
      // CSI 0 B still moves one row, so never emit a zero-length move.
      output.write(`\r\u001b[${up}A${rows.map((text) => `\u001b[2K${text}`).join("\r\n")}\r${down > 0 ? `\u001b[${down}B` : ""}`);
      drawComposer();
      output.write("\u001b[?2026l");
    } else redraw();
  };
  const checkReceipts = () => {
    if (awaitingReceipt.size === 0 || Date.now() - lastReceiptCheck < RECEIPT_POLL_MS) return;
    lastReceiptCheck = Date.now();
    const seqs = [...awaitingReceipt.keys()];
    const receipts = [];
    for (let start = 0; start < seqs.length; start += RECEIPT_BATCH) {
      receipts.push(...runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: seqs.slice(start, start + RECEIPT_BATCH) }));
    }
    for (const receipt of receipts) {
      const pending = awaitingReceipt.get(receipt.event_seq);
      if (!pending?.delete(receipt.agent_id)) continue;
      if (pending.size === 0) awaitingReceipt.delete(receipt.event_seq);
      setDelivery(receipt.event_seq, receipt.agent_id, "delivered");
      if (!terminal) print(`${sanitizeChatText(nameOf(receipt.agent_id))}: delivered`);
    }
  };
  const reportRoomClosed = () => {
    exitReason = "tt chat: the room has closed.";
    if (!fullscreen) print("The room has closed.");
  };
  const restore = () => {
    options.input.off("data", resumeNativeScrollOnInput);
    chatLinks?.close();
    chatLinks = undefined;
    nativeScroll?.close();
    nativeScroll = undefined;
    editor?.close();
    if (inlineActive) {
      eraseComposer();
      output.write("\u001b[?2026l\u001b[?2004l\u001b[?1000l\u001b[?1006l" + ENHANCED_KEYS_OFF);
      inlineActive = false;
    }
    if (!screenActive) return;
    screenActive = false;
    output.write(
      "\u001b[?2026l\u001b[?1000l\u001b[?1006l\u001b[?2004l" + ENHANCED_KEYS_OFF + "\u001b[?1049l\u001b[?25h"
    );
  };
  const stop = () => {
    if (closed && !screenActive && !inlineActive && !rl) return;
    closed = true;
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = null;
    rl?.close();
    rl = null;
    restore();
  };
  const onResize = () => {
    if (externalEditorActive) return;
    // Herdr may rewrap scrollback; committed rows no longer map one to one.
    nativeScrollLedger.reset();
    if (inline && nativeAway) { inlineNeedsRebuild = true; return; }
    if (inline && inlineTopMode()) {
      editor?.resize(dimensions().columns - 1);
      drawTopViewport();
      return;
    }
    inlineHistoryInitialized = false;
    // Reflow invalidates physical row anchors; never overwrite a different
    // message using coordinates recorded at the old width.
    inlineReceiptRows.clear();
    inlineHumanRows.clear();
    inlineOutputRows = 0;
    inlineVisibleFloor = 0;
    // Reflow can move rows both before and after the editor cursor. Rebuild
    // the visible tail from the model instead of guessing a cursor-up distance.
    // Home + ED0 clears only the active area; ED2 may push it into scrollback
    // in some terminals, and ED3 would erase history.
    if (inline) {
      inlineFrame = null;
      inlinePanelRows = 0;
      editor?.resize(dimensions().columns - 1);
      const draft = editor?.draft ?? { line: "", cursor: 0 };
      const panel = resolveAttentionFrame(attention, pins => {
        const frame = renderInlinePanel({ room_path: joined.canonical_path, room_strip: roomStrip, panel: rolesPanelLines(), attention: pins, release: releaseStatus, transcript, format: formatContext(),
        status: { members, owner, owner_since: ownerSince, reserved_for: reservedFor, now: new Date(),
          interrupt_statuses: interruptStatuses() },
        draft, hint: currentHint(), completions: editor?.completionVisible ? completionsFor(draft) : [],
        completion_index: editor?.completionIndex ?? 0, ...dimensions() });
        const height = Math.max(0, dimensions().rows - frame.lines.length);
        return { frame, visible: transcript.humanMessageRows(height, Math.max(1, dimensions().columns - 1), formatContext()).map(hit => hit.event_seq) };
      });
      const tailHeight = Math.max(0, dimensions().rows - panel.lines.length);
      const bodyRows = transcript.historyRows(Math.max(1, dimensions().columns - 1), formatContext());
      const tail = bodyRows.slice(Math.max(0, bodyRows.length - tailHeight)).map(row => inlinePinHistory.visible(row));
      while (tail.length < tailHeight) tail.unshift("");
      output.write("\u001b[?2026h\u001b[H\u001b[J");
      if (tail.length) output.write(tail.join("\r\n") + "\r\n");
      inlineOutputRows = tail.length;
      for (const hit of transcript.humanMessageRows(tailHeight, Math.max(1, dimensions().columns - 1), formatContext())) {
        if (tail[hit.row]) inlineHumanRows.set(hit.row, hit.event_seq);
      }
      for (const [seq, row] of transcript.receiptRows(tailHeight, Math.max(1, dimensions().columns - 1), formatContext())) {
        if (tail[row]) inlineReceiptRows.set(seq, row);
      }
      drawComposer();
      output.write("\u001b[?2026l");
      return;
    }
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

  const hydrateReceipts = (events: RoomEvent[]) => {
    const seqs = events.filter(event => event.event_type === "message_sent" && event.from_agent_id?.startsWith("human:"))
      .map(event => event.event_seq);
    for (let start = 0; start < seqs.length; start += RECEIPT_BATCH) {
      for (const receipt of runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: seqs.slice(start, start + RECEIPT_BATCH) })) {
        rememberDelivery(receipt.event_seq, receipt.agent_id, "delivered");
      }
    }
    if (seqs.length) transcript.invalidate();
  };

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
        hydrateReceipts(earlier);
        const visible = earlier.filter((event) => render(event) !== null);
        transcript.prependEvents(visible, height, columns - 1, formatContext());
        if (visible.length) break;
      }
    }
    transcript.scrollBy(amount, height, columns - 1, formatContext(), unreadReview === null);
    acknowledgeTraversed();
    redraw();
  };

  const coloredName = (agentId: string) =>
    formatChatAgent(
      {
        self_agent_id: selfId,
        name_of: nameOf,
        color: options.color,
        color_mode: terminalColorMode(),
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
    // No mention, or @everyone, is one room message that reaches every agent.
    // Named mentions narrow it: one name is a directed message, several share
    // a single message listing them. Nothing is ever sent once per agent.
    let route: { to_agent_id?: string; to_agent_ids?: string[] } = {};
    if (to.length > 0 && !to.some((selector) => EVERYONE_SELECTORS.includes(selector))) {
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
      route = resolved.agent_ids.length === 1
        ? { to_agent_id: resolved.agent_ids[0] }
        : { to_agent_ids: resolved.agent_ids };
    }
    redraw();
    const outgoing = images.take(body);
    void runtime.commands.sendMessageAndWake(identity, {
      room_id: roomId,
      body: outgoing.body,
      ...(outgoing.attachments.length ? { attachments: outgoing.attachments } : {}),
      ...route,
      delivery_hint: interrupt ? "interrupt" : "normal"
    }, (delivery, sent) => {
      if (closed) return;
      const received = runtime.commands.getMessageReceipts({ room_id: roomId, event_seqs: [sent.event_seq] })
        .some((receipt) => receipt.agent_id === delivery.agent_id);
      const state = received ? "delivered" : describeChatDelivery(delivery);
      setDelivery(sent.event_seq, delivery.agent_id, state);
      if (!terminal) print(`${sanitizeChatText(nameOf(delivery.agent_id))}: ${state}`);
      if (!received) trackReceipt(sent.event_seq, delivery.agent_id);
    })
    .catch(() => { if (!closed) print("! Message delivery could not be confirmed."); });
  };

  const refreshAttention = () => {
    if (!selfId.startsWith("human:")) return;
    const next = runtime.commands.getHumanAttention({ room_id: roomId, human_id: selfId });
    const changed = next.total !== attention.total || next.messages.map(event => event.event_seq).join(",") !== attention.messages.map(event => event.event_seq).join(",");
    const acknowledgementsChanged = next.acknowledged.join(",") !== [...humanAcknowledged].join(",");
    if (unreadReview !== null) {
      const previous = new Set(attention.messages.map(event => event.event_seq));
      for (const event of next.messages) if (!previous.has(event.event_seq)) unreadReview.push(event.event_seq);
    }
    attention = next;
    humanAcknowledged = new Set(next.acknowledged);
    if (changed || acknowledgementsChanged) {
      transcript.invalidate();
      if (inline) onResize(); else redraw();
      syncMouse();
    }
  };
  const acknowledge = (selector = "") => {
    const parsed = selector.trim().replace(/^#/, "");
    if (parsed && parsed !== "all" && !/^\d+$/.test(parsed)) { print("Use /ack, /ack #message, or /ack all."); return; }
    const targets = parsed === "all" ? attention.messages : parsed ? [{ event_seq: Number(parsed) }]
      : attention.messages.filter(event => visibleAttention.has(event.event_seq));
    // A compact, short-pane header represents the oldest pending message.
    if (!parsed && !targets.length && attention.total) targets.push(...attention.messages.slice(0, 1));
    try {
      for (const target of targets) runtime.commands.acknowledgeHumanMessage(identity, { room_id: roomId, event_seq: target.event_seq });
      // Fetch again so another console's acknowledgements are reflected too.
      refreshAttention();
      if (parsed === "all" && attention.messages.length) acknowledge("all");
    } catch (error) { print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`); }
  };
  // Scrolling the live transcript across a message reads it, durably. A review
  // is excluded: its jumps and browsing leave context rows unread.
  const acknowledgeTraversed = () => {
    if (unreadReview !== null) return;
    for (const event of attention.messages.filter(candidate => transcript.wasManuallyTraversed(candidate.event_seq))) {
      acknowledge(String(event.event_seq));
    }
  };
  const completeUnreadVisit = (frame: ChatFrame) => {
    const seq = pendingVisit;
    if (seq === undefined || !frame.human_messages?.some(hit => hit.event_seq === seq)) return;
    pendingVisit = undefined;
    // Only a target actually drawn in the viewport is acknowledged. Merely
    // rendering the indicator, searching, or crossing other rows is not read.
    acknowledge(String(seq));
  };
  const closeUnreadReview = () => {
    unreadReview = null;
    pendingVisit = undefined;
    visitedUnread = undefined;
    unreadVisits = 0;
    transcript.invalidate();
    editor?.setModal(null);
    transcript.scrollToBottom();
    if (inline) {
      inlineNeedsRebuild = true;
      resumeInlineTail();
    } else { transcript.setOutputBuffered(false); redraw(); }
  };
  const visitUnread = (requested?: number): boolean => {
    if (rolesPanel || roomTree || memberMenu || closed || externalEditorActive) return false;
    const opening = unreadReview === null;
    if (opening) {
      const frame = inline ? inlineFrame : previousFrame;
      const visible = new Set(frame?.human_messages?.map(hit => hit.event_seq));
      unreadReview = attention.messages.filter(event => !visible.has(event.event_seq) &&
        !transcript.wasManuallyTraversed(event.event_seq)).map(event => event.event_seq).sort((a, b) => a - b);
    }
    const next = attention.messages.filter(event => unreadReview!.includes(event.event_seq))
      .sort((a, b) => a.event_seq - b.event_seq)[0];
    if (!next) { closeUnreadReview(); return false; }
    if (requested !== undefined && requested !== next.event_seq) { if (opening) unreadReview = null; return false; }
    const { columns, rows } = dimensions();
    const height = Math.max(1, chatTranscriptHeight({ columns, rows, draft: editor?.draft ?? { line: "", cursor: 0 }, room_path: joined.canonical_path }) - 1);
    const context = formatContext();
    if (inline) freezeInlineHistory();
    else transcript.setOutputBuffered(true);
    // A missed target may have been trimmed out of the live transcript. Load
    // its bounded original neighbourhood from the archive, never just a copy
    // of its body. No pagination through the entire intervening history.
    if (!transcript.scrollToEvent(next.event_seq, height, columns - 1, context)) {
      const before = runtime.commands.getRecentRoomEvents({ room_id: roomId, before_event_seq: next.event_seq, limit: 20, event_types: CONVERSATION_EVENTS });
      const after = runtime.commands.getRoomEvents({ room_id: roomId, after_event_seq: next.event_seq - 1, limit: 40 });
      const existing = new Set(transcript.historyRows(columns - 1, context).map(row => transcript.eventSeqForRow(row)));
      const events = [...before, ...after].filter(event => event.event_seq > clearedThrough && !existing.has(event.event_seq) && render(event) !== null);
      hydrateReceipts(events);
      transcript.prependEvents(events, height, columns - 1, context);
      if (!transcript.scrollToEvent(next.event_seq, height, columns - 1, context)) { closeUnreadReview(); return false; }
    }
    visitedUnread = next;
    unreadVisits += 1;
    pendingVisit = next.event_seq;
    transcript.invalidate();
    editor?.setModal(key => {
      if (key === "escape" || key === "quit") closeUnreadReview();
      else if (key === "enter" || key === "space" || key === "no") visitUnread();
      else if (["up", "down", "page_up", "page_down"].includes(key)) {
        scrollHistory((key === "up" || key === "page_up" ? -1 : 1) * (key.startsWith("page") ? Math.max(1, height - 1) : 1));
      }
    }, undefined, true);
    redraw();
    return true;
  };
  const onClick = (column: number, row: number) => {
    if (options.mouse === false || column < 1 || column >= dimensions().columns || row < 1 || row > dimensions().rows || rolesPanel || roomTree || memberMenu) return;
    if (!mouseActive) return;
    const frame = inline ? inlineFrame : previousFrame;
    const offset = inline && frame ? dimensions().rows - frame.lines.length : 0;
    const hit = frame?.attention?.find(hit => hit.row + offset === row - 1);
    // During a review the control always means "next": a frame drawn before
    // the landed message's acknowledgement may still name it.
    if (hit) { if (unreadReview === null) visitUnread(hit.event_seq); else if (!viewAttention().messages.length) closeUnreadReview(); else visitUnread(); return; }
    // While reviewing, only the control advances; context rows stay unread.
    if (unreadReview !== null) return;
    const message = inline && !frame?.inline_top
      ? row - 1 < offset ? inlineHumanRows.get(inlineOutputRows - offset + row - 1) : undefined
      : frame?.human_messages?.find(hit => hit.row === row - 1)?.event_seq;
    if (message !== undefined) acknowledge(String(message));
  };
  const runCommand = (name: string, args = "") => {
    switch (name) {
      case "quit":
      case "exit":
      case "q":
        stop();
        return;
      case "clear": {
        if (args.trim()) { print("Use /clear to clear this room view; harness controls are separate."); return; }
        // Persist first: a failed write must leave the current view intact.
        clearedThrough = runtime.commands.clearHumanChat(identity, { room_id: roomId }).event_seq;
        transcript.clear();
        inlinePinHistory.reset();
        nativeScrollLedger.reset();
        inlineHistoryInitialized = false;
        inlineNeedsRebuild = false;
        nativeAway = false;
        inlineFrame = null;
        previousFrame = null;
        inlineOutputRows = inlineVisibleFloor = inlinePanelRows = 0;
        inlineHumanRows.clear();
        inlineReceiptRows.clear();
        visibleAttention.clear();
        awaitingReceipt.clear();
        trackedEvents.clear();
        deliveryStates.clear();
        historyCursor = clearedThrough + 1;
        historyExhausted = false;
        historyBefore = undefined;
        previousConversationEvent = undefined;
        printedSection = undefined;
        lastPrinted = "info";
        attention = runtime.commands.getHumanAttention({ room_id: roomId, human_id: selfId });
        humanAcknowledged = new Set(attention.acknowledged ?? []);
        hint = "Chat cleared · /older for saved messages";
        if (terminal) output.write("\u001b[3J\u001b[H\u001b[2J");
        if (inline) onResize(); else redraw();
        return;
      }
      case "bottom":
        if (unreadReview !== null) { closeUnreadReview(); return; }
        if (inline) {
          print("Use your terminal's scroll-to-bottom shortcut to return to live messages.");
          return;
        }
        transcript.scrollToBottom();
        redraw();
        return;
      case "older": {
        if (!inline) { scrollHistory(-100); return; }
        if (historyExhausted) { print("No older saved messages."); return; }
        const entries: RoomEvent[] = [];
        for (let page = 0; page < 10 && !historyExhausted; page++) {
          const earlier = runtime.commands.getRecentRoomEvents({
            room_id: roomId, limit: 100, before_event_seq: historyCursor,
            event_types: showTurnEvents ? undefined : CONVERSATION_EVENTS
          });
          // The service applies all filters before LIMIT; a short page is EOF.
          historyExhausted = earlier.length < 100;
          if (earlier.length) historyCursor = earlier[0].event_seq;
          entries.push(...earlier.filter(event => render(event) !== null));
          if (entries.length) break;
        }
        if (!entries.length) {
          print(historyExhausted ? "No older saved messages." : "No visible messages in this page; use /older to continue.");
          return;
        }
        hydrateReceipts(entries);
        const lines = entries.map(event => render(event)!).join("\n\n");
        print(`── Earlier saved messages ──\n${lines}\n── End of earlier page · /older for more ──`);
        return;
      }
      case "who":
        refreshMembers();
        print(describeRoom());
        return;
      case "roles": {
        const [action, target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        try {
          if (!action) {
            if (editor) { openRolesPanel(); return; }
            print(roomRoleBlock(runtime, roomId, null));
            return;
          }
          if (action === "default") {
            if (!target) { print("Usage: /roles default <harness> <roles|none|clear>"); return; }
            const roles = parseRoleList(rest.join(" "));
            void applyRoleDraft(runtime, identity, roomId, { defaults: { [target]: roles } }, roleOptions)
              .then(result => print(sanitizeChatText(result.summary)))
              .catch(error => print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`));
            return;
          }
          if (action === "set") {
            if (!target) { print("Usage: /roles set <agent|harness> <roles|none|clear>"); return; }
            void applyRoleChanges(runtime, identity, roomId, [{ subject: parseRoleSubject(target), roles: parseRoleList(rest.join(" ")) }])
              .then((result) => print(`Roles v${result.version} applied; told ${result.recipients.map((id) => sanitizeChatText(nameOf(id))).join(", ") || "nobody"}.`))
              .catch((error) => print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`));
            return;
          }
          print("Usage: /roles · /roles set <agent|harness> <roles|none|clear> · /roles default <harness> <roles|none|clear>");
        } catch (error) {
          print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case "rooms": {
        if (args.trim()) {
          try {
            const room = resolveRoomSelector(runtime.commands.listRooms({}).rooms.filter(room => room.state !== "closed"), args.trim(), consoleState?.anchor ?? options.context_path);
            switchTo(room, true);
          } catch (error) { print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`); }
          return;
        }
        if (editor) { openRoomTree(); return; }
        if (!consoleState) { print("This console shows one room."); return; }
        print(["Active rooms on this host:", ...treeRooms().filter(room => room.active).map(room =>
          `${room.id === roomId ? "*" : " "} #${sanitizeChatText(room.name)}  ${sanitizeChatText(room.path)}  ${room.agents} agents · ${room.consoles} consoles · ${room.id}`),
          "Open with /rooms <room-id>. /go stays within this repository."].join("\n"));
        return;
      }
      case "attach": {
        const file = args.trim();
        if (!file) {
          print("Usage: /attach <image file>. Ctrl+V attaches the clipboard's image.");
          return;
        }
        try {
          const marker = images.fromPastedText(file) ?? images.fromFile(file);
          editor?.insertText(`${marker} `);
        } catch (error) {
          print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case "go": {
        if (!consoleState) { print("This console shows one room."); return; }
        if (!args.trim()) { print("Usage: /go <room>, e.g. /go api, /go root"); return; }
        try {
          // /go stays inside this console's repository.
          const local = runtime.commands.listRooms({}).rooms.filter((room) =>
            isWithinOrSame(room.canonical_path, consoleState.anchor) && !insideNestedRepository(room.canonical_path, consoleState.anchor));
          let room: PathRoom;
          try {
            room = resolveRoomSelector(local, args.trim(), consoleState.anchor);
          } catch (error) {
            // A directory (relative to this checkout) opens its room the way a
            // join from there would, e.g. a committed declaration nobody has
            // joined yet on this machine. Only for a plain path-shaped argument
            // with no match at all: `#name` and ambiguous names keep their error.
            const target = args.trim();
            const noMatch = error instanceof Error && error.message.startsWith("No open room matches");
            const opened = noMatch && !target.startsWith("#") ? openRoomAtPath(target) : null;
            if (!opened) throw error;
            room = opened;
          }
          switchTo(room);
        } catch (error) {
          print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
        }
        return;
      }
      case "members": {
        openMemberMenu();
        return;
      }
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
        print(`Removed ${sanitizeChatText(target.agent_id)} from the room.${ownershipNote} The harness was not stopped.`, "ok");
        return;
      }
      case "unread":
        visitUnread();
        return;
      case "ack":
        acknowledge(args);
        return;
      case "theme": {
        try {
          if (args.trim()) {
            const previous = chatThemeName();
            setChatTheme(args);
            try { runtime.commands.setHumanChatTheme(identity, { room_id: roomId, theme: chatThemeName() }); }
            catch (error) { setChatTheme(previous); throw error; }
            themeSource = "saved";
            if (consoleState) consoleState.theme_source = themeSource;
          }
          transcript.invalidate();
          previousFrame = null;
          print(`Theme: ${chatThemeName()} (${themeSource}). Choose /theme lantern, /theme tide or /theme dusk.`, "ok");
          // Inline output already written to the normal screen is outside the
          // composer diff. Rebuild its visible tail, as for terminal reflow.
          if (inline) onResize();
        } catch (error) {
          print(`! ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      case "events":
        showTurnEvents = !showTurnEvents;
        transcript.invalidate();
        print(`Stick events ${showTurnEvents ? "shown" : "hidden"}.`);
        return;
      case "help":
        print(formatChatHelp(dimensions().columns - 1, options.color, args.trim() === "keys", inline, terminalColorMode()));
        return;
      default:
        print(`! Unknown command /${name}. Try /help.`);
    }
  };

  // Messages are separated by a blank line; consecutive stick/membership
  // lines stay compact underneath the message they follow.
  let lastPrinted: "message" | "system" | "info" = "info";
  const printEvent = (event: RoomEvent, historical = false) => {
    if (event.event_seq <= clearedThrough) return;
    if (!historical && event.event_type === "message_sent" && event.from_agent_id?.startsWith("human:")) {
      // Named recipients are known from the event itself; a room message's
      // recipients come from this console's own send result instead.
      // Every recipient gets a pending icon from the first paint, taken from
      // the send-time snapshot on the event itself, so later acks only swap it.
      const payload = event.payload as { recipients?: unknown; sent_to?: unknown } | null;
      const listed = Array.isArray(payload?.recipients) ? payload.recipients : payload?.sent_to;
      const recipients = event.to_agent_id ? [event.to_agent_id]
        : Array.isArray(listed) ? listed.filter((id): id is string => typeof id === "string") : [];
      if (recipients.length > 0) trackedEvents.set(event.event_seq, event);
      while (trackedEvents.size > 2_000) trackedEvents.delete(trackedEvents.keys().next().value!);
      for (const agent of recipients) {
        const states = deliveryStates.get(event.event_seq);
        if (!states?.has(agent)) rememberDelivery(event.event_seq, agent, "sent");
        if (deliveryStates.get(event.event_seq)?.get(agent) !== "delivered") trackReceipt(event.event_seq, agent);
      }
    }
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
    if (terminal) transcript.appendEvent(event);
    if (fullscreen) {
      if (
        event.event_type === "message_sent" &&
        event.to_agent_id === selfId &&
        event.from_agent_id !== selfId
      )
        output.write("\u0007");
      redraw();
      return;
    }
    if (inline && inlineTopMode()) {
      drawTopViewport();
      lastPrinted = event.event_type === "message_sent" ? "message" : "system";
      return;
    }
    const line = render(event);
    if (line === null) {
      return;
    }
    const section = chatSectionLabel(event, formatContext());
    if (section !== printedSection) {
      if (inline) writeInline(`── ${section} ──`);
      else print(`── ${section} ──`);
      printedSection = section;
    }
    const isMessage = event.event_type === "message_sent";
    if (isMessage || lastPrinted === "message") {
      if (inline) writeInline(""); else print("");
    }
    const forMe =
      isMessage &&
      event.to_agent_id === selfId &&
      event.from_agent_id !== selfId;
    const headerRow = inlineOutputRows;
    if (inline && isHumanAttentionMessage(event, selfId) && !humanAcknowledged.has(event.event_seq)) {
      const rows = line.split(/\r?\n/).flatMap(text => wrapStyledLine(text, Math.max(1, dimensions().columns - 1)));
      for (let offset = 0; offset < rows.length; offset++) inlineHumanRows.set(headerRow + offset, event.event_seq);
    }
    if (inline) writeInline(forMe ? `${line}\u0007` : line);
    else print(forMe && terminal ? `${line}\u0007` : line);
    if (inline && deliveryStates.has(event.event_seq)) inlineReceiptRows.set(event.event_seq, headerRow);
    lastPrinted = isMessage ? "message" : "system";
  };

  // The input controller inserts the marker and holds later keys until then.
  const pasteImage = async (): Promise<string | null> => {
    try {
      const marker = await images.fromClipboard();
      if (!marker && !closed) print("No image on the clipboard.");
      return marker;
    } catch (error) {
      if (!closed) print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
      return null;
    }
  };

  // A Cmd+V the terminal forwarded as a key: an image when there is one,
  // otherwise the clipboard text, as an ordinary paste would insert it.
  const pasteClipboard = async (): Promise<string | null> => {
    try {
      const marker = await images.fromClipboard();
      if (marker) return `${marker} `;
      const text = await readClipboardText();
      if (text) return images.fromPastedText(sanitizeChatText(text)) ?? sanitizeChatText(text);
      if (!closed) print("The clipboard is empty.");
      return null;
    } catch (error) {
      if (!closed) print(`! ${sanitizeChatText(error instanceof Error ? error.message : String(error))}`);
      return null;
    }
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

  const onCycleRoom = (direction: -1 | 1) => {
    if (!consoleState) return;
    refreshStrip();
    const ring = [joined.canonical_path, ...cycleOrder.map((room) => room.canonical_path)].sort();
    if (ring.length < 2) { print("No other open rooms in this repository."); return; }
    const next = ring[(ring.indexOf(joined.canonical_path) + direction + ring.length) % ring.length];
    const room = cycleOrder.find((candidate) => candidate.canonical_path === next);
    if (room) switchTo(room);
  };
  const onEmptyEscape = () => {
    void (async () => {
      try {
        refreshMembers();
        const plan = planChatInterrupts(members, selfId);
        if (plan.kind === "none") {
          interruptHint = { text: "nothing to interrupt", until: Date.now() + 3_000 };
          lastInterruptSignature = interruptSignature();
          redraw();
          return;
        }
        interruptHint = null;
        await Promise.all(plan.steps.map(async (step) => {
          if (step.kind === "unsupported") return;
          if (step.kind === "codex") {
            const member = members.find((candidate) => candidate.agent_id === step.agent_id);
            let result = await interruptCodexThread(step.thread_id);
            let keySent = false;
            if (["unavailable", "failed"].includes(result) && member) {
              const paneResult = interruptCodexHerdr(member);
              if (paneResult !== "unavailable") { result = paneResult; keySent = paneResult === "sent"; }
            }
            if (result !== "idle") interruptIndicators.set(step.agent_id, {
              kind: "timed", label: keySent ? "cancel requested" : result === "sent" ? "interrupted" : `interrupt ${result}`,
              until: Date.now() + 3_000
            });
            return;
          }
          const result = requestHookInterrupt("claude", step.session_id);
          interruptIndicators.set(step.agent_id, result === "failed"
            ? { kind: "timed", label: "interrupt failed", until: Date.now() + 3_000 }
            : { kind: "claude", session_id: step.session_id });
        }));
        if (!closed) {
          lastInterruptSignature = interruptSignature();
          redraw();
        }
      } catch (error) {
        if (isRoomGone(error)) {
          reportRoomClosed();
          stop();
        } else if (!closed) {
          interruptHint = { text: "interrupt unavailable", until: Date.now() + 3_000 };
          lastInterruptSignature = interruptSignature();
          redraw();
        }
      }
    })();
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
  const onInterrupt = () => { if (!externalEditorActive) editor?.clear(); };
  const resumeNativeScrollOnInput = () => {
    if (closed || externalEditorActive || !nativeAway) return;
    // Herdr returns to the live tail before forwarding operator input. Resume
    // even if its scroll event lags or the stream died, without pretending
    // that any pending message was read or acknowledged.
    nativeAway = false;
    resumeInlineTail();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  if (terminal) {
    process.on("SIGINT", onInterrupt);
    process.on("exit", restore);
    process.on("uncaughtExceptionMonitor", restore);
    output.on("resize", onResize);
  }
  try {
    if (terminal && options.herdr && readHerdrPluginState(options.herdr.runner) === "enabled") {
      try {
        chatLinks = await startChatLinkServer({ paneId: options.herdr.pane_id, onAck: seq => {
          if (closed || externalEditorActive) return false;
          if (unreadReview === null) return visitUnread(seq);
          if (!viewAttention().messages.length) { closeUnreadReview(); return true; }
          return visitUnread();
        } });
      } catch { /* Pins and /ack still work without a local link endpoint. */ }
    }
    const herdrSocket = options.herdr?.socket_path;
    if (inline && terminal && options.herdr && herdrSocket) {
      // Without the stream, pending messages simply pin when pushed off screen.
      nativeScroll = subscribePaneScroll({ socketPath: herdrSocket, paneId: options.herdr.pane_id, onScroll: scroll => {
        if (closed) return;
        const away = scroll.offset_from_bottom > 0;
        const awayChanged = away !== nativeAway;
        if (away && awayChanged) freezeInlineHistory();
        nativeAway = away;
        const seqs = unreadReview === null ? nativeScrollLedger.observe(scroll) : [];
        transcript.markHumanMessagesTraversed(seqs);
        acknowledgeTraversed();
        if (!away && awayChanged && inlineNeedsRebuild) {
          resumeInlineTail();
        } else if (attention.total > 0 && (awayChanged || attention.messages.some(event => seqs.includes(event.event_seq)))) drawComposer();
      } });
    }
    if (fullscreen) {
      screenActive = true;
      output.write(
        "\u001b[?1049h\u001b[?2004h" + ENHANCED_KEYS_ON +
          (options.mouse === true ? "\u001b[?1000h\u001b[?1006h" : "")
      );
      editor = new ChatInputController({
        input: options.input,
        columns: dimensions().columns - 1,
        onChange: () => {
          if (editor?.draft.line) { hint = null; interruptHint = null; }
          redraw();
        },
        onSubmit: submit,
        onClear: () => {
          hint = "type /quit to exit";
        },
        onEmptyEscape,
        onCycleRoom,
        onRoomTree: openRoomTree,
        onImagePaste: pasteImage,
        onClipboardPaste: pasteClipboard,
        transformPaste: (text) => images.fromPastedText(text),
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
        onClick,
        onRightClick: (column, row) => {
          if (!options.mouse || rolesPanel || memberMenu) return;
          const target = chatMemberAt(previousFrame, column, row);
          if (target) openMemberMenu(target);
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
      // The terminal keeps its normal screen and owns scrollback, selection,
      // and the wheel. The same editor as full-screen mode handles bracketed
      // paste, multiline drafts, and completion; only the drawing differs.
      inlineActive = true;
      // Start at the bottom row so the composer sits at the foot of the pane
      // from the first frame and history grows upward above it. Padding only
      // to the bottom keeps whatever was already on screen in view.
      const row = await queryCursorRow(options.input, output);
      const rows = dimensions().rows;
      if (row !== null && row < rows) output.write("\n".repeat(rows - row));
      output.write("\u001b[?2004h" + ENHANCED_KEYS_ON);
      editor = new ChatInputController({
        input: options.input,
        columns: dimensions().columns - 1,
        onChange: () => {
          if (editor?.draft.line) interruptHint = null;
          drawComposer();
        },
        onSubmit: (line) => {
          eraseComposer();
          submit(line);
          drawComposer();
        },
        onClear: () => {
          hint = "type /quit to exit";
        },
        onEmptyEscape,
        onCycleRoom,
        onRoomTree: openRoomTree,
        onImagePaste: pasteImage,
        onClipboardPaste: pasteClipboard,
        transformPaste: (text) => images.fromPastedText(text),
        onClick,
        onQuit: stop,
        // Scrollback belongs to the terminal in this mode.
        onBottom: () => {},
        onScroll: () => {},
        completionCount: (draft) => completionsFor(draft).length,
        complete: (draft, index) => {
          const matches = completionsFor(draft);
          return matches[Math.min(index, matches.length - 1)]?.draft ?? null;
        }
      });
      // A data listener starts input flowing. On Windows, a cooked read can
      // discard the pending resize from `tt up` before raw mode is enabled.
      // Attach only after the editor owns raw mode, preserving its restoration
      // on exit. Still resume the viewport before the editor handles each key.
      if (nativeScroll) options.input.prependListener("data", resumeNativeScrollOnInput);
      drawComposer();
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
              after_event_seq: clearedThrough,
              before_event_seq: head + 1,
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
    hydrateReceipts(historyEvents);
    for (const event of historyEvents) {
      printEvent(event, true);
    }

    refreshAttention();
    refreshReleaseStatus();
    redraw();
    if (inline && attention.total) onResize();

    let cursor = head;
    viewedSeq = head;
    const savedDraft = consoleState?.drafts.get(roomId);
    if (savedDraft) editor?.setDraft(savedDraft);
    if (refreshStrip()) redraw();
    let busyAttempts = 0;
    let lastWakeRelay = Date.now();
    while (!closed) {
      try {
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
        if (statusStale) refreshReleaseStatus();
        if (
          stateChanged ||
          statusStale ||
          Date.now() - lastPresenceRefresh >= PRESENCE_REFRESH_MS
        ) {
          refreshMembers();
        }
        if (consoleState && Date.now() - lastStripRefresh >= STRIP_REFRESH_MS) {
          const changed = refreshStrip();
          refreshTree();
          if (changed || roomTree) redraw();
        }
        hydrateReceipts(result.events);
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
        viewedSeq = cursor;
        if (!closed && (result.events.length > 0 || Date.now() - lastWakeRelay >= WAKE_RELAY_MS)) {
          lastWakeRelay = Date.now();
          await runtime.commands.flushWakes(roomId).catch(() => { /* pending wakes stay durable */ });
        }
        if (!closed) {
          checkReceipts();
          if (result.events.some(event => event.event_type === "message_sent") || statusStale) refreshAttention();
        }
        const interruptChanged = (interruptIndicators.size > 0 || interruptHint !== null) &&
          interruptSignature() !== lastInterruptSignature;
        if ((stateChanged || statusStale || interruptChanged) && !closed) {
          lastInterruptSignature = interruptSignature();
          redraw();
          lastStatusDraw = Date.now();
        }
        if (busyAttempts) {
          busyAttempts = 0;
          hint = null;
          redraw();
        }
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        // Presence and maintenance writes may contend even during a read
        // cycle. Keep the editor alive and retry from the last rendered event.
        // Never retry a send here: its commit may already have succeeded.
        busyAttempts++;
        hint = "database busy · retrying";
        if (busyAttempts === 1) {
          if (terminal) redraw();
          else print("Database busy; waiting to reconnect.");
        }
        if (!closed) await sleep(Math.min(2_000, 100 * 2 ** Math.min(busyAttempts - 1, 5)));
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
    try {
      await runtime.commands.flushWakes(roomId);
    } catch {
      // Pending wakes remain durable; cleanup must not replace the real error.
    }
    if (consoleState) {
      consoleState.last_seen.set(roomId, Math.max(viewedSeq, consoleState.last_seen.get(roomId) ?? 0));
      if (editor) consoleState.drafts.set(roomId, editor.draft.line);
    }
    // A switching console stays a member so agents here can still reply to it;
    // the caller leaves every visited room when chat exits.
    if (!switchTarget) {
      try {
        runtime.commands.leaveRoom(identity, { room_id: roomId });
      } catch {
        // The room may already be gone; leaving is best-effort on exit.
      }
    }
  }
  return switchTarget ? { kind: "switch", room: switchTarget } : { kind: "quit" };
}


// Short names for the strip: `root` for the repository room, else the
// declared name or basename, lengthened to the shortest unique path suffix
// when two rooms share it (`web/api`, `svc/api`).
export function uniqueRoomNames(rooms: ReadonlyArray<Pick<PathRoom, "room_id" | "canonical_path">>, anchor: string): Map<string, string> {
  const names = new Map<string, string>();
  const base = (room: Pick<PathRoom, "canonical_path">) => room.canonical_path === anchor ? "root" : roomShortName(room);
  const counts = new Map<string, number>();
  for (const room of rooms) counts.set(base(room), (counts.get(base(room)) ?? 0) + 1);
  for (const room of rooms) {
    let name = base(room);
    if ((counts.get(name) ?? 0) > 1 && name !== "root") {
      const parts = path.relative(anchor, room.canonical_path).split(path.sep);
      for (let take = 2; take <= parts.length; take++) {
        name = parts.slice(-take).join("/");
        const suffix = name;
        if (rooms.filter((other) => other.canonical_path.endsWith(`${path.sep}${suffix.split("/").join(path.sep)}`)).length === 1) break;
      }
    }
    names.set(room.room_id, name);
  }
  return names;
}

function isRoomGone(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === "room_not_found";
}

type CursorQueryInput = Readable & { isRaw?: boolean; setRawMode?: (raw: boolean) => void };

// Asks the terminal for the cursor row (DSR 6). Resolves null when the input
// is not a raw-capable TTY or no report arrives in time, so callers keep the
// unpadded layout rather than guessing.
export function queryCursorRow(input: Readable, output: NodeJS.WritableStream, timeoutMs = 200): Promise<number | null> {
  const raw = input as CursorQueryInput;
  if (typeof raw.setRawMode !== "function") return Promise.resolve(null);
  const wasRaw = Boolean(raw.isRaw);
  raw.setRawMode(true);
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (row: number | null) => {
      clearTimeout(timer);
      input.off("data", onData);
      input.pause();
      if (!wasRaw) raw.setRawMode?.(false);
      resolve(row);
    };
    const onData = (data: Buffer | string) => {
      buffer += data.toString();
      const report = /\u001b\[(\d+);\d+R/.exec(buffer);
      if (report) finish(Number(report[1]));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.on("data", onData);
    input.resume();
    output.write("\u001b[6n");
  });
}
