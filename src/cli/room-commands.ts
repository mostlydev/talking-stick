import { deriveCliIdentity, resolveCliIdentity } from "./identity.js";
import {
  removeCliSession,
  removeCliSessionsForRoom,
  resolveCliSessionPath
} from "../index.js";
import { stopGuardian } from "./guardian.js";
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
    process_metadata: identity.process_metadata
  });

  printResult(parsed, { room: state.room, members: state.members }, () => {
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

  const events = runtime.commands.getRoomEvents({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit"),
    process_metadata: identity.process_metadata
  });

  printResult(parsed, events, () => {
    if (events.length === 0) {
      return "No events.";
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
    return lines.join("\n");
  });
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
