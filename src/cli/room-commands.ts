import { deriveCliIdentity, resolveCliIdentity } from "./identity.js";
import {
  parseOptionalInteger,
  type ParsedCommand
} from "./parser.js";
import {
  formatRelativeTime,
  printResult
} from "./output.js";
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
    return `Joined ${joined.canonical_path} as ${joined.agent_id}`;
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
    agent_id: identity.agent_id
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

export function handleEventsCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  const events = runtime.commands.getRoomEvents({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit")
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
