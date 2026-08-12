import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  clearCliSessionLease,
  createSystemProcessInspector,
  findCliSessionByRoom,
  getCurrentProcessStartedAt,
  resolveCliSessionPath,
  upsertCliSession,
  type CliSession,
  type DerivedIdentity,
  type RoomEvent,
  type RoomMember,
  type WaitForTurnResult
} from "../index.js";
import { resolveCmuxStandbyEndpoint } from "../wake.js";
import { waitForActionableSignal } from "../wait-loop.js";
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
  parseRequiredInteger,
  parseWaitTimeout,
  type ParsedCommand
} from "./parser.js";
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
  const park = hasOption(parsed, "park");
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);
  const sessionPath = resolveCliSessionPath();
  const session = findCliSessionByRoom(sessionPath, identity.agent_id, joined.room_id);
  const hasExplicitCursor = hasOption(parsed, "after");
  const afterEventSeq = hasExplicitCursor
    ? parseRequiredInteger(parsed, "after")
    : session?.event_cursor_seq ?? joined.cursor_event_seq;
  const target = getStringOption(parsed, "target");
  if (target && target !== "self") {
    throw new Error(
      "tt wait manages the self cursor only. Use `tt events --target ...` for audit/debug reads."
    );
  }
  const targetAgentId = identity.agent_id;

  const explicitTimeout = hasOption(parsed, "timeout");
  let currentCursor = afterEventSeq;
  const receiverId = isTry ? null : randomUUID();
  if (receiverId) {
    runtime.commands.registerReceiver(identity, {
      room_id: joined.room_id,
      receiver_id: receiverId,
      harness_session_id:
        identity.process_metadata.harness_session_id ?? null,
      host_id: os.hostname(),
      pid: process.pid,
      process_started_at: getCurrentProcessStartedAt(),
      cursor_event_seq: currentCursor
    });
  }

  let waitResult: WaitForTurnResult;
  try {
    waitResult = await waitForActionableSignal(
      async () => {
        const result = await runtime.commands.waitForTurn(identity, {
          room_id: joined.room_id,
          max_wait_ms: isTry ? 0 : parseWaitTimeout(parsed),
          auto_claim: park ? false : undefined,
          mode: park ? "parked" : "active",
          include_events: true,
          after_event_seq: currentCursor,
          target_agent_id: targetAgentId
        });
        currentCursor = result.cursor_event_seq ?? currentCursor;
        return result;
      },
      {
        is_try: isTry,
        explicit_timeout: explicitTimeout,
        on_internal_timeout: () => {
          if (!hasExplicitCursor) {
            persistWaitCursor(identity, joined, currentCursor);
          }
          if (receiverId) {
            runtime.commands.heartbeatReceiver(identity, {
              room_id: joined.room_id,
              receiver_id: receiverId,
              cursor_event_seq: currentCursor
            });
          }
        }
      }
    );
  } finally {
    if (receiverId) {
      runtime.commands.unregisterReceiver(identity, {
        room_id: joined.room_id,
        receiver_id: receiverId,
        cursor_event_seq: currentCursor
      });
    }
  }
  const returnedCursor = waitResult.cursor_event_seq ?? afterEventSeq;

  const nextReminder =
    "Keep one `tt wait --json` running; a duplicate for this room member is rejected.";

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
          { ...waitResult, guardian_pid: replacement.pid, next: nextReminder },
          () => {
            const reason = existing?.guardian_pid
              ? "Prior guardian was gone"
              : "No guardian was recorded";
            const body = `Already holding the stick (turn ${waitResult.turn_id}). ${reason}; spawned replacement ${replacement.pid}.`;
            return `${body}\n\nnext: ${nextReminder}`;
          }
        );
        if (!hasExplicitCursor) {
          persistWaitCursor(identity, joined, returnedCursor);
        }
        return;
      }

      const guardianPid = existing?.guardian_pid;
      printResult(
        parsed,
        { ...waitResult, guardian_pid: guardianPid ?? null, next: nextReminder },
        () => {
          let body = "";
          if (!guardianPid) {
            body = `Already holding the stick (turn ${waitResult.turn_id}).`;
          } else {
            const descriptor = liveness === "alive" ? "still active" : "liveness unknown";
            body = `Already holding the stick (turn ${waitResult.turn_id}). Guardian ${guardianPid} (${descriptor}).`;
          }
          return `${body}\n\nnext: ${nextReminder}`;
        }
      );
      if (!hasExplicitCursor) {
        persistWaitCursor(identity, joined, returnedCursor);
      }
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
      { ...waitResult, guardian_pid: guardianPid.pid, next: nextReminder },
      () => {
        const body = formatWaitResult(waitResult);
        return `${body}\n\nGuardian ${guardianPid.pid} is holding the lease.\n\nnext: ${nextReminder}`;
      }
    );
    if (!hasExplicitCursor) {
      persistWaitCursor(identity, joined, returnedCursor);
    }
    return;
  }

  printResult(
    parsed,
    { ...waitResult, next: nextReminder },
    () => {
      const body = formatWaitResult(waitResult);
      return `${body}\n\nnext: ${nextReminder}`;
    }
  );
  if (!hasExplicitCursor) {
    persistWaitCursor(identity, joined, returnedCursor);
  }
}

export function handleStandbyCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, {
    context_path: contextPath
  });
  upsertSessionFromJoin(identity, joined);
  const transport = getStringOption(parsed, "wake") ?? "cmux";
  if (transport !== "cmux" && transport !== "manual") {
    throw new Error("--wake must be cmux or manual.");
  }

  const endpoint = transport === "cmux" ? resolveCmuxStandbyEndpoint() : null;
  const result = runtime.commands.registerStandby(identity, {
    room_id: joined.room_id,
    transport,
    workspace_id: endpoint?.workspace_id,
    surface_id: endpoint?.surface_id
  });

  printResult(parsed, result, () => {
    if (result.can_self_wake) {
      return "Standby registered. This turn may end; cmux will wake this surface for an actionable update.";
    }
    return "Manual standby registered. It cannot self-wake; run `tt wait --json` to resume.";
  });
}

function persistWaitCursor(
  identity: DerivedIdentity,
  joined: {
    room_id: string;
    canonical_path: string;
    workspace_root: string;
  },
  eventCursorSeq: number
): void {
  upsertCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    event_cursor_seq: eventCursorSeq,
    updated_at: new Date().toISOString()
  });
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
    const parked =
      result.parked_hinted.length > 0
        ? ` Parked hint: ${result.parked_hinted.join(", ")}.`
        : "";
    return `Released${target}.${parked}`;
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
    targetSelector,
    hasOption(parsed, "operator-requested")
  );
  const result = runtime.commands.passStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    to_agent_id: target,
    handoff,
    operator_override: hasOption(parsed, "operator-requested")
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
  selector: string,
  allowUnreachable = false
): string {
  if (selector.includes(":")) {
    return selector;
  }

  const state = runtime.commands.getRoomState({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    process_metadata: identity.process_metadata
  });
  const health = runtime.commands.getRoomHealth(identity, {
    context_path: session.workspace_root
  });
  const reachableIds = new Set(
    health.receivers
      .filter((receiver) => receiver.liveness === "alive")
      .map((receiver) => receiver.agent_id)
  );
  for (const member of state.members) {
    if (
      member.wait_intent === "parked" &&
      member.standby_transport === "cmux" &&
      member.standby_workspace_id &&
      member.standby_surface_id &&
      member.standby_registered_at &&
      member.standby_last_error === null
    ) {
      reachableIds.add(member.agent_id);
    }
  }
  const enforceReachable = health.receivers.length > 0;
  const normalizedSelector = selector.toLowerCase();
  const candidates = state.members.filter((member) => {
    if (member.agent_id === identity.agent_id || member.status !== "active") {
      return false;
    }
    if (
      enforceReachable &&
      !allowUnreachable &&
      !reachableIds.has(member.agent_id)
    ) {
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
    throw new Error(
      enforceReachable
        ? `No reachable room member matched assignment target: ${selector}`
        : `No active room member matched assignment target: ${selector}`
    );
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
      const leftTier = left.wait_intent === "active" ? 0 : 1;
      const rightTier = right.wait_intent === "active" ? 0 : 1;
      if (leftTier !== rightTier) {
        return leftTier - rightTier;
      }
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
