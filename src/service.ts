import { randomUUID } from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ancestorPaths,
  resolveContextPath,
  type ResolvedContextPath
} from "./path-resolution.js";
import { defaultPolicy } from "./config.js";
import {
  openDatabase,
  withImmediateTransaction,
  type OpenDatabaseOptions,
  type SqliteDatabase
} from "./db.js";
import { ProtocolError } from "./errors.js";
import {
  createSystemProcessInspector,
  type ProcessInspector
} from "./process-utils.js";
import type {
  AgentId,
  GetRoomEventsInput,
  GetRoomStateInput,
  GetRoomStateResult,
  Handoff,
  HeartbeatResult,
  JoinPathInput,
  JoinPathResult,
  ListRoomsInput,
  ListRoomsResult,
  OwnerMutationInput,
  PassStickInput,
  PassStickResult,
  PathRoom,
  Policy,
  ProcessMetadata,
  ReleaseStickInput,
  ReleaseStickResult,
  RoomEvent,
  RoomMember,
  RoomState,
  SessionKind,
  StoredRoomState,
  TakeoverStickInput,
  TakeoverStickResult,
  WaitForTurnInput,
  WaitForTurnResult
} from "./types.js";

interface PathRoomRow {
  room_id: string;
  canonical_path: string;
  sequence_index: number;
  owner: string | null;
  reserved_for: string | null;
  pending_handoff_event_seq: number | null;
  turn_id: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  claim_expires_at: string | null;
  state: StoredRoomState;
  updated_at: string;
}

interface RoomMemberRow {
  room_id: string;
  agent_id: string;
  ordinal: number;
  joined_at: string;
  last_seen_at: string;
  host_id: string | null;
  pid: number | null;
  process_started_at: string | null;
  session_kind: SessionKind;
  display_name: string | null;
  status: "active" | "inactive";
}

interface RoomEventRow {
  event_seq: number;
  event_id: string;
  room_id: string;
  turn_id: number;
  event_type: RoomEvent["event_type"];
  from_agent_id: string | null;
  to_agent_id: string | null;
  handoff_json: string | null;
  reason: string | null;
  created_at: string;
}

interface RoomInspection {
  room: PathRoomRow;
  members: RoomMemberRow[];
  ownerMember: RoomMemberRow | null;
  reservedMember: RoomMemberRow | null;
  state: RoomState;
}

export type ProcessLiveness = "alive" | "gone" | "unknown";

export type ProcessLivenessChecker = (
  metadata: RequiredProcessMetadata
) => ProcessLiveness;

interface RequiredProcessMetadata {
  host_id: string | null;
  pid: number | null;
  process_started_at: string | null;
  session_kind: SessionKind;
  display_name: string | null;
}

export interface TalkingStickServiceOptions extends OpenDatabaseOptions {
  db?: SqliteDatabase;
  now?: () => Date;
  policy?: Partial<Policy>;
  processLivenessChecker?: ProcessLivenessChecker;
  hostId?: string;
}

export class TalkingStickService {
  readonly db: SqliteDatabase;
  readonly policy: Policy;
  private readonly now: () => Date;
  private readonly ownsDatabase: boolean;
  private readonly processLivenessChecker: ProcessLivenessChecker;
  private readonly hostId: string;

  constructor(options: TalkingStickServiceOptions = {}) {
    this.db = options.db ?? openDatabase(options);
    this.ownsDatabase = !options.db;
    this.now = options.now ?? (() => new Date());
    this.policy = { ...defaultPolicy, ...options.policy };
    this.hostId = options.hostId ?? os.hostname();
    this.processLivenessChecker =
      options.processLivenessChecker ??
      createDefaultProcessLivenessChecker(this.hostId);
  }

  close(): void {
    if (this.ownsDatabase && this.db.open) {
      this.db.close();
    }
  }

  listRooms(input: ListRoomsInput = {}): ListRoomsResult {
    const now = this.now();

    if (!input.context_path) {
      const rows = this.db
        .prepare<[], PathRoomRow>(
          "SELECT * FROM path_rooms ORDER BY canonical_path"
        )
        .all();
      return {
        rooms: rows.map((row) => this.mapRoomForList(row, now))
      };
    }

    const resolved = resolveContextPath(input.context_path);
    const ancestors = ancestorPaths(
      resolved.canonical_context_path,
      resolved.workspace_root
    );

    return {
      rooms: this.findRoomsByCanonicalPaths(ancestors).map((row) =>
        this.mapRoomForList(row, now)
      )
    };
  }

  joinPath(input: JoinPathInput): JoinPathResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.context_path, "context_path");

    const resolved = resolveContextPath(input.context_path);
    const now = this.now();
    const timestamp = now.toISOString();

    return withImmediateTransaction(this.db, () => {
      const roomSelection = this.findOrCreateRoomForJoin(
        resolved,
        input.force_new === true,
        timestamp
      );

      this.upsertMember(
        roomSelection.room.room_id,
        input.agent_id,
        timestamp,
        input.process_metadata
      );

      const freshRoom = this.requireRoom(roomSelection.room.room_id);

      return {
        agent_id: input.agent_id,
        room_id: freshRoom.room_id,
        canonical_path: freshRoom.canonical_path,
        requested_path: resolved.requested_path,
        workspace_root: resolved.workspace_root,
        joined_existing_room: roomSelection.joinedExistingRoom,
        warning: roomSelection.warning,
        policy: { ...this.policy },
        room_state: this.mapRoom(this.inspectRoom(freshRoom, now), now),
        handoff_template: handoffTemplate()
      };
    });
  }

  async waitForTurn(input: WaitForTurnInput): Promise<WaitForTurnResult> {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");

    const maxWaitMs = input.max_wait_ms ?? this.policy.waitForTurnMaxWaitMs;
    const deadline = Date.now() + Math.max(0, maxWaitMs);

    while (true) {
      this.warmRoomTurnLiveness(input.room_id);
      const result = withImmediateTransaction(this.db, () =>
        this.waitForTurnOnce(input)
      );

      if (result.status !== "not_yet" || Date.now() >= deadline) {
        return result;
      }

      const remainingMs = deadline - Date.now();
      await sleep(Math.min(this.policy.waitForTurnPollMs, remainingMs));
    }
  }

  heartbeat(input: OwnerMutationInput): HeartbeatResult {
    const now = this.now();
    const timestamp = now.toISOString();
    const nextLeaseExpiresAt = this.expiresAt(now, this.policy.ownerLeaseTtlMs);
    this.warmRoomTurnLiveness(input.room_id);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      this.assertOwnerMutation(room, input, now);
      this.touchMember(input.room_id, input.agent_id, timestamp);

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET lease_expires_at = ?, updated_at = ?, state = 'owned'
          WHERE room_id = ?
        `
        )
        .run(nextLeaseExpiresAt, timestamp, input.room_id);

      return {
        status: "ok",
        room_id: input.room_id,
        turn_id: room.turn_id,
        lease_id: input.lease_id,
        lease_expires_at: nextLeaseExpiresAt
      };
    });
  }

  releaseStick(input: ReleaseStickInput): ReleaseStickResult {
    validateHandoff(input.handoff);
    const now = this.now();
    const timestamp = now.toISOString();
    this.warmRoomTurnLiveness(input.room_id);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      this.assertOwnerMutation(room, input, now);
      this.touchMember(input.room_id, input.agent_id, timestamp);

      const eventSeq = this.appendEvent({
        room_id: input.room_id,
        turn_id: room.turn_id,
        event_type: "release",
        from_agent_id: input.agent_id,
        to_agent_id: null,
        handoff: input.handoff,
        reason: null,
        created_at: timestamp
      });

      const nextMember = this.findNextActiveMember(
        input.room_id,
        input.agent_id,
        now
      );
      const reservedFor = nextMember?.agent_id ?? null;
      const claimExpiresAt = reservedFor
        ? this.expiresAt(now, this.policy.claimTtlMs)
        : null;

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET sequence_index = ?,
              owner = NULL,
              reserved_for = ?,
              pending_handoff_event_seq = ?,
              lease_id = NULL,
              lease_expires_at = NULL,
              claim_expires_at = ?,
              state = ?,
              updated_at = ?
          WHERE room_id = ?
        `
        )
        .run(
          nextMember?.ordinal ?? room.sequence_index,
          reservedFor,
          eventSeq,
          claimExpiresAt,
          reservedFor ? "reserved" : "idle",
          timestamp,
          input.room_id
        );

      return {
        status: "released",
        room_id: input.room_id,
        reserved_for: reservedFor,
        event_seq: eventSeq
      };
    });
  }

  passStick(input: PassStickInput): PassStickResult {
    validateHandoff(input.handoff);
    assertNonEmpty(input.to_agent_id, "to_agent_id");

    const now = this.now();
    const timestamp = now.toISOString();
    this.warmRoomTurnLiveness(input.room_id);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      this.assertOwnerMutation(room, input, now);
      this.touchMember(input.room_id, input.agent_id, timestamp);

      const target = this.getMember(input.room_id, input.to_agent_id);
      if (!target || !this.isMemberActive(target, now)) {
        throw new ProtocolError(
          "unknown_member",
          "pass_stick target must be an active room member in the MVP.",
          { to_agent_id: input.to_agent_id }
        );
      }

      const eventSeq = this.appendEvent({
        room_id: input.room_id,
        turn_id: room.turn_id,
        event_type: "pass",
        from_agent_id: input.agent_id,
        to_agent_id: input.to_agent_id,
        handoff: input.handoff,
        reason: null,
        created_at: timestamp
      });

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET sequence_index = ?,
              owner = NULL,
              reserved_for = ?,
              pending_handoff_event_seq = ?,
              lease_id = NULL,
              lease_expires_at = NULL,
              claim_expires_at = ?,
              state = 'reserved',
              updated_at = ?
          WHERE room_id = ?
        `
        )
        .run(
          target.ordinal,
          input.to_agent_id,
          eventSeq,
          this.expiresAt(now, this.policy.claimTtlMs),
          timestamp,
          input.room_id
        );

      return {
        status: "passed",
        room_id: input.room_id,
        reserved_for: input.to_agent_id,
        event_seq: eventSeq
      };
    });
  }

  takeoverStick(input: TakeoverStickInput): TakeoverStickResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");
    assertNonEmpty(input.reason, "reason");

    const now = this.now();
    const timestamp = now.toISOString();
    this.warmRoomTurnLiveness(input.room_id);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      const inspection = this.inspectRoomForMutation(room, now);
      if (room.turn_id !== input.expected_turn_id) {
        throw new ProtocolError(
          "turn_mismatch",
          "The supplied turn does not match the current room turn.",
          {
            current_owner: room.owner,
            current_turn_id: room.turn_id,
            room_state: inspection.state
          }
        );
      }

      this.touchMember(input.room_id, input.agent_id, timestamp);

      const takeoverKind = this.assertTakeoverEligible(
        room,
        input.agent_id,
        now,
        inspection
      );
      const nextTurnId = room.turn_id + 1;
      const leaseId = randomUUID();
      const revokedAgentId =
        takeoverKind === "claim_timeout" || takeoverKind === "recipient_gone"
          ? room.reserved_for
          : room.owner;

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET owner = ?,
              reserved_for = NULL,
              pending_handoff_event_seq = NULL,
              turn_id = ?,
              lease_id = ?,
              lease_expires_at = ?,
              claim_expires_at = NULL,
              state = 'owned',
              updated_at = ?
          WHERE room_id = ?
        `
        )
        .run(
          input.agent_id,
          nextTurnId,
          leaseId,
          this.expiresAt(now, this.policy.ownerLeaseTtlMs),
          timestamp,
          input.room_id
        );

      this.appendEvent({
        room_id: input.room_id,
        turn_id: nextTurnId,
        event_type: "takeover",
        from_agent_id: revokedAgentId,
        to_agent_id: input.agent_id,
        handoff: null,
        reason: input.reason,
        created_at: timestamp
      });

      return {
        status: "your_turn",
        room_id: input.room_id,
        turn_id: nextTurnId,
        lease_id: leaseId,
        revoked_agent_id: revokedAgentId,
        reason: takeoverKind
      };
    });
  }

  getRoomState(input: GetRoomStateInput): GetRoomStateResult {
    const now = this.now();
    const timestamp = now.toISOString();
    const room = this.requireRoom(input.room_id);
    this.touchKnownMember(input.room_id, input.agent_id, timestamp);
    const inspection = this.inspectRoom(room, now);

    return {
      room: this.mapRoom(inspection, now),
      members: inspection.members.map((member) =>
        this.mapMember(member, now)
      )
    };
  }

  getRoomEvents(input: GetRoomEventsInput): RoomEvent[] {
    this.touchKnownMember(
      input.room_id,
      input.agent_id,
      this.now().toISOString()
    );
    const afterEventSeq = input.after_event_seq ?? 0;
    const limit = Math.min(input.limit ?? 100, 500);

    return this.db
      .prepare<[string, number, number], RoomEventRow>(
        `
        SELECT *
        FROM room_events
        WHERE room_id = ? AND event_seq > ?
        ORDER BY event_seq
        LIMIT ?
      `
      )
      .all(input.room_id, afterEventSeq, limit)
      .map((row) => this.mapEvent(row));
  }

  private waitForTurnOnce(input: WaitForTurnInput): WaitForTurnResult {
    const now = this.now();
    const timestamp = now.toISOString();
    const room = this.requireRoom(input.room_id);

    this.touchMember(input.room_id, input.agent_id, timestamp);
    const inspection = this.inspectRoomForMutation(room, now);

    if (room.state === "closed") {
      return { status: "closed", room_id: input.room_id };
    }

    if (
      room.owner === input.agent_id &&
      room.lease_id &&
      room.lease_expires_at &&
      !this.hasExpired(room.lease_expires_at, now)
    ) {
      return {
        status: "your_turn",
        room_id: input.room_id,
        turn_id: room.turn_id,
        lease_id: room.lease_id,
        handoff: null,
        from_agent_id: null,
        reason: "already_owner"
      };
    }

    if (!room.owner && !room.reserved_for) {
      return this.grantTurn(room, input.agent_id, now);
    }

    if (inspection.state === "recipient_gone") {
      if (
        room.reserved_for !== input.agent_id &&
        this.isClaimTakeoverEligible(room, input.agent_id, now, inspection)
      ) {
        return {
          status: "takeover_available",
          room_id: input.room_id,
          turn_id: room.turn_id,
          room_state: "recipient_gone",
          reason: "recipient_gone",
          reserved_for: room.reserved_for ?? undefined
        };
      }
    }

    if (room.reserved_for) {
      if (
        room.reserved_for === input.agent_id &&
        inspection.state !== "recipient_gone"
      ) {
        return this.grantTurn(room, input.agent_id, now);
      }

      if (
        inspection.state !== "recipient_gone" &&
        this.hasExpired(room.claim_expires_at, now) &&
        this.isClaimTakeoverEligible(room, input.agent_id, now, inspection)
      ) {
        return {
          status: "takeover_available",
          room_id: input.room_id,
          turn_id: room.turn_id,
          room_state: "reserved",
          reason: "claim_timeout",
          reserved_for: room.reserved_for
        };
      }
    }

    if (inspection.state === "owner_gone" && room.owner !== input.agent_id) {
      return {
        status: "takeover_available",
        room_id: input.room_id,
        turn_id: room.turn_id,
        room_state: "owner_gone",
        reason: "owner_gone",
        current_owner: room.owner ?? undefined
      };
    }

    if (room.owner && room.owner !== input.agent_id && inspection.state === "stale_owner") {
      return {
        status: "takeover_available",
        room_id: input.room_id,
        turn_id: room.turn_id,
        room_state: "stale_owner",
        reason: "owner_timeout",
        current_owner: room.owner
      };
    }

    return {
      status: "not_yet",
      room_state: inspection.state,
      turn_id: room.turn_id,
      current_owner: room.owner ?? undefined,
      reserved_for: room.reserved_for ?? undefined,
      lease_expires_at: room.lease_expires_at ?? undefined,
      claim_expires_at: room.claim_expires_at ?? undefined
    };
  }

  private grantTurn(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date
  ): WaitForTurnResult {
    const timestamp = now.toISOString();
    const nextTurnId = room.turn_id + 1;
    const leaseId = randomUUID();
    const pendingEvent = room.pending_handoff_event_seq
      ? this.getEventBySeq(room.pending_handoff_event_seq)
      : null;
    const reason = claimReasonForEvent(pendingEvent);

    this.db
      .prepare(
        `
        UPDATE path_rooms
        SET owner = ?,
            reserved_for = NULL,
            pending_handoff_event_seq = NULL,
            turn_id = ?,
            lease_id = ?,
            lease_expires_at = ?,
            claim_expires_at = NULL,
            state = 'owned',
            updated_at = ?
        WHERE room_id = ?
      `
      )
      .run(
        agentId,
        nextTurnId,
        leaseId,
        this.expiresAt(now, this.policy.ownerLeaseTtlMs),
        timestamp,
        room.room_id
      );

    this.appendEvent({
      room_id: room.room_id,
      turn_id: nextTurnId,
      event_type: "claim",
      from_agent_id: pendingEvent?.from_agent_id ?? null,
      to_agent_id: agentId,
      handoff: null,
      reason: null,
      created_at: timestamp
    });

    return {
      status: "your_turn",
      room_id: room.room_id,
      turn_id: nextTurnId,
      lease_id: leaseId,
      handoff: pendingEvent ? this.mapEvent(pendingEvent).handoff : null,
      from_agent_id: pendingEvent?.from_agent_id ?? null,
      reason
    };
  }

  private findOrCreateRoomForJoin(
    resolved: ResolvedContextPath,
    forceNew: boolean,
    timestamp: string
  ): {
    room: PathRoomRow;
    joinedExistingRoom: boolean;
    warning?: string;
  } {
    const ancestors = ancestorPaths(
      resolved.canonical_context_path,
      resolved.workspace_root
    );
    const existingAncestor = this.findDeepestRoom(ancestors);

    if (forceNew) {
      const exactRoom = this.findRoomByCanonicalPath(
        resolved.canonical_context_path
      );
      if (exactRoom) {
        return { room: exactRoom, joinedExistingRoom: true };
      }

      return {
        room: this.createRoom(resolved.canonical_context_path, timestamp),
        joinedExistingRoom: false,
        warning: existingAncestor
          ? `Created nested room inside ${existingAncestor.canonical_path}`
          : undefined
      };
    }

    if (existingAncestor) {
      return { room: existingAncestor, joinedExistingRoom: true };
    }

    return {
      room: this.createRoom(resolved.workspace_root, timestamp),
      joinedExistingRoom: false
    };
  }

  private createRoom(canonicalPath: string, timestamp: string): PathRoomRow {
    const roomId = randomUUID();

    this.db
      .prepare(
        `
        INSERT INTO path_rooms (
          room_id,
          canonical_path,
          sequence_index,
          owner,
          reserved_for,
          pending_handoff_event_seq,
          turn_id,
          lease_id,
          lease_expires_at,
          claim_expires_at,
          state,
          updated_at
        )
        VALUES (?, ?, 0, NULL, NULL, NULL, 0, NULL, NULL, NULL, 'idle', ?)
      `
      )
      .run(roomId, canonicalPath, timestamp);

    return this.requireRoom(roomId);
  }

  private upsertMember(
    roomId: string,
    agentId: AgentId,
    timestamp: string,
    processMetadata?: ProcessMetadata
  ): void {
    const existing = this.getMember(roomId, agentId);
    const normalizedMetadata = normalizeProcessMetadata(processMetadata);

    if (existing) {
      const room = this.requireRoom(roomId);
      const mergedMetadata = this.mergeMemberProcessMetadata(
        room,
        existing,
        normalizedMetadata
      );

      this.db
        .prepare(
          `
          UPDATE room_members
          SET last_seen_at = ?,
              status = 'active',
              host_id = ?,
              pid = ?,
              process_started_at = ?,
              session_kind = ?,
              display_name = ?
          WHERE room_id = ? AND agent_id = ?
        `
        )
        .run(
          timestamp,
          mergedMetadata.host_id,
          mergedMetadata.pid,
          mergedMetadata.process_started_at,
          mergedMetadata.session_kind,
          mergedMetadata.display_name,
          roomId,
          agentId
        );
      return;
    }

    const nextOrdinal =
      this.db
        .prepare<[string], { next_ordinal: number | null }>(
          "SELECT MAX(ordinal) + 1 AS next_ordinal FROM room_members WHERE room_id = ?"
        )
        .get(roomId)?.next_ordinal ?? 0;

    this.db
      .prepare(
        `
        INSERT INTO room_members (
          room_id,
          agent_id,
          ordinal,
          joined_at,
          last_seen_at,
          status,
          host_id,
          pid,
          process_started_at,
          session_kind,
          display_name
        )
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `
      )
      .run(
        roomId,
        agentId,
        nextOrdinal,
        timestamp,
        timestamp,
        normalizedMetadata.host_id,
        normalizedMetadata.pid,
        normalizedMetadata.process_started_at,
        normalizedMetadata.session_kind,
        normalizedMetadata.display_name
      );
  }

  private mergeMemberProcessMetadata(
    room: PathRoomRow,
    existing: RoomMemberRow,
    incoming: RequiredProcessMetadata
  ): RequiredProcessMetadata {
    if (
      !this.shouldPreserveExactMemberProcessMetadata(room, existing, incoming)
    ) {
      return incoming;
    }

    return {
      host_id: existing.host_id,
      pid: existing.pid,
      process_started_at: existing.process_started_at,
      session_kind: existing.session_kind,
      display_name: existing.display_name
    };
  }

  private shouldPreserveExactMemberProcessMetadata(
    room: PathRoomRow,
    existing: RoomMemberRow,
    incoming: RequiredProcessMetadata
  ): boolean {
    const isCurrentHolderOrRecipient =
      room.owner === existing.agent_id || room.reserved_for === existing.agent_id;

    if (!isCurrentHolderOrRecipient) {
      return false;
    }

    if (!hasExactProcessIdentity(existing)) {
      return false;
    }

    if (this.getMemberProcessLiveness(existing) === "gone") {
      return false;
    }

    if (!hasExactProcessIdentity(incoming)) {
      return true;
    }

    return (
      sessionKindPriority(incoming.session_kind) <
      sessionKindPriority(existing.session_kind)
    );
  }

  private touchMember(roomId: string, agentId: AgentId, timestamp: string): void {
    const result = this.db
      .prepare(
        `
        UPDATE room_members
        SET last_seen_at = ?, status = 'active'
        WHERE room_id = ? AND agent_id = ?
      `
      )
      .run(timestamp, roomId, agentId);

    if (result.changes === 0) {
      throw new ProtocolError(
        "unknown_member",
        "Agent must join the room before using this tool.",
        { to_agent_id: agentId }
      );
    }
  }

  private touchKnownMember(
    roomId: string,
    agentId: AgentId | undefined,
    timestamp: string
  ): void {
    if (!agentId) {
      return;
    }

    if (!this.getMember(roomId, agentId)) {
      return;
    }

    this.touchMember(roomId, agentId, timestamp);
  }

  private assertOwnerMutation(
    room: PathRoomRow,
    input: OwnerMutationInput,
    now: Date
  ): void {
    const inspection = this.inspectRoomForMutation(room, now);

    if (room.turn_id !== input.expected_turn_id) {
      throw new ProtocolError(
        "turn_mismatch",
        "The supplied turn does not match the current room turn.",
        {
          current_owner: room.owner,
          current_turn_id: room.turn_id,
          room_state: inspection.state
        }
      );
    }

    if (
      room.owner !== input.agent_id ||
      room.lease_id !== input.lease_id ||
      room.state !== "owned" ||
      (inspection.state !== "owned" && inspection.state !== "stale_owner")
    ) {
      throw new ProtocolError(
        "stale_lease",
        "The supplied lease is no longer current for this room.",
        {
          current_owner: room.owner,
          current_turn_id: room.turn_id,
          room_state: inspection.state
        }
      );
    }
  }

  private assertTakeoverEligible(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date,
    inspection: RoomInspection
  ): "claim_timeout" | "owner_timeout" | "owner_gone" | "recipient_gone" {
    if (inspection.state === "recipient_gone") {
      if (!this.isClaimTakeoverEligible(room, agentId, now, inspection)) {
        throw new ProtocolError(
          "takeover_ineligible",
          "Agent is not eligible to take over this reserved turn.",
          {
            reserved_for: room.reserved_for,
            room_state: inspection.state
          }
        );
      }
      return "recipient_gone";
    }

    if (room.reserved_for && this.hasExpired(room.claim_expires_at, now)) {
      if (!this.isClaimTakeoverEligible(room, agentId, now, inspection)) {
        throw new ProtocolError(
          "takeover_ineligible",
          "Agent is not eligible to take over this reserved turn.",
          {
            reserved_for: room.reserved_for,
            room_state: inspection.state
          }
        );
      }
      return "claim_timeout";
    }

    if (inspection.state === "owner_gone" && room.owner) {
      if (room.owner === agentId) {
        throw new ProtocolError(
          "takeover_ineligible",
          "The current owner cannot take over its own dead lease.",
          {
            current_owner: room.owner,
            room_state: inspection.state
          }
        );
      }
      return "owner_gone";
    }

    if (room.owner && this.hasExpired(room.lease_expires_at, now)) {
      if (room.owner === agentId) {
        throw new ProtocolError(
          "takeover_ineligible",
          "The current owner cannot take over its own stale lease.",
          {
            current_owner: room.owner,
            room_state: inspection.state
          }
        );
      }
      return "owner_timeout";
    }

    throw new ProtocolError(
      "takeover_not_available",
      "No takeover timeout is currently available for this room.",
      { room_state: inspection.state }
    );
  }

  private isClaimTakeoverEligible(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date,
    inspection: RoomInspection
  ): boolean {
    if (!room.reserved_for || room.reserved_for === agentId) {
      return false;
    }

    const pendingEvent = room.pending_handoff_event_seq
      ? this.getEventBySeq(room.pending_handoff_event_seq)
      : null;
    const priorOwner = pendingEvent?.from_agent_id ?? null;

    if (priorOwner === agentId) {
      return !this.hasOtherClaimTakeoverCandidate(
        inspection.members,
        room.reserved_for,
        agentId,
        now
      );
    }

    return true;
  }

  private hasOtherClaimTakeoverCandidate(
    members: RoomMemberRow[],
    reservedFor: AgentId | null,
    candidateAgentId: AgentId,
    now: Date
  ): boolean {
    return members.some(
      (member) =>
        member.agent_id !== candidateAgentId &&
        member.agent_id !== reservedFor &&
        this.hasRecentPresence(member, now)
    );
  }

  private findNextActiveMember(
    roomId: string,
    afterAgentId: AgentId,
    now: Date
  ): RoomMemberRow | null {
    const members = this.getMembers(roomId);
    if (members.length <= 1) {
      return null;
    }

    const ownerIndex = members.findIndex(
      (member) => member.agent_id === afterAgentId
    );
    if (ownerIndex === -1) {
      return null;
    }

    for (let offset = 1; offset < members.length; offset += 1) {
      const candidate = members[(ownerIndex + offset) % members.length];
      if (this.hasRecentPresence(candidate, now)) {
        return candidate;
      }
    }

    return null;
  }

  private appendEvent(input: {
    room_id: string;
    turn_id: number;
    event_type: RoomEvent["event_type"];
    from_agent_id: string | null;
    to_agent_id: string | null;
    handoff: Handoff | null;
    reason: string | null;
    created_at: string;
  }): number {
    const result = this.db
      .prepare(
        `
        INSERT INTO room_events (
          event_id,
          room_id,
          turn_id,
          event_type,
          from_agent_id,
          to_agent_id,
          handoff_json,
          reason,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        randomUUID(),
        input.room_id,
        input.turn_id,
        input.event_type,
        input.from_agent_id,
        input.to_agent_id,
        input.handoff ? JSON.stringify(input.handoff) : null,
        input.reason,
        input.created_at
      );

    return Number(result.lastInsertRowid);
  }

  private getRoomRow(roomId: string): PathRoomRow | undefined {
    return this.db
      .prepare<[string], PathRoomRow>("SELECT * FROM path_rooms WHERE room_id = ?")
      .get(roomId);
  }

  private requireRoom(roomId: string): PathRoomRow {
    const room = this.getRoomRow(roomId);
    if (!room) {
      throw new ProtocolError("room_not_found", "Room was not found.");
    }
    return room;
  }

  private findRoomByCanonicalPath(canonicalPath: string): PathRoomRow | null {
    return (
      this.db
        .prepare<[string], PathRoomRow>(
          "SELECT * FROM path_rooms WHERE canonical_path = ?"
        )
        .get(canonicalPath) ?? null
    );
  }

  private findRoomsByCanonicalPaths(canonicalPaths: string[]): PathRoomRow[] {
    if (canonicalPaths.length === 0) {
      return [];
    }

    const placeholders = canonicalPaths.map(() => "?").join(", ");
    return this.db
      .prepare<unknown[], PathRoomRow>(
        `SELECT * FROM path_rooms WHERE canonical_path IN (${placeholders})`
      )
      .all(...canonicalPaths);
  }

  private findDeepestRoom(canonicalPaths: string[]): PathRoomRow | null {
    const rows = this.findRoomsByCanonicalPaths(canonicalPaths);
    const byPath = new Map(rows.map((row) => [row.canonical_path, row]));

    for (const candidate of canonicalPaths) {
      const row = byPath.get(candidate);
      if (row) {
        return row;
      }
    }

    return null;
  }

  private getMember(roomId: string, agentId: AgentId): RoomMemberRow | null {
    return (
      this.db
        .prepare<[string, string], RoomMemberRow>(
          "SELECT * FROM room_members WHERE room_id = ? AND agent_id = ?"
        )
        .get(roomId, agentId) ?? null
    );
  }

  private getMembers(roomId: string): RoomMemberRow[] {
    return this.db
      .prepare<[string], RoomMemberRow>(
        "SELECT * FROM room_members WHERE room_id = ? ORDER BY ordinal"
      )
      .all(roomId);
  }

  private getEventBySeq(eventSeq: number): RoomEventRow | null {
    return (
      this.db
        .prepare<[number], RoomEventRow>(
          "SELECT * FROM room_events WHERE event_seq = ?"
        )
        .get(eventSeq) ?? null
    );
  }

  private expiresAt(now: Date, ttlMs: number): string {
    return new Date(now.getTime() + ttlMs).toISOString();
  }

  private hasExpired(timestamp: string | null, now: Date): boolean {
    return timestamp !== null && Date.parse(timestamp) <= now.getTime();
  }

  private isMemberActive(member: RoomMemberRow, now: Date): boolean {
    if (this.getMemberProcessLiveness(member) === "gone") {
      return false;
    }

    return this.hasRecentPresence(member, now);
  }

  private hasRecentPresence(member: RoomMemberRow, now: Date): boolean {
    return (
      now.getTime() - Date.parse(member.last_seen_at) <=
      this.policy.presenceTtlMs
    );
  }

  private inspectRoom(room: PathRoomRow, now: Date): RoomInspection {
    const members = this.getMembers(room.room_id);
    const ownerMember = room.owner
      ? members.find((member) => member.agent_id === room.owner) ?? null
      : null;
    const reservedMember = room.reserved_for
      ? members.find((member) => member.agent_id === room.reserved_for) ?? null
      : null;

    let state: RoomState;
    if (room.state === "closed") {
      state = "closed";
    } else if (room.owner) {
      const ownerLiveness = ownerMember
        ? this.getMemberProcessLiveness(ownerMember)
        : "gone";
      if (this.isGonePersistent(ownerMember, ownerLiveness, now)) {
        state = "owner_gone";
      } else if (this.hasExpired(room.lease_expires_at, now)) {
        state = "stale_owner";
      } else {
        state = "owned";
      }
    } else if (room.reserved_for) {
      const reservedLiveness = reservedMember
        ? this.getMemberProcessLiveness(reservedMember)
        : "gone";
      state =
        this.hasExpired(room.claim_expires_at, now) &&
        reservedLiveness === "gone"
          ? "recipient_gone"
          : "reserved";
    } else if (!members.some((member) => this.isMemberActive(member, now))) {
      state = "dormant";
    } else {
      state = "idle";
    }

    return {
      room,
      members,
      ownerMember,
      reservedMember,
      state
    };
  }

  private inspectRoomForMutation(room: PathRoomRow, now: Date): RoomInspection {
    const members = this.getMembers(room.room_id);
    const ownerMember = room.owner
      ? members.find((member) => member.agent_id === room.owner) ?? null
      : null;
    const reservedMember = room.reserved_for
      ? members.find((member) => member.agent_id === room.reserved_for) ?? null
      : null;

    let state: RoomState;
    if (room.state === "closed") {
      state = "closed";
    } else if (room.owner) {
      const ownerLiveness = ownerMember
        ? this.getMemberProcessLiveness(ownerMember)
        : "gone";
      if (this.isGonePersistent(ownerMember, ownerLiveness, now)) {
        state = "owner_gone";
      } else if (this.hasExpired(room.lease_expires_at, now)) {
        state = "stale_owner";
      } else {
        state = "owned";
      }
    } else if (room.reserved_for) {
      const reservedLiveness = reservedMember
        ? this.getMemberProcessLiveness(reservedMember)
        : "gone";
      state =
        this.hasExpired(room.claim_expires_at, now) &&
        reservedLiveness === "gone"
          ? "recipient_gone"
          : "reserved";
    } else if (!members.some((member) => this.hasRecentPresence(member, now))) {
      state = "dormant";
    } else {
      state = "idle";
    }

    return {
      room,
      members,
      ownerMember,
      reservedMember,
      state
    };
  }

  private mapRoomForList(room: PathRoomRow, now: Date): PathRoom {
    let state: RoomState;
    if (room.state === "closed") {
      state = "closed";
    } else if (room.owner) {
      state = this.hasExpired(room.lease_expires_at, now)
        ? "stale_owner"
        : "owned";
    } else if (room.reserved_for) {
      state = "reserved";
    } else {
      const members = this.getMembers(room.room_id);
      state = members.some((member) => this.hasRecentPresence(member, now))
        ? "idle"
        : "dormant";
    }

    return {
      ...room,
      state
    };
  }

  private warmRoomTurnLiveness(roomId: string): void {
    const room = this.getRoomRow(roomId);
    if (!room) {
      return;
    }

    const members = this.getMembers(roomId);
    if (room.owner) {
      const owner = members.find((member) => member.agent_id === room.owner);
      if (owner) {
        this.getMemberProcessLiveness(owner);
      }
      return;
    }

    if (room.reserved_for) {
      const reserved = members.find(
        (member) => member.agent_id === room.reserved_for
      );
      if (reserved) {
        this.getMemberProcessLiveness(reserved);
      }
    }
  }

  private getMemberProcessLiveness(member: RoomMemberRow): ProcessLiveness {
    return this.processLivenessChecker({
      host_id: member.host_id,
      pid: member.pid,
      process_started_at: member.process_started_at,
      session_kind: member.session_kind,
      display_name: member.display_name
    });
  }

  private goneGraceMs(): number {
    return this.policy.heartbeatIntervalMs * 2;
  }

  private isGonePersistent(
    member: RoomMemberRow | null,
    liveness: ProcessLiveness,
    now: Date
  ): boolean {
    if (liveness !== "gone") {
      return false;
    }

    if (!member) {
      return true;
    }

    return now.getTime() - Date.parse(member.last_seen_at) > this.goneGraceMs();
  }

  private deriveRoomState(room: PathRoomRow, now: Date): RoomState {
    return this.inspectRoom(room, now).state;
  }

  private mapRoom(inspection: RoomInspection, now: Date): PathRoom {
    const row = inspection.room;
    return {
      ...row,
      state: inspection.state
    };
  }

  private mapMember(row: RoomMemberRow, now: Date): RoomMember {
    return {
      ...row,
      status: this.isMemberActive(row, now) ? "active" : "inactive"
    };
  }

  private mapEvent(row: RoomEventRow): RoomEvent {
    return {
      event_seq: row.event_seq,
      event_id: row.event_id,
      room_id: row.room_id,
      turn_id: row.turn_id,
      event_type: row.event_type,
      from_agent_id: row.from_agent_id,
      to_agent_id: row.to_agent_id,
      handoff: row.handoff_json
        ? (JSON.parse(row.handoff_json) as Handoff)
        : null,
      reason: row.reason,
      created_at: row.created_at
    };
  }
}

function normalizeProcessMetadata(
  processMetadata?: ProcessMetadata
): RequiredProcessMetadata {
  return {
    host_id: processMetadata?.host_id ?? null,
    pid: processMetadata?.pid ?? null,
    process_started_at: processMetadata?.process_started_at ?? null,
    session_kind: processMetadata?.session_kind ?? "mcp_harness",
    display_name: processMetadata?.display_name ?? null
  };
}

export function createDefaultProcessLivenessChecker(
  currentHostId: string,
  injectedInspector?: ProcessInspector
): ProcessLivenessChecker {
  // This cache keeps normal polling from forking `ps` on every room inspection.
  // A deeper move to out-of-transaction liveness refresh is possible later, but
  // for the MVP we keep the lock boundary simple and the probe shared/cached.
  const inspector =
    injectedInspector ?? createSystemProcessInspector({ cacheTtlMs: 1_000 });

  return (metadata) => {
    if (
      metadata.pid === null ||
      metadata.process_started_at === null ||
      metadata.process_started_at.trim() === ""
    ) {
      return "unknown";
    }

    if (metadata.host_id && metadata.host_id !== currentHostId) {
      return "unknown";
    }

    if (process.platform === "win32") {
      return "unknown";
    }

    const inspection = inspector.inspect(metadata.pid);
    if (inspection === undefined) {
      return "unknown";
    }

    if (inspection === null || !inspection.startTime) {
      return "gone";
    }

    // Conservative default: a live pid whose startTime string drifts is far
    // more likely to be the original process with a format-drift bug than a
    // distinct re-used pid. Only return "gone" when we *know* the pid is dead
    // (handled above via inspection === null). Mismatches here become
    // "unknown", deferring the decision to the silence-grace layer.
    const storedStart = metadata.process_started_at.trim();
    const observedStart = inspection.startTime.trim();
    return storedStart === observedStart ? "alive" : "unknown";
  };
}

function hasExactProcessIdentity(
  metadata:
    | RequiredProcessMetadata
    | Pick<RoomMemberRow, "host_id" | "pid" | "process_started_at">
): boolean {
  return (
    metadata.pid !== null &&
    metadata.pid !== undefined &&
    metadata.process_started_at !== null &&
    metadata.process_started_at !== undefined &&
    metadata.process_started_at.trim() !== ""
  );
}

function sessionKindPriority(sessionKind: SessionKind): number {
  switch (sessionKind) {
    case "human_guardian":
      return 3;
    case "mcp_harness":
      return 2;
    case "human_cli":
      return 1;
    default:
      return 2;
  }
}

function claimReasonForEvent(
  pendingEvent: RoomEventRow | null
): "direct_pass" | "sequence" | "open_claim" {
  if (!pendingEvent) {
    return "open_claim";
  }

  return pendingEvent.event_type === "pass" ? "direct_pass" : "sequence";
}

function validateHandoff(handoff: Handoff): void {
  if (!handoff || typeof handoff !== "object") {
    throw new ProtocolError(
      "invalid_handoff",
      "handoff must be an object.",
      { field: "handoff" }
    );
  }

  if (!handoff.status || !handoff.status.trim()) {
    throw new ProtocolError(
      "invalid_handoff",
      "handoff.status must be non-empty.",
      { field: "status" }
    );
  }

  if (!handoff.next_action || !handoff.next_action.trim()) {
    throw new ProtocolError(
      "invalid_handoff",
      "handoff.next_action must be non-empty.",
      { field: "next_action" }
    );
  }

  if (handoff.artifacts !== undefined && !Array.isArray(handoff.artifacts)) {
    throw new ProtocolError(
      "invalid_handoff",
      "handoff.artifacts must be an array when provided.",
      { field: "artifacts" }
    );
  }
}

function assertNonEmpty(value: string | undefined, field: string): void {
  if (!value || !value.trim()) {
    throw new ProtocolError("invalid_input", `${field} must be non-empty.`, {
      field
    });
  }
}

function handoffTemplate(): Handoff {
  return {
    status: "What I did:\nWhat I learned:\nOpen risks:",
    next_action: "What the next agent should do next."
  };
}
