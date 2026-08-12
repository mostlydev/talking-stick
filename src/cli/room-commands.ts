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
      const intent = member.wait_intent ?? "legacy";
      const standby = member.standby_transport
        ? `, standby ${member.standby_transport}${
            member.standby_wake_pending ? " pending" : ""
          }`
        : "";
      lines.push(
        `            • ${member.agent_id.padEnd(24)} ${member.status.padEnd(8)} ${seen}, intent ${intent}${standby}${marker}`
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
  const verbose = hasOption(parsed, "verbose") || hasOption(parsed, "all");
  const health = runtime.commands.getRoomHealth(identity, {
    context_path: contextPath,
    include_all: hasOption(parsed, "all")
  });
  const result = {
    ...health,
    local: buildLocalHealth(
      identity.agent_id,
      contextPath,
      health
    ),
    workspace: {
      git: buildGitAdvisory(contextPath)
    }
  };

  if (verbose) {
    printResult(parsed, result, () =>
      renderHealthText(result, identity.agent_id)
    );
    return;
  }

  const summary = buildHealthSummary(result, identity.agent_id);
  printResult(parsed, summary, () => renderHealthSummaryText(summary));
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
  status: "registered" | "scanned" | "unsupported" | "error";
  processes: Array<{
    pid: number;
    ppid: number | null;
    started_at: string | null;
    cwd: string | null;
    kind: "wait" | "wait-events" | "events-follow" | "msg-recv";
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

interface HealthSummaryResult {
  room: {
    room_id: string;
    canonical_path: string;
    state: string;
    turn_id: number;
  };
  owner: string | null;
  reserved_for: string | null;
  you_own: boolean;
  lease: {
    expires_at: string | null;
    renewing: boolean;
    status: "active" | "expired" | "none";
  };
  guardian: {
    status: LocalHealth["guardian"]["liveness"];
    protects_current_turn: boolean;
  };
  listener: {
    status: ReceiverHealth["status"];
    active: boolean;
    duplicates: number;
  };
  git: {
    dirty: boolean;
    summary: string;
  };
  next_action: string;
  hidden: {
    members_omitted: number;
    receivers_omitted: number;
  };
}

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

function buildHealthSummary(
  result: HealthCliResult,
  callerAgentId: string
): HealthSummaryResult {
  const leaseExpiresAt =
    result.room.owner !== null
      ? result.room.lease_expires_at
      : result.room.claim_expires_at;
  const leaseStatus =
    leaseExpiresAt === null
      ? "none"
      : Date.parse(leaseExpiresAt) <= Date.now()
        ? "expired"
        : "active";
  const listenerActive =
    (result.local.receivers.status === "registered" ||
      result.local.receivers.status === "scanned") &&
    result.local.receivers.processes.length > 0;

  return {
    room: {
      room_id: result.room.room_id,
      canonical_path: result.room.canonical_path,
      state: result.room.state,
      turn_id: result.room.turn_id
    },
    owner: result.room.owner,
    reserved_for: result.room.reserved_for,
    you_own: result.room.owner === callerAgentId,
    lease: {
      expires_at: leaseExpiresAt,
      renewing:
        result.local.guardian.liveness === "alive" &&
        result.local.guardian.protects_current_turn,
      status: leaseStatus
    },
    guardian: {
      status: result.local.guardian.liveness,
      protects_current_turn: result.local.guardian.protects_current_turn
    },
    listener: {
      status: result.local.receivers.status,
      active: listenerActive,
      duplicates: result.local.receivers.duplicate_count
    },
    git: {
      dirty:
        result.workspace.git.status === "available" &&
        (result.workspace.git.tracked_changed_count > 0 ||
          result.workspace.git.untracked_count > 0),
      summary: formatGitAdvisoryConcise(result.workspace.git)
    },
    next_action: getNextAction(result, callerAgentId),
    hidden: {
      members_omitted: result.hidden?.members.older_count ?? 0,
      receivers_omitted: result.receivers.filter(
        (receiver) => receiver.agent_id !== callerAgentId
      ).length
    }
  };
}

function renderHealthSummaryText(summary: HealthSummaryResult): string {
  const lines: string[] = [
    `Room:     ${summary.room.canonical_path} (${summary.room.state})`
  ];
  if (summary.owner) {
    lines.push(
      `Owner:    ${summary.owner}${summary.you_own ? " (you)" : " (someone else)"}`
    );
  } else if (summary.reserved_for) {
    lines.push(`Reserved: ${summary.reserved_for}`);
  } else {
    lines.push("Owner:    -");
  }

  const leaseExpiry = summary.lease.expires_at
    ? `, expires ${formatRelativeTime(summary.lease.expires_at)}`
    : "";
  lines.push(
    `Lease:    ${summary.lease.status}${summary.lease.renewing ? ", renewing" : ""}${leaseExpiry}`
  );
  lines.push(
    `Guardian: ${summary.guardian.status}${summary.guardian.protects_current_turn ? ", protects current turn" : ""}`
  );
  lines.push(
    `Listener: ${formatListenerSummary(summary.listener)}`
  );
  lines.push(`Git:      ${summary.git.summary}`);
  lines.push(`Next:     ${summary.next_action}`);
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
    const standby = member.standby_transport
      ? ` standby=${member.standby_transport}${
          member.standby_wake_pending ? ":pending" : ""
        }${member.standby_last_error ? ` error=${member.standby_last_error}` : ""}`
      : "";
    lines.push(
      `  ${member.agent_id.padEnd(24)} ${member.status.padEnd(8)} intent=${member.wait_intent ?? "legacy"}${standby} last seen ${formatRelativeTime(member.last_seen_at)}${marker}`
    );
  }
  const hiddenMembers = formatHiddenSummary("member", result.hidden?.members);
  if (hiddenMembers) {
    lines.push(`  Hidden: ${hiddenMembers}`);
  }

  return lines.join("\n");
}

function formatGitAdvisoryConcise(git: GitAdvisory): string {
  if (git.status !== "available") {
    return git.reason;
  }
  if (git.tracked_changed_count === 0 && git.untracked_count === 0) {
    return "clean";
  }
  return `dirty (${git.tracked_changed_count} tracked changed, ${git.untracked_count} untracked)`;
}

function formatListenerSummary(
  listener: HealthSummaryResult["listener"]
): string {
  if (listener.status !== "scanned") {
    return listener.status;
  }
  if (!listener.active) {
    return "not running";
  }
  return listener.duplicates > 0
    ? `running, ${listener.duplicates} duplicate(s)`
    : "running";
}

function getNextAction(result: HealthCliResult, callerAgentId: string): string {
  const caller = result.members.find(
    (member) => member.agent_id === callerAgentId
  );
  if (caller?.wait_intent === "parked" && caller.standby_transport) {
    if (caller.standby_wake_pending) {
      return "Standby wake is pending; inspect the transport error or run 'tt wait'.";
    }
    if (caller.standby_delivered_at) {
      return "A standby wake was delivered. Run 'tt wait' to resume coordination.";
    }
    return "Standby is registered; no listener process is required.";
  }
  const isOwner = result.room.owner === callerAgentId;
  const isReserved = result.room.reserved_for === callerAgentId;
  const state = result.room.state;

  if (isOwner && state === "owned") {
    const liveness = result.local.guardian.liveness;
    if (liveness === "alive") {
      return "You hold the stick. Do work, then release/assign.";
    } else {
      return "Run 'tt wait' to restart the lease guardian and ownership.";
    }
  }

  if (isReserved) {
    return "Run 'tt wait' to claim your reservation.";
  }

  if (state === "idle") {
    return "Run 'tt wait' to claim the stick.";
  }

  if (result.room.owner) {
    return "Run 'tt wait' to queue or wait for your turn.";
  }

  if (result.room.reserved_for) {
    return "Run 'tt wait' to wait for your turn.";
  }

  return "Run 'tt wait' to queue or wait for your turn.";
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
    receivers: {
      status: "registered",
      processes: health.receivers
        .filter(
          (receiver) =>
            receiver.agent_id === agentId && receiver.liveness === "alive"
        )
        .map((receiver) => ({
          pid: receiver.pid,
          ppid: null,
          started_at: receiver.process_started_at,
          cwd: health.room.canonical_path,
          kind: "wait" as const,
          command: "tt wait"
        })),
      duplicate_count: Math.max(
        0,
        health.receivers.filter(
          (receiver) =>
            receiver.agent_id === agentId && receiver.liveness === "alive"
        ).length - 1
      ),
      stale_count: health.receivers.filter(
        (receiver) =>
          receiver.agent_id === agentId && receiver.liveness !== "alive"
      ).length
    }
  };
}

export function scanReceiverProcesses(
  room: PathRoom,
  options: {
    root_pid?: number | null;
    process_rows?: ProcessTableRow[];
    read_cwd?: (pid: number) => string | null;
  } = {}
): ReceiverHealth {
  if (process.platform === "win32") {
    return {
      status: "unsupported",
      processes: [],
      duplicate_count: 0,
      stale_count: 0
    };
  }

  try {
    const rows = options.process_rows ?? readProcessTable();
    const processIndex = new Map(rows.map((row) => [row.pid, row]));
    const cwdForPid = options.read_cwd ?? readProcessCwd;
    const candidates = rows
      .map((row) => {
        const kind = receiverKind(row.command);
        if (!kind) {
          return null;
        }
        if (
          options.root_pid &&
          row.pid !== options.root_pid &&
          !hasAncestor(row.pid, options.root_pid, processIndex)
        ) {
          return null;
        }
        const cwd = cwdForPid(row.pid);
        if (!processMatchesRoom(row.command, cwd, room)) {
          return null;
        }
        return {
          pid: row.pid,
          ppid: row.ppid,
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
          ppid: number | null;
          started_at: string | null;
          cwd: string | null;
          kind: "wait-events" | "events-follow" | "msg-recv";
          command: string;
        } => Boolean(row)
      );
    const processes = removeAncestorReceiverWrappers(candidates, processIndex);

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

interface ProcessTableRow {
  pid: number;
  ppid: number | null;
  started_at: string | null;
  command: string;
}

function readProcessTable(): ProcessTableRow[] {
  const output = execFileSync(
    "ps",
    ["-axo", "pid=,ppid=,lstart=,command="],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        LC_ALL: "C"
      }
    }
  ) as string;
  return output
    .split("\n")
    .map(parseProcessLine)
    .filter((row): row is ProcessTableRow => Boolean(row));
}

function parseProcessLine(line: string): ProcessTableRow | null {
  const match = line.trimStart().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    pid: Number.parseInt(match[1], 10),
    ppid: Number.parseInt(match[2], 10) || null,
    started_at: match[3].trim() || null,
    command: match[4].trim()
  };
}

function hasAncestor(
  pid: number,
  ancestorPid: number,
  processIndex: Map<number, ProcessTableRow>
): boolean {
  const seen = new Set<number>();
  let current = processIndex.get(pid);
  while (current?.ppid && !seen.has(current.ppid)) {
    if (current.ppid === ancestorPid) {
      return true;
    }
    seen.add(current.ppid);
    current = processIndex.get(current.ppid);
  }
  return false;
}

function removeAncestorReceiverWrappers(
  candidates: ReceiverHealth["processes"],
  processIndex: Map<number, ProcessTableRow>
): ReceiverHealth["processes"] {
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.pid !== candidate.pid &&
          hasAncestor(other.pid, candidate.pid, processIndex)
      )
  );
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
  if (receivers.status !== "scanned" && receivers.status !== "registered") {
    return receivers.status;
  }
  if (receivers.processes.length === 0) {
    return receivers.stale_count > 0
      ? `none, ${receivers.stale_count} stale registration`
      : "none";
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
