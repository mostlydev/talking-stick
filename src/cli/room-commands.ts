import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { deriveCliIdentity, resolveCliIdentity } from "./identity.js";
import {
  createSystemProcessInspector,
  findCliSessionForContextPath,
  removeCliSession,
  removeCliSessionsForRoom,
  resolveCliSessionPath,
  type GetRoomHealthResult,
  type HiddenRowsSummary,
  type PathRoom,
  type RoomEvent
} from "../index.js";
import { checkGuardianLiveness, stopGuardian } from "./guardian.js";
import {
  getStringOption,
  hasOption,
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import {
  formatRelativeTime,
  printResult
} from "./output.js";
import {
  parseEventTypeFilter,
  runEventStream
} from "./event-stream.js";
import {
  resolveSessionForReads,
  upsertSessionFromJoin
} from "./session.js";
import type { Runtime } from "./runtime.js";

export function handleListCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const result = runtime.commands.listRooms({ context_path: contextPath });
  printResult(parsed, result, () => {
    if (result.rooms.length === 0) {
      return "No rooms found.";
    }

    return result.rooms
      .map((room) => {
        const owner = room.owner ? ` owner=${room.owner}` : "";
        const reserved = room.reserved_for
          ? ` reserved_for=${room.reserved_for}`
          : "";
        return `${room.state} ${room.canonical_path}${owner}${reserved}`;
      })
      .join("\n");
  });
}

export function handleJoinCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, {
    context_path: contextPath,
    force_new: parsed.options.has("force-new")
  });
  upsertSessionFromJoin(identity, joined);

  printResult(parsed, joined, () => {
    const lines = [`Joined ${joined.canonical_path} as ${joined.agent_id}`];
    if (joined.warning) {
      lines.push(`Warning: ${joined.warning}`);
    }
    return lines.join("\n");
  });
}

export function handleLeaveCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  const result = runtime.commands.leaveRoom(identity, {
    room_id: session.room_id
  });
  const sessionPath = resolveCliSessionPath();

  if (result.status === "room_deleted") {
    removeCliSessionsForRoom(sessionPath, session.room_id);
  } else {
    removeCliSession(sessionPath, identity.agent_id, session.room_id);
  }

  stopGuardian(
    session.guardian_pid ?? null,
    session.guardian_process_started_at ?? null
  );

  printResult(parsed, result, () => {
    if (result.status === "room_deleted") {
      return `Left ${session.canonical_path}; room deleted.`;
    }

    const memberLabel =
      result.remaining_members === 1 ? "member remains" : "members remain";
    return `Left ${session.canonical_path}; ${result.remaining_members} ${memberLabel}.`;
  });
}

export function handleKickCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const [target, ...rest] = parsed.positionals;
  if (!target) {
    throw new Error("Missing required argument: <agent_id>");
  }
  const sessionParsed: ParsedCommand = { ...parsed, positionals: rest };
  const identity = deriveCliIdentity(sessionParsed);
  const session = resolveSessionForReads(runtime, sessionParsed, identity);
  const result = runtime.commands.kickMember(identity, {
    room_id: session.room_id,
    target_agent_id: target,
    force: hasOption(parsed, "force"),
    reason: getStringOption(parsed, "reason")
  });

  const sessionPath = resolveCliSessionPath();
  if (result.status === "room_deleted") {
    removeCliSessionsForRoom(sessionPath, session.room_id);
  } else {
    removeCliSession(sessionPath, result.kicked_agent_id, session.room_id);
  }

  printResult(parsed, result, () => {
    if (result.status === "room_deleted") {
      return `Kicked ${result.kicked_agent_id}; room deleted.`;
    }
    const memberLabel =
      result.remaining_members === 1 ? "member remains" : "members remain";
    return `Kicked ${result.kicked_agent_id}; ${result.remaining_members} ${memberLabel}.`;
  });
}

export function handleStateCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  const state = runtime.commands.getRoomState({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    process_metadata: identity.process_metadata,
    include_all: hasOption(parsed, "all") ? true : false
  });

  printResult(parsed, state, () => {
    const lines: string[] = [
      `Room: ${session.canonical_path} (${state.room.state})`
    ];

    if (state.room.owner) {
      const lease = state.room.lease_expires_at
        ? `, lease expires ${formatRelativeTime(state.room.lease_expires_at)}`
        : "";
      lines.push(
        `  Owner:    ${state.room.owner} (turn ${state.room.turn_id}${lease})`
      );
    } else if (state.room.reserved_for) {
      const claim = state.room.claim_expires_at
        ? `, claim expires ${formatRelativeTime(state.room.claim_expires_at)}`
        : "";
      lines.push(
        `  Reserved: ${state.room.reserved_for} (turn ${state.room.turn_id}${claim})`
      );
    } else {
      lines.push(`  Owner:    — (turn ${state.room.turn_id})`);
    }

    const active = state.members.filter((m) => m.status === "active");
    const inactive = state.members.filter((m) => m.status !== "active");
    lines.push(
      `  Members:  ${active.length} active${inactive.length > 0 ? `, ${inactive.length} inactive` : ""}`
    );
    for (const member of state.members) {
      const marker = member.agent_id === identity.agent_id ? "  ← you" : "";
      const seen = `last seen ${formatRelativeTime(member.last_seen_at)}`;
      lines.push(
        `            • ${member.agent_id.padEnd(24)} ${member.status.padEnd(8)} ${seen}${marker}`
      );
    }
    const hiddenMembers = formatHiddenSummary("member", state.hidden?.members);
    if (hiddenMembers) {
      lines.push(`  Hidden:   ${hiddenMembers}`);
    }

    return lines.join("\n");
  });
}

export async function handleEventsCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  if (hasOption(parsed, "wait") || hasOption(parsed, "follow")) {
    await runEventStream(runtime, parsed, identity, session.room_id, {
      event_type: parseEventTypeFilter(getStringOption(parsed, "event")),
      default_target: "self",
      force_tail_cursor: false
    });
    return;
  }

  const useFullHistory =
    hasOption(parsed, "all") ||
    hasOption(parsed, "after") ||
    hasOption(parsed, "limit");
  const view = runtime.commands.getRoomEventsView({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit"),
    process_metadata: identity.process_metadata,
    include_all: useFullHistory ? true : false
  });

  printResult(parsed, view, () =>
    renderEventsText(view.events, view.hidden?.events)
  );
}

export function handleHealthCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const health = runtime.commands.getRoomHealth({
    context_path: contextPath,
    agent_id: identity.agent_id,
    include_all: hasOption(parsed, "all")
  });
  const result = {
    ...health,
    local: buildLocalHealth(identity.agent_id, contextPath, health),
    workspace: {
      git: buildGitAdvisory(contextPath)
    }
  };

  printResult(parsed, result, () => renderHealthText(result, identity.agent_id));
}

type HealthCliResult = GetRoomHealthResult & {
  local: LocalHealth;
  workspace: {
    git: GitAdvisory;
  };
};

interface LocalHealth {
  identity: {
    agent_id: string;
  };
  session:
    | {
        found: true;
        room_id: string;
        canonical_path: string;
        lease_id: string | null;
        turn_id: number | null;
        guardian_pid: number | null;
        guardian_process_started_at: string | null;
        protects_current_turn: boolean;
      }
    | {
        found: false;
      };
  guardian: {
    liveness: "alive" | "gone" | "unknown" | "not_recorded";
    pid: number | null;
    process_started_at: string | null;
    protects_current_turn: boolean;
  };
  receivers: ReceiverHealth;
}

interface ReceiverHealth {
  status: "scanned" | "unsupported" | "error";
  processes: Array<{
    pid: number;
    started_at: string | null;
    cwd: string | null;
    kind: "wait-events" | "events-follow" | "msg-recv";
    command: string;
  }>;
  duplicate_count: number;
  stale_count: number;
  error?: string;
}

type GitAdvisory =
  | {
      status: "available";
      branch: string | null;
      tracked_changed_count: number;
      untracked_count: number;
      raw: string[];
    }
  | {
      status: "unavailable";
      reason: string;
    };

function renderEventsText(
  events: RoomEvent[],
  hidden?: HiddenRowsSummary
): string {
  if (events.length === 0) {
    const hiddenLine = formatHiddenSummary("event", hidden);
    return hiddenLine ? `No recent events. ${hiddenLine}` : "No events.";
  }

  const lines: string[] = [];
  let lastTurn: number | null = null;
  for (const event of events) {
    if (event.turn_id !== lastTurn) {
      if (lines.length > 0) lines.push("");
      lines.push(
        `Turn ${event.turn_id} (${formatRelativeTime(event.created_at)})`
      );
      lastTurn = event.turn_id;
    }
    const reason = event.reason ? ` (${event.reason})` : "";
    const arrow =
      event.from_agent_id && event.to_agent_id
        ? `${event.from_agent_id} → ${event.to_agent_id}`
        : event.to_agent_id
          ? `→ ${event.to_agent_id}`
          : event.from_agent_id ?? "—";
    lines.push(`  ${event.event_type.padEnd(8)} ${arrow}${reason}`);
  }

  const hiddenLine = formatHiddenSummary("event", hidden);
  if (hiddenLine) {
    lines.push("", `Hidden: ${hiddenLine}`);
  }
  return lines.join("\n");
}

function renderHealthText(result: HealthCliResult, callerAgentId: string): string {
  const lines: string[] = [`Room: ${result.room.canonical_path} (${result.room.state})`];

  if (result.room.owner) {
    const lease = result.room.lease_expires_at
      ? `, lease expires ${formatRelativeTime(result.room.lease_expires_at)}`
      : "";
    lines.push(`  Owner:    ${result.room.owner} (turn ${result.room.turn_id}${lease})`);
  } else if (result.room.reserved_for) {
    const claim = result.room.claim_expires_at
      ? `, claim expires ${formatRelativeTime(result.room.claim_expires_at)}`
      : "";
    lines.push(`  Reserved: ${result.room.reserved_for} (turn ${result.room.turn_id}${claim})`);
  } else {
    lines.push(`  Owner:    — (turn ${result.room.turn_id})`);
  }

  lines.push(
    `  Pending:  ${
      result.pending_handoff
        ? formatEventSummary(result.pending_handoff)
        : "none"
    }`
  );
  lines.push(
    result.takeover.available
      ? `  Takeover: available (${result.takeover.reason})`
      : "  Takeover: not available"
  );

  lines.push("", "Local:");
  lines.push(`  Identity: ${result.local.identity.agent_id}`);
  if (result.local.session.found) {
    lines.push(
      `  Session:  ${result.local.session.room_id} (turn ${result.local.session.turn_id ?? "-"})`
    );
  } else {
    lines.push("  Session:  none");
  }
  lines.push(
    `  Guardian: ${formatGuardianHealth(result.local.guardian)}`
  );
  lines.push(
    `  Receivers: ${formatReceiverHealth(result.local.receivers)}`
  );

  lines.push("", "Workspace:");
  lines.push(`  Git:      ${formatGitAdvisory(result.workspace.git)}`);

  lines.push("", "Members:");
  for (const member of result.members) {
    const marker = member.agent_id === callerAgentId ? "  ← you" : "";
    lines.push(
      `  ${member.agent_id.padEnd(24)} ${member.status.padEnd(8)} last seen ${formatRelativeTime(member.last_seen_at)}${marker}`
    );
  }
  const hiddenMembers = formatHiddenSummary("member", result.hidden?.members);
  if (hiddenMembers) {
    lines.push(`  Hidden: ${hiddenMembers}`);
  }

  return lines.join("\n");
}

function buildLocalHealth(
  agentId: string,
  contextPath: string,
  health: GetRoomHealthResult
): LocalHealth {
  const session = findCliSessionForContextPath(
    resolveCliSessionPath(),
    agentId,
    contextPath
  );
  const protectsCurrentTurn = Boolean(
    session &&
      session.room_id === health.room.room_id &&
      session.lease_id === health.room.lease_id &&
      session.turn_id === health.room.turn_id &&
      health.room.owner === agentId
  );
  const guardianLiveness =
    session?.guardian_pid !== undefined &&
    session.guardian_pid !== null
      ? checkGuardianLiveness(
          {
            pid: session.guardian_pid,
            process_started_at: session.guardian_process_started_at
          },
          createSystemProcessInspector()
        )
      : "not_recorded";

  return {
    identity: { agent_id: agentId },
    session: session
      ? {
          found: true,
          room_id: session.room_id,
          canonical_path: session.canonical_path,
          lease_id: session.lease_id ?? null,
          turn_id: session.turn_id ?? null,
          guardian_pid: session.guardian_pid ?? null,
          guardian_process_started_at:
            session.guardian_process_started_at ?? null,
          protects_current_turn: protectsCurrentTurn
        }
      : { found: false },
    guardian: {
      liveness: guardianLiveness,
      pid: session?.guardian_pid ?? null,
      process_started_at: session?.guardian_process_started_at ?? null,
      protects_current_turn: protectsCurrentTurn && guardianLiveness !== "gone"
    },
    receivers: scanReceiverProcesses(health.room)
  };
}

function scanReceiverProcesses(room: PathRoom): ReceiverHealth {
  if (process.platform === "win32") {
    return {
      status: "unsupported",
      processes: [],
      duplicate_count: 0,
      stale_count: 0
    };
  }

  try {
    const output = execFileSync(
      "ps",
      ["-axo", "pid=,lstart=,command="],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          LC_ALL: "C"
        }
      }
    ) as string;
    const processes = output
      .split("\n")
      .map(parseProcessLine)
      .filter((row): row is NonNullable<ReturnType<typeof parseProcessLine>> =>
        Boolean(row)
      )
      .map((row) => {
        const kind = receiverKind(row.command);
        if (!kind) {
          return null;
        }
        const cwd = readProcessCwd(row.pid);
        if (!processMatchesRoom(row.command, cwd, room)) {
          return null;
        }
        return {
          pid: row.pid,
          started_at: row.started_at,
          cwd,
          kind,
          command: row.command
        };
      })
      .filter(
        (
          row
        ): row is {
          pid: number;
          started_at: string | null;
          cwd: string | null;
          kind: "wait-events" | "events-follow" | "msg-recv";
          command: string;
        } => Boolean(row)
      );

    return {
      status: "scanned",
      processes,
      duplicate_count: Math.max(0, processes.length - 1),
      stale_count: 0
    };
  } catch (error) {
    return {
      status: "error",
      processes: [],
      duplicate_count: 0,
      stale_count: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseProcessLine(
  line: string
): { pid: number; started_at: string | null; command: string } | null {
  const match = line.trimStart().match(/^(\d+)\s+(.{24})\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    pid: Number.parseInt(match[1], 10),
    started_at: match[2].trim() || null,
    command: match[3].trim()
  };
}

function receiverKind(
  command: string
): "wait-events" | "events-follow" | "msg-recv" | null {
  const normalized = command.replace(/\s+/g, " ");
  if (normalized.includes(" wait ") && normalized.includes("--events")) {
    return "wait-events";
  }
  if (normalized.includes(" events ") && normalized.includes("--follow")) {
    return "events-follow";
  }
  if (
    normalized.includes(" msg ") &&
    normalized.includes(" recv ") &&
    (normalized.includes("--follow") || normalized.includes("--wait"))
  ) {
    return "msg-recv";
  }
  return null;
}

function readProcessCwd(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return fs.realpathSync.native(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  try {
    const output = execFileSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ) as string;
    const pathLine = output
      .split("\n")
      .find((line) => line.startsWith("n"));
    if (!pathLine) {
      return null;
    }
    const cwd = pathLine.slice(1);
    return cwd ? fs.realpathSync.native(cwd) : null;
  } catch {
    return null;
  }
}

function processMatchesRoom(
  command: string,
  cwd: string | null,
  room: PathRoom
): boolean {
  if (
    command.includes(room.room_id) ||
    command.includes(room.canonical_path)
  ) {
    return true;
  }

  return cwd !== null && isSameOrDescendantPath(cwd, room.canonical_path);
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function buildGitAdvisory(contextPath: string): GitAdvisory {
  try {
    const output = execFileSync(
      "git",
      ["-C", contextPath, "status", "--porcelain=v1", "--branch"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ) as string;
    const raw = output.split("\n").filter((line) => line.length > 0);
    const branch = raw.find((line) => line.startsWith("## ")) ?? null;
    const changed = raw.filter((line) => !line.startsWith("## "));
    return {
      status: "available",
      branch,
      tracked_changed_count: changed.filter((line) => !line.startsWith("??"))
        .length,
      untracked_count: changed.filter((line) => line.startsWith("??")).length,
      raw
    };
  } catch {
    return {
      status: "unavailable",
      reason: "not a git repository or git is unavailable"
    };
  }
}

function formatEventSummary(event: RoomEvent): string {
  const target = event.to_agent_id ?? "room";
  return `#${event.event_seq} ${event.event_type} ${event.from_agent_id ?? "unknown"} -> ${target}`;
}

function formatGuardianHealth(
  guardian: LocalHealth["guardian"]
): string {
  if (guardian.liveness === "not_recorded") {
    return "not recorded";
  }
  const protects = guardian.protects_current_turn
    ? ", protects current turn"
    : ", does not protect current turn";
  return `${guardian.liveness} pid=${guardian.pid ?? "-"}${protects}`;
}

function formatReceiverHealth(receivers: ReceiverHealth): string {
  if (receivers.status !== "scanned") {
    return receivers.status;
  }
  if (receivers.processes.length === 0) {
    return "none";
  }
  const duplicate =
    receivers.duplicate_count > 0 ? `, ${receivers.duplicate_count} duplicate` : "";
  return `${receivers.processes.length} live candidate${receivers.processes.length === 1 ? "" : "s"}${duplicate}`;
}

function formatGitAdvisory(git: GitAdvisory): string {
  if (git.status !== "available") {
    return git.reason;
  }
  return `${git.branch ?? "detached"}; ${git.tracked_changed_count} tracked changed, ${git.untracked_count} untracked`;
}

function formatHiddenSummary(
  noun: string,
  hidden: HiddenRowsSummary | undefined
): string | null {
  if (!hidden || hidden.older_count === 0) {
    return null;
  }

  const label = hidden.older_count === 1 ? noun : `${noun}s`;
  return `${hidden.older_count} older ${label} hidden; use --all.`;
}

export function handleWhoAmICommand(parsed: ParsedCommand): void {
  const resolved = resolveCliIdentity(parsed);
  const result = {
    agent_id: resolved.identity.agent_id,
    process_metadata: resolved.identity.process_metadata,
    source: resolved.source,
    detail: resolved.detail
  };

  printResult(parsed, result, () => {
    if (!parsed.options.has("explain")) {
      return resolved.identity.agent_id;
    }

    return [
      resolved.identity.agent_id,
      `source: ${resolved.source}`,
      `session_kind: ${resolved.identity.process_metadata.session_kind}`,
      `detail: ${resolved.detail}`
    ].join("\n");
  });
}
