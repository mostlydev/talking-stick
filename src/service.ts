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
  AddNoteInput,
  AddNoteResult,
  AgentId,
  DeliveryHint,
  EventType,
  EventTypeFilter,
  GetRoomEventsInput,
  GetRoomStateInput,
  GetRoomStateResult,
  Handoff,
  HeartbeatResult,
  JoinPathInput,
  JoinPathResult,
  KickMemberInput,
  KickMemberResult,
  LeaveRoomInput,
  LeaveRoomResult,
  ListNotesInput,
  ListNotesResult,
  ListRoomsInput,
  ListRoomsResult,
  MessagePayload,
  Note,
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
  SendMessageInput,
  SendMessageResult,
  SessionKind,
  StoredRoomState,
  TakeoverStickInput,
  TakeoverStickResult,
  TargetAgentFilter,
  WaitForEventsInput,
  WaitForEventsResult,
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
  last_wait_at: string | null;
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
  event_type: EventType;
  from_agent_id: string | null;
  to_agent_id: string | null;
  handoff_json: string | null;
  reason: string | null;
  created_at: string;
  payload_json: string | null;
}

interface NoteRow {
  note_id: string;
  room_id: string;
  turn_id: number | null;
  author_agent_id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_agent_id: string | null;
}

const MAX_NOTE_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_BODY_BYTES = 4096;
const KNOWN_EVENT_TYPES: readonly EventType[] = [
  "claim",
  "release",
  "pass",
  "takeover",
  "close",
  "kick",
  "message_sent"
];

interface RoomInspection {
  room: PathRoomRow;
  members: RoomMemberRow[];
  ownerMember: RoomMemberRow | null;
  reservedMember: RoomMemberRow | null;
  state: RoomState;
}

type TakeoverKind =
  | "claim_timeout"
  | "owner_timeout"
  | "owner_gone"
  | "recipient_gone"
  | "operator_override";

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
    this.purgeExpiredIdleRooms(now);

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
    this.purgeExpiredIdleRooms(now);

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

  leaveRoom(input: LeaveRoomInput): LeaveRoomResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");

    const now = this.now();
    const timestamp = now.toISOString();
    this.purgeExpiredIdleRooms(now);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      const member = this.getMember(input.room_id, input.agent_id);
      if (!member) {
        throw new ProtocolError(
          "unknown_member",
          "Agent is not a member of this room.",
          { to_agent_id: input.agent_id }
        );
      }

      this.db
        .prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?")
        .run(input.room_id, input.agent_id);

      const remainingMembers = this.getMembers(input.room_id);
      if (
        remainingMembers.length === 0 ||
        !remainingMembers.some((remaining) => this.isMemberActive(remaining, now))
      ) {
        this.deleteRoom(input.room_id);
        return {
          status: "room_deleted",
          room_id: input.room_id,
          canonical_path: room.canonical_path,
          remaining_members: 0
        };
      }

      const nextOwner = room.owner === input.agent_id ? null : room.owner;
      const nextReservedFor =
        room.reserved_for === input.agent_id ? null : room.reserved_for;
      const nextState =
        room.state === "closed"
          ? "closed"
          : nextOwner
            ? "owned"
            : nextReservedFor
              ? "reserved"
              : "idle";

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET owner = ?,
              reserved_for = ?,
              pending_handoff_event_seq = ?,
              lease_id = ?,
              lease_expires_at = ?,
              claim_expires_at = ?,
              state = ?,
              updated_at = ?
          WHERE room_id = ?
        `
        )
        .run(
          nextOwner,
          nextReservedFor,
          room.owner === input.agent_id ? null : room.pending_handoff_event_seq,
          room.owner === input.agent_id ? null : room.lease_id,
          room.owner === input.agent_id ? null : room.lease_expires_at,
          room.reserved_for === input.agent_id ? null : room.claim_expires_at,
          nextState,
          timestamp,
          input.room_id
        );

      return {
        status: "left",
        room_id: input.room_id,
        canonical_path: room.canonical_path,
        remaining_members: remainingMembers.length
      };
    });
  }

  kickMember(input: KickMemberInput): KickMemberResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");
    assertNonEmpty(input.target_agent_id, "target_agent_id");

    if (input.target_agent_id === input.agent_id) {
      throw new ProtocolError(
        "cannot_kick_self",
        "Use leave_room to remove yourself.",
        { to_agent_id: input.target_agent_id }
      );
    }

    const now = this.now();
    const timestamp = now.toISOString();
    this.purgeExpiredIdleRooms(now);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      this.touchMember(input.room_id, input.agent_id, timestamp);

      const target = this.getMember(input.room_id, input.target_agent_id);
      if (!target) {
        throw new ProtocolError(
          "unknown_target",
          "Target agent is not a member of this room.",
          { to_agent_id: input.target_agent_id }
        );
      }

      if (!input.force) {
        const liveness = this.getMemberProcessLiveness(target);
        if (!this.isGonePersistent(target, liveness, now)) {
          throw new ProtocolError(
            "target_active",
            "Target is still active. Pass force=true to kick anyway.",
            { to_agent_id: input.target_agent_id }
          );
        }
      }

      const targetWasOwner = room.owner === input.target_agent_id;
      const targetWasReservedFor = room.reserved_for === input.target_agent_id;

      this.db
        .prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?")
        .run(input.room_id, input.target_agent_id);

      this.appendEvent({
        room_id: input.room_id,
        turn_id: room.turn_id,
        event_type: "kick",
        from_agent_id: input.agent_id,
        to_agent_id: input.target_agent_id,
        handoff: null,
        reason: input.reason ?? null,
        created_at: timestamp
      });

      const remainingMembers = this.getMembers(input.room_id);
      if (
        remainingMembers.length === 0 ||
        !remainingMembers.some((remaining) => this.isMemberActive(remaining, now))
      ) {
        this.deleteRoom(input.room_id);
        return {
          status: "room_deleted",
          room_id: input.room_id,
          canonical_path: room.canonical_path,
          kicked_agent_id: input.target_agent_id,
          remaining_members: 0,
          target_was_owner: targetWasOwner,
          target_was_reserved_for: targetWasReservedFor
        };
      }

      const nextOwner = targetWasOwner ? null : room.owner;
      const nextReservedFor = targetWasReservedFor ? null : room.reserved_for;
      const nextState =
        room.state === "closed"
          ? "closed"
          : nextOwner
            ? "owned"
            : nextReservedFor
              ? "reserved"
              : "idle";

      this.db
        .prepare(
          `
          UPDATE path_rooms
          SET owner = ?,
              reserved_for = ?,
              pending_handoff_event_seq = ?,
              lease_id = ?,
              lease_expires_at = ?,
              claim_expires_at = ?,
              state = ?,
              updated_at = ?
          WHERE room_id = ?
        `
        )
        .run(
          nextOwner,
          nextReservedFor,
          targetWasOwner ? null : room.pending_handoff_event_seq,
          targetWasOwner ? null : room.lease_id,
          targetWasOwner ? null : room.lease_expires_at,
          targetWasReservedFor ? null : room.claim_expires_at,
          nextState,
          timestamp,
          input.room_id
        );

      return {
        status: "kicked",
        room_id: input.room_id,
        canonical_path: room.canonical_path,
        kicked_agent_id: input.target_agent_id,
        remaining_members: remainingMembers.length,
        target_was_owner: targetWasOwner,
        target_was_reserved_for: targetWasReservedFor
      };
    });
  }

  async waitForTurn(input: WaitForTurnInput): Promise<WaitForTurnResult> {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");
    this.purgeExpiredIdleRooms(this.now());

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
    this.purgeExpiredIdleRooms(now);
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
    this.purgeExpiredIdleRooms(now);
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

      const nextMember = this.findNextWaitingMember(
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
    this.purgeExpiredIdleRooms(now);
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
    this.purgeExpiredIdleRooms(now);
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

      const takeoverKind = this.resolveTakeoverKind(
        room,
        input.agent_id,
        now,
        inspection,
        input.operator_override === true
      );
      const nextTurnId = room.turn_id + 1;
      const leaseId = randomUUID();
      const revokedAgentId =
        takeoverKind === "claim_timeout" || takeoverKind === "recipient_gone"
          ? room.reserved_for
          : takeoverKind === "operator_override"
            ? room.reserved_for ?? room.owner
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
    this.purgeExpiredIdleRooms(now);
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
    this.purgeExpiredIdleRooms(this.now());
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

  sendMessage(input: SendMessageInput): SendMessageResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");

    const body = input.body ?? "";
    if (body.length === 0) {
      throw new ProtocolError("invalid_body", "Message body must not be empty.");
    }

    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > MAX_MESSAGE_BODY_BYTES) {
      throw new ProtocolError(
        "message_too_large",
        `Message body exceeds ${MAX_MESSAGE_BODY_BYTES} bytes.`,
        { supplied: byteLength }
      );
    }

    const deliveryHint: DeliveryHint = input.delivery_hint ?? "normal";
    if (deliveryHint !== "normal" && deliveryHint !== "interrupt") {
      throw new ProtocolError(
        "invalid_delivery_hint",
        "delivery_hint must be 'normal' or 'interrupt'."
      );
    }

    const now = this.now();
    const timestamp = now.toISOString();
    this.purgeExpiredIdleRooms(now);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);
      if (room.state === "closed") {
        throw new ProtocolError(
          "room_closed",
          "Messages cannot be sent to a closed room.",
          { room_id: input.room_id }
        );
      }

      this.touchMember(input.room_id, input.agent_id, timestamp);

      if (input.to_agent_id) {
        const target = this.getMember(input.room_id, input.to_agent_id);
        if (!target) {
          throw new ProtocolError(
            "unknown_recipient",
            "to_agent_id is not a member of this room.",
            { to_agent_id: input.to_agent_id }
          );
        }
      }

      const eventSeq = this.appendEvent({
        room_id: input.room_id,
        turn_id: room.turn_id,
        event_type: "message_sent",
        from_agent_id: input.agent_id,
        to_agent_id: input.to_agent_id ?? null,
        handoff: null,
        reason: null,
        created_at: timestamp,
        payload: { body, delivery_hint: deliveryHint }
      });

      const row = this.db
        .prepare<[number], { event_id: string }>(
          "SELECT event_id FROM room_events WHERE event_seq = ?"
        )
        .get(eventSeq);

      return {
        event_seq: eventSeq,
        event_id: row?.event_id ?? "",
        created_at: timestamp
      };
    });
  }

  async waitForEvents(input: WaitForEventsInput): Promise<WaitForEventsResult> {
    assertNonEmpty(input.room_id, "room_id");
    this.requireRoom(input.room_id);

    const targetFilter = input.target_agent_id ?? "self";
    if (targetFilter === "self" && !input.agent_id) {
      throw new ProtocolError(
        "agent_id_required",
        "agent_id is required when target_agent_id is 'self'."
      );
    }

    const eventTypes = normalizeEventTypeFilter(input.event_type);
    const afterEventSeq = input.after_event_seq ?? 0;
    const maxWaitMs = Math.min(
      Math.max(input.max_wait_ms ?? this.policy.waitForEventsMaxWaitMs, 0),
      this.policy.waitForEventsMaxWaitMs
    );
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      const events = this.queryEvents({
        room_id: input.room_id,
        after_event_seq: afterEventSeq,
        event_types: eventTypes,
        target: targetFilter,
        caller_agent_id: input.agent_id ?? null,
        from_agent_id: input.from_agent_id ?? null,
        limit: this.policy.waitForEventsBatchLimit
      });

      if (events.length > 0 || Date.now() >= deadline) {
        const lastSeq =
          events.length > 0
            ? events[events.length - 1].event_seq
            : afterEventSeq;
        return { events, cursor_event_seq: lastSeq };
      }

      const remainingMs = deadline - Date.now();
      await sleep(Math.min(this.policy.waitForEventsPollMs, remainingMs));
    }
  }

  getLatestEventSeq(input: { room_id: string }): number {
    assertNonEmpty(input.room_id, "room_id");
    this.requireRoom(input.room_id);
    return (
      this.db
        .prepare<[string], { event_seq: number | null }>(
          "SELECT MAX(event_seq) AS event_seq FROM room_events WHERE room_id = ?"
        )
        .get(input.room_id)?.event_seq ?? 0
    );
  }

  addNote(input: AddNoteInput): AddNoteResult {
    assertNonEmpty(input.agent_id, "agent_id");
    assertNonEmpty(input.room_id, "room_id");

    const trimmedBody = input.body?.trim() ?? "";
    if (trimmedBody.length === 0) {
      throw new ProtocolError("invalid_body", "Note body must not be empty.");
    }
    if (Buffer.byteLength(trimmedBody, "utf8") > MAX_NOTE_BODY_BYTES) {
      throw new ProtocolError(
        "body_too_large",
        `Note body exceeds ${MAX_NOTE_BODY_BYTES} bytes.`
      );
    }

    const now = this.now();
    const timestamp = now.toISOString();
    this.purgeExpiredIdleRooms(now);

    return withImmediateTransaction(this.db, () => {
      const room = this.requireRoom(input.room_id);

      if (room.state === "closed") {
        throw new ProtocolError(
          "room_closed",
          "Notes cannot be added to a closed room.",
          { room_id: input.room_id }
        );
      }

      if (
        input.turn_id !== undefined &&
        (!Number.isInteger(input.turn_id) ||
          input.turn_id < 0 ||
          input.turn_id > room.turn_id)
      ) {
        throw new ProtocolError(
          "invalid_turn_id",
          "turn_id must be an integer between 0 and the current room turn_id.",
          { supplied: input.turn_id, current_turn_id: room.turn_id }
        );
      }

      this.touchMember(input.room_id, input.agent_id, timestamp);

      const noteId = randomUUID();
      const turnId = input.turn_id ?? null;

      this.db
        .prepare(
          `
          INSERT INTO notes (
            note_id, room_id, turn_id, author_agent_id, body, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
        )
        .run(noteId, input.room_id, turnId, input.agent_id, trimmedBody, timestamp);

      return {
        note_id: noteId,
        room_id: input.room_id,
        turn_id: turnId,
        author_agent_id: input.agent_id,
        created_at: timestamp
      };
    });
  }

  listNotes(input: ListNotesInput): ListNotesResult {
    assertNonEmpty(input.room_id, "room_id");
    this.purgeExpiredIdleRooms(this.now());
    this.requireRoom(input.room_id);
    this.touchKnownMember(
      input.room_id,
      input.agent_id,
      this.now().toISOString()
    );

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const includeResolved = input.include_resolved === true;

    let anchorCreatedAt: string | null = null;
    let anchorNoteId: string | null = null;
    if (input.after_note_id) {
      const anchor = this.db
        .prepare<[string, string], { note_id: string; created_at: string }>(
          "SELECT note_id, created_at FROM notes WHERE room_id = ? AND note_id = ?"
        )
        .get(input.room_id, input.after_note_id);
      if (!anchor) {
        throw new ProtocolError(
          "invalid_cursor",
          "after_note_id does not identify a note in this room.",
          { after_note_id: input.after_note_id }
        );
      }
      anchorCreatedAt = anchor.created_at;
      anchorNoteId = anchor.note_id;
    }

    const resolvedFilter = includeResolved ? "" : "AND resolved_at IS NULL";
    const rows = (() => {
      if (anchorCreatedAt !== null && anchorNoteId !== null) {
        return this.db
          .prepare<
            [string, string, string, string, number],
            NoteRow
          >(
            `
            SELECT *
            FROM notes
            WHERE room_id = ?
              ${resolvedFilter}
              AND (created_at > ? OR (created_at = ? AND note_id > ?))
            ORDER BY created_at ASC, note_id ASC
            LIMIT ?
          `
          )
          .all(
            input.room_id,
            anchorCreatedAt,
            anchorCreatedAt,
            anchorNoteId,
            limit
          );
      }
      return this.db
        .prepare<[string, number], NoteRow>(
          `
          SELECT *
          FROM notes
          WHERE room_id = ?
            ${resolvedFilter}
          ORDER BY created_at ASC, note_id ASC
          LIMIT ?
        `
        )
        .all(input.room_id, limit);
    })();

    const notes = rows.map((row) => mapNoteRow(row));

    return { notes };
  }

  private waitForTurnOnce(input: WaitForTurnInput): WaitForTurnResult {
    const now = this.now();
    const timestamp = now.toISOString();
    const room = this.requireRoom(input.room_id);

    this.touchWaitingMember(input.room_id, input.agent_id, timestamp);
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
      const autoClaim = input.auto_claim ?? true;
      if (!autoClaim) {
        return {
          status: "not_yet",
          room_state: inspection.state,
          turn_id: room.turn_id,
          current_owner: room.owner ?? undefined,
          reserved_for: room.reserved_for ?? undefined,
          lease_expires_at: room.lease_expires_at ?? undefined,
          claim_expires_at: room.claim_expires_at ?? undefined,
          reason: "auto_claim_disabled"
        };
      }
      if (this.shouldDeferIdleClaim(room, input.agent_id, now)) {
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
    const member = this.getMember(room.room_id, agentId);

    this.db
      .prepare(
        `
        UPDATE path_rooms
        SET sequence_index = ?,
            owner = ?,
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
        member?.ordinal ?? room.sequence_index,
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
        return {
          room: exactRoom,
          joinedExistingRoom: true,
          warning: `force_new had no effect: a room already exists at ${exactRoom.canonical_path}. force_new only creates a nested room when an ancestor room exists; same-path duplicates are not supported. To get a fresh room for a separate topic, join a distinct subpath.`
        };
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
              last_wait_at = ?,
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
          last_wait_at,
          status,
          host_id,
          pid,
          process_started_at,
          session_kind,
          display_name
        )
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `
      )
      .run(
        roomId,
        agentId,
        nextOrdinal,
        timestamp,
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

  private touchWaitingMember(
    roomId: string,
    agentId: AgentId,
    timestamp: string
  ): void {
    const result = this.db
      .prepare(
        `
        UPDATE room_members
        SET last_seen_at = ?, last_wait_at = ?, status = 'active'
        WHERE room_id = ? AND agent_id = ?
      `
      )
      .run(timestamp, timestamp, roomId, agentId);

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

  private resolveTakeoverKind(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date,
    inspection: RoomInspection,
    operatorOverride: boolean
  ): TakeoverKind {
    try {
      return this.assertTakeoverEligible(room, agentId, now, inspection);
    } catch (error) {
      if (operatorOverride && this.canOperatorOverride(room, agentId)) {
        return "operator_override";
      }
      throw error;
    }
  }

  private canOperatorOverride(room: PathRoomRow, agentId: AgentId): boolean {
    if (room.state === "closed") {
      return false;
    }

    if (room.owner) {
      return room.owner !== agentId;
    }

    if (room.reserved_for) {
      return room.reserved_for !== agentId;
    }

    return false;
  }

  private assertTakeoverEligible(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date,
    inspection: RoomInspection
  ): TakeoverKind {
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

  private findNextWaitingMember(
    roomId: string,
    afterAgentId: AgentId,
    now: Date
  ): RoomMemberRow | null {
    const bestKnownMember = this.findBestFairKnownMember(
      roomId,
      afterAgentId,
      now
    );
    if (!bestKnownMember || !this.isRecentWaiter(bestKnownMember, now)) {
      return null;
    }

    return bestKnownMember;
  }

  private findBestFairKnownMember(
    roomId: string,
    afterAgentId: AgentId | null,
    now: Date
  ): RoomMemberRow | null {
    const members = this.getMembers(roomId);
    const candidates = members.filter((member) => {
      if (member.agent_id === afterAgentId) {
        return false;
      }
      return this.isPlausibleFairCandidate(member, now);
    });

    if (candidates.length === 0) {
      return null;
    }

    const lastOwnership = this.getLastOwnershipByAgent(roomId);
    const referenceOrdinal =
      members.find((member) => member.agent_id === afterAgentId)?.ordinal ?? -1;

    return candidates
      .slice()
      .sort((left, right) =>
        compareFairCandidates(
          left,
          right,
          lastOwnership,
          referenceOrdinal,
          members.length
        )
      )[0];
  }

  private getLastOwnershipByAgent(roomId: string): Map<AgentId, string> {
    const rows = this.db
      .prepare<[string], { agent_id: string; last_owned_at: string }>(
        `
        SELECT to_agent_id AS agent_id, MAX(created_at) AS last_owned_at
        FROM room_events
        WHERE room_id = ?
          AND event_type IN ('claim', 'takeover')
          AND to_agent_id IS NOT NULL
        GROUP BY to_agent_id
      `
      )
      .all(roomId);

    return new Map(
      rows.map((row) => [row.agent_id, row.last_owned_at])
    );
  }

  private appendEvent(input: {
    room_id: string;
    turn_id: number;
    event_type: EventType;
    from_agent_id: string | null;
    to_agent_id: string | null;
    handoff: Handoff | null;
    reason: string | null;
    created_at: string;
    payload?: MessagePayload | null;
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
          created_at,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.created_at,
        input.payload ? JSON.stringify(input.payload) : null
      );

    return Number(result.lastInsertRowid);
  }

  private queryEvents(input: {
    room_id: string;
    after_event_seq: number;
    event_types: EventType[] | null;
    target: TargetAgentFilter;
    caller_agent_id: AgentId | null;
    from_agent_id: AgentId | null;
    limit: number;
  }): RoomEvent[] {
    const clauses = ["room_id = ?", "event_seq > ?"];
    const params: unknown[] = [input.room_id, input.after_event_seq];

    if (input.event_types) {
      clauses.push(
        `event_type IN (${input.event_types.map(() => "?").join(", ")})`
      );
      params.push(...input.event_types);
    }

    if (input.target === "self") {
      if (!input.caller_agent_id) {
        throw new ProtocolError(
          "agent_id_required",
          "agent_id is required when target_agent_id is 'self'."
        );
      }
      clauses.push(
        `(
          (event_type = 'message_sent' AND (to_agent_id = ? OR (to_agent_id IS NULL AND from_agent_id != ?)))
          OR
          (event_type != 'message_sent' AND (to_agent_id = ? OR from_agent_id = ?))
        )`
      );
      params.push(
        input.caller_agent_id,
        input.caller_agent_id,
        input.caller_agent_id,
        input.caller_agent_id
      );
    } else if (input.target !== "any") {
      clauses.push("to_agent_id = ?");
      params.push(input.target);
    }

    if (input.from_agent_id) {
      clauses.push("from_agent_id = ?");
      params.push(input.from_agent_id);
    }

    params.push(Math.min(Math.max(input.limit, 1), 500));

    return this.db
      .prepare<unknown[], RoomEventRow>(
        `
        SELECT *
        FROM room_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY event_seq
        LIMIT ?
      `
      )
      .all(...params)
      .map((row) => this.mapEvent(row));
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

  private purgeExpiredIdleRooms(now: Date): void {
    if (this.policy.idleRoomTtlMs <= 0) {
      return;
    }

    const cutoffMs = now.getTime() - this.policy.idleRoomTtlMs;

    withImmediateTransaction(this.db, () => {
      const rooms = this.db
        .prepare<[], PathRoomRow>("SELECT * FROM path_rooms")
        .all();

      for (const room of rooms) {
        const members = this.getMembers(room.room_id);
        if (this.latestRoomActivityMs(room, members) > cutoffMs) {
          continue;
        }

        if (members.some((member) => this.isMemberActive(member, now))) {
          continue;
        }

        this.deleteRoom(room.room_id);
      }
    });
  }

  private latestRoomActivityMs(
    room: PathRoomRow,
    members: RoomMemberRow[]
  ): number {
    let latest = parseTimestampMs(room.updated_at);

    for (const member of members) {
      latest = Math.max(
        latest,
        parseTimestampMs(member.joined_at),
        parseTimestampMs(member.last_seen_at),
        parseTimestampMs(member.last_wait_at)
      );
    }

    return latest;
  }

  private deleteRoom(roomId: string): void {
    this.db.prepare("DELETE FROM notes WHERE room_id = ?").run(roomId);
    this.db.prepare("DELETE FROM room_events WHERE room_id = ?").run(roomId);
    this.db.prepare("DELETE FROM room_members WHERE room_id = ?").run(roomId);
    this.db.prepare("DELETE FROM path_rooms WHERE room_id = ?").run(roomId);
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

  private isRecentWaiter(member: RoomMemberRow, now: Date): boolean {
    if (!member.last_wait_at) {
      return false;
    }

    if (!this.hasRecentPresence(member, now)) {
      return false;
    }

    return (
      now.getTime() - Date.parse(member.last_wait_at) <=
      this.policy.waiterGraceMs
    );
  }

  private isPlausibleFairCandidate(
    member: RoomMemberRow,
    now: Date
  ): boolean {
    return this.hasRecentPresence(member, now);
  }

  private shouldDeferIdleClaim(
    room: PathRoomRow,
    agentId: AgentId,
    now: Date
  ): boolean {
    if (!room.pending_handoff_event_seq) {
      return false;
    }

    const handoffAgeMs = now.getTime() - Date.parse(room.updated_at);

    const pendingEvent = this.getEventBySeq(room.pending_handoff_event_seq);
    const priorOwner = pendingEvent?.from_agent_id ?? null;

    if (
      priorOwner === agentId &&
      this.hasOtherActiveRoomMember(room.room_id, agentId, now)
    ) {
      return handoffAgeMs < this.priorOwnerReleaseCooldownMs();
    }

    if (handoffAgeMs >= this.policy.waiterGraceMs) {
      return false;
    }

    const bestKnownMember = this.findBestFairKnownMember(
      room.room_id,
      priorOwner,
      now
    );

    return bestKnownMember !== null && bestKnownMember.agent_id !== agentId;
  }

  private hasOtherActiveRoomMember(
    roomId: string,
    agentId: AgentId,
    now: Date
  ): boolean {
    return this.getMembers(roomId).some(
      (member) => member.agent_id !== agentId && this.isMemberActive(member, now)
    );
  }

  private priorOwnerReleaseCooldownMs(): number {
    return Math.max(this.policy.waiterGraceMs * 6, 60_000);
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
    const payload =
      row.event_type === "message_sent" && row.payload_json
        ? (JSON.parse(row.payload_json) as MessagePayload)
        : null;

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
      created_at: row.created_at,
      payload
    };
  }
}

function mapNoteRow(row: NoteRow): Note {
  return {
    note_id: row.note_id,
    room_id: row.room_id,
    turn_id: row.turn_id,
    author_agent_id: row.author_agent_id,
    body: row.body,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_by_agent_id: row.resolved_by_agent_id
  };
}

function compareFairCandidates(
  left: RoomMemberRow,
  right: RoomMemberRow,
  lastOwnership: Map<AgentId, string>,
  referenceOrdinal: number,
  memberCount: number
): number {
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

  const leftDistance = sequenceDistance(
    left.ordinal,
    referenceOrdinal,
    memberCount
  );
  const rightDistance = sequenceDistance(
    right.ordinal,
    referenceOrdinal,
    memberCount
  );
  if (leftDistance !== rightDistance) {
    return leftDistance - rightDistance;
  }

  return left.ordinal - right.ordinal;
}

function sequenceDistance(
  ordinal: number,
  referenceOrdinal: number,
  memberCount: number
): number {
  if (memberCount <= 0 || referenceOrdinal < 0) {
    return ordinal;
  }

  const distance = (ordinal - referenceOrdinal + memberCount) % memberCount;
  return distance === 0 ? memberCount : distance;
}

function parseTimestampMs(timestamp: string | null): number {
  if (!timestamp) {
    return 0;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
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

function normalizeEventTypeFilter(
  filter: EventTypeFilter | undefined
): EventType[] | null {
  if (filter === undefined) {
    return null;
  }

  const values = Array.isArray(filter) ? filter : [filter];
  if (values.length === 0) {
    throw new ProtocolError(
      "invalid_event_type_filter",
      "event_type filter must not be empty."
    );
  }

  for (const value of values) {
    if (!KNOWN_EVENT_TYPES.includes(value)) {
      throw new ProtocolError(
        "invalid_event_type_filter",
        `Unsupported event_type: ${value}.`
      );
    }
  }

  return values;
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
