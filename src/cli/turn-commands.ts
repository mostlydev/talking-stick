import {
  clearCliSessionLease,
  createSystemProcessInspector,
  findCliSessionByRoom,
  resolveCliSessionPath,
  upsertCliSession,
  type CliSession,
  type DerivedIdentity,
  type RoomEvent,
  type RoomMember
} from "../index.js";
import {
  checkGuardianLiveness,
  spawnGuardian,
  stopGuardian
} from "./guardian.js";
import { resolveHandoff } from "./handoff.js";
import {
  deriveCliIdentity,
  resolveTakeoverReason,
  shouldUseOperatorOverride
} from "./identity.js";
import {
  getStringOption,
  hasOption,
  normalizeBooleanFlag,
  parseRequiredInteger,
  parseWaitTimeout,
  type ParsedCommand
} from "./parser.js";
import { resolveTargetFilter } from "./event-stream.js";
import {
  formatWaitResult,
  printResult
} from "./output.js";
import {
  requireLeaseSession,
  upsertSessionFromJoin
} from "./session.js";
import type { Runtime } from "./runtime.js";

export async function handleWaitCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  isTry: boolean,
  cliEntryUrl: string
): Promise<void> {
  normalizeBooleanFlag(parsed, "park");
  normalizeBooleanFlag(parsed, "events");
  const park = hasOption(parsed, "park");
  const includeEvents = hasOption(parsed, "events");
  const afterEventSeq = includeEvents
    ? parseRequiredInteger(parsed, "after")
    : undefined;
  if (!includeEvents && hasOption(parsed, "after")) {
    throw new Error("Pass --after only with --events.");
  }
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);
  const targetAgentId = includeEvents
    ? resolveTargetFilter(
        runtime,
        identity,
        joined.room_id,
        getStringOption(parsed, "target") ?? "self"
      )
    : undefined;

  const waitResult = await runtime.commands.waitForTurn(identity, {
    room_id: joined.room_id,
    max_wait_ms: isTry ? 0 : parseWaitTimeout(parsed),
    auto_claim: park ? false : undefined,
    include_events: includeEvents,
    after_event_seq: afterEventSeq,
    target_agent_id: targetAgentId
  });

  if (waitResult.status === "your_turn") {
    if (waitResult.reason === "already_owner") {
      const sessionPath = resolveCliSessionPath();
      const existing = findCliSessionByRoom(
        sessionPath,
        identity.agent_id,
        joined.room_id
      );

      const liveness = existing?.guardian_pid
        ? checkGuardianLiveness(
            {
              pid: existing.guardian_pid,
              process_started_at: existing.guardian_process_started_at
            },
            createSystemProcessInspector()
          )
        : "gone";

      if (liveness === "gone") {
        const replacement = await spawnGuardian({
          agentId: identity.agent_id,
          canonicalPath: joined.canonical_path,
          roomId: joined.room_id,
          leaseId: waitResult.lease_id,
          turnId: waitResult.turn_id,
          cliEntryUrl,
          processMetadata: identity.process_metadata
        });

        upsertCliSession(sessionPath, {
          agent_id: identity.agent_id,
          room_id: joined.room_id,
          canonical_path: joined.canonical_path,
          workspace_root: joined.workspace_root,
          lease_id: waitResult.lease_id,
          turn_id: waitResult.turn_id,
          guardian_pid: replacement.pid,
          guardian_process_started_at: replacement.process_started_at,
          updated_at: new Date().toISOString()
        });

        printResult(
          parsed,
          { ...waitResult, guardian_pid: replacement.pid },
          () => {
            const reason = existing?.guardian_pid
              ? "Prior guardian was gone"
              : "No guardian was recorded";
            return `Already holding the stick (turn ${waitResult.turn_id}). ${reason}; spawned replacement ${replacement.pid}.`;
          }
        );
        return;
      }

      const guardianPid = existing?.guardian_pid;
      printResult(
        parsed,
        { ...waitResult, guardian_pid: guardianPid ?? null },
        () => {
          if (!guardianPid) {
            return `Already holding the stick (turn ${waitResult.turn_id}).`;
          }
          const descriptor = liveness === "alive" ? "still active" : "liveness unknown";
          return `Already holding the stick (turn ${waitResult.turn_id}). Guardian ${guardianPid} (${descriptor}).`;
        }
      );
      return;
    }

    const guardianPid = await spawnGuardian({
      agentId: identity.agent_id,
      canonicalPath: joined.canonical_path,
      roomId: joined.room_id,
      leaseId: waitResult.lease_id,
      turnId: waitResult.turn_id,
      cliEntryUrl,
      processMetadata: identity.process_metadata
    });

    upsertCliSession(resolveCliSessionPath(), {
      agent_id: identity.agent_id,
      room_id: joined.room_id,
      canonical_path: joined.canonical_path,
      workspace_root: joined.workspace_root,
      lease_id: waitResult.lease_id,
      turn_id: waitResult.turn_id,
      guardian_pid: guardianPid.pid,
      guardian_process_started_at: guardianPid.process_started_at,
      updated_at: new Date().toISOString()
    });

    printResult(
      parsed,
      { ...waitResult, guardian_pid: guardianPid.pid },
      () => {
        const body = formatWaitResult(waitResult);
        return `${body}\n\nGuardian ${guardianPid.pid} is holding the lease.`;
      }
    );
    return;
  }

  printResult(parsed, waitResult, () => formatWaitResult(waitResult));
}

export async function handleTakeCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  cliEntryUrl: string
): Promise<void> {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const reason = resolveTakeoverReason(parsed);
  const operatorOverride = shouldUseOperatorOverride(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);

  const availability = await runtime.commands.waitForTurn(identity, {
    room_id: joined.room_id,
    max_wait_ms: 0
  });

  if (availability.status === "your_turn") {
    const guardianPid = await spawnGuardian({
      agentId: identity.agent_id,
      canonicalPath: joined.canonical_path,
      roomId: joined.room_id,
      leaseId: availability.lease_id,
      turnId: availability.turn_id,
      cliEntryUrl,
      processMetadata: identity.process_metadata
    });

    upsertCliSession(resolveCliSessionPath(), {
      agent_id: identity.agent_id,
      room_id: joined.room_id,
      canonical_path: joined.canonical_path,
      workspace_root: joined.workspace_root,
      lease_id: availability.lease_id,
      turn_id: availability.turn_id,
      guardian_pid: guardianPid.pid,
      guardian_process_started_at: guardianPid.process_started_at,
      updated_at: new Date().toISOString()
    });

    printResult(
      parsed,
      { ...availability, guardian_pid: guardianPid.pid },
      () => `Took the stick. Guardian ${guardianPid.pid} is holding the lease.`
    );
    return;
  }

  if (availability.status === "closed") {
    throw new Error("Takeover is not available: room is closed.");
  }

  if (availability.status !== "takeover_available" && !operatorOverride) {
    throw new Error(`Takeover is not available: ${formatWaitResult(availability)}`);
  }

  const result = runtime.commands.takeoverStick(identity, {
    room_id: joined.room_id,
    expected_turn_id: availability.turn_id,
    reason,
    operator_override: operatorOverride
  });

  const guardianPid = await spawnGuardian({
    agentId: identity.agent_id,
    canonicalPath: joined.canonical_path,
    roomId: joined.room_id,
    leaseId: result.lease_id,
    turnId: result.turn_id,
    cliEntryUrl,
    processMetadata: identity.process_metadata
  });

  upsertCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    lease_id: result.lease_id,
    turn_id: result.turn_id,
    guardian_pid: guardianPid.pid,
    guardian_process_started_at: guardianPid.process_started_at,
    updated_at: new Date().toISOString()
  });

  printResult(
    parsed,
    { ...result, guardian_pid: guardianPid.pid },
    () => `Took the stick. Guardian ${guardianPid.pid} is holding the lease.`
  );
}

export async function handleReleaseCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const session = requireLeaseSession(identity, contextPath);
  const handoff = await resolveHandoff(parsed);
  const result = runtime.commands.releaseStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    handoff
  });

  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );

  printResult(parsed, result, () => {
    const target = result.reserved_for ? ` to ${result.reserved_for}` : "";
    return `Released${target}.`;
  });
}

export async function handlePassCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  if (parsed.positionals[0]?.includes(":")) {
    await handleAssignCommand(runtime, parsed);
    return;
  }

  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const session = requireLeaseSession(identity, contextPath);
  const handoff = await resolveHandoff(parsed);
  const result = runtime.commands.releaseStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    handoff
  });

  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );
  printResult(parsed, result, () => {
    const reserved = result.reserved_for ? ` Next: ${result.reserved_for}.` : "";
    return `Passed turn.${reserved}`;
  });
}

export async function handleAssignCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const targetSelector = parsed.positionals[0];
  if (!targetSelector) {
    throw new Error("Usage: tt assign <target|next> [path] (--status TEXT --next-action TEXT | --stdin)");
  }

  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[1] ?? process.cwd();
  const session = requireLeaseSession(identity, contextPath);
  const handoff = await resolveHandoff(parsed);
  const target = resolveAssignmentTarget(
    runtime,
    identity,
    session,
    targetSelector
  );
  const result = runtime.commands.passStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    to_agent_id: target,
    handoff
  });

  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );

  printResult(parsed, result, () => `Passed to ${result.reserved_for}.`);
}

function resolveAssignmentTarget(
  runtime: Runtime,
  identity: DerivedIdentity,
  session: CliSession,
  selector: string
): string {
  if (selector.includes(":")) {
    return selector;
  }

  const state = runtime.commands.getRoomState({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    process_metadata: identity.process_metadata
  });
  const normalizedSelector = selector.toLowerCase();
  const candidates = state.members.filter((member) => {
    if (member.agent_id === identity.agent_id || member.status !== "active") {
      return false;
    }

    if (normalizedSelector === "next") {
      return true;
    }

    return (
      member.agent_id.toLowerCase() === normalizedSelector ||
      member.agent_id.toLowerCase().startsWith(`${normalizedSelector}:`) ||
      member.display_name?.toLowerCase() === normalizedSelector
    );
  });

  if (candidates.length === 0) {
    throw new Error(`No active room member matched assignment target: ${selector}`);
  }

  const events = runtime.commands.getRoomEvents({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    limit: 500,
    process_metadata: identity.process_metadata
  });
  return pickFairAssignmentCandidate(candidates, events).agent_id;
}

function pickFairAssignmentCandidate(
  candidates: RoomMember[],
  events: RoomEvent[]
): RoomMember {
  const lastOwnership = new Map<string, string>();
  for (const event of events) {
    if (
      (event.event_type === "claim" || event.event_type === "takeover") &&
      event.to_agent_id
    ) {
      lastOwnership.set(event.to_agent_id, event.created_at);
    }
  }

  return candidates
    .slice()
    .sort((left, right) => {
      const leftLastOwned = lastOwnership.get(left.agent_id);
      const rightLastOwned = lastOwnership.get(right.agent_id);

      if (!leftLastOwned && rightLastOwned) {
        return -1;
      }
      if (leftLastOwned && !rightLastOwned) {
        return 1;
      }
      if (leftLastOwned && rightLastOwned && leftLastOwned !== rightLastOwned) {
        return Date.parse(leftLastOwned) - Date.parse(rightLastOwned);
      }

      return left.ordinal - right.ordinal;
    })[0];
}
