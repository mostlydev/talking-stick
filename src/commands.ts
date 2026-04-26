import { TalkingStickService } from "./service.js";
import type {
  AddNoteResult,
  GetRoomEventsInput,
  GetRoomStateInput,
  GetRoomStateResult,
  HeartbeatResult,
  JoinPathResult,
  LeaveRoomResult,
  ListNotesResult,
  ListRoomsInput,
  ListRoomsResult,
  PassStickInput,
  PassStickResult,
  ReleaseStickInput,
  ReleaseStickResult,
  RoomEvent,
  TakeoverStickInput,
  TakeoverStickResult,
  WaitForTurnInput,
  WaitForTurnResult
} from "./types.js";
import type { DerivedIdentity } from "./identity.js";

export interface JoinPathCommandInput {
  context_path: string;
  force_new?: boolean;
}

export interface LeaveRoomCommandInput {
  room_id: string;
}

export interface HeartbeatCommandInput {
  room_id: string;
  lease_id: string;
  expected_turn_id: number;
}

export interface ReleaseStickCommandInput extends HeartbeatCommandInput {
  handoff: ReleaseStickInput["handoff"];
}

export interface PassStickCommandInput extends HeartbeatCommandInput {
  to_agent_id: string;
  handoff: PassStickInput["handoff"];
}

export interface WaitForTurnCommandInput {
  room_id: string;
  max_wait_ms?: number;
}

export interface TakeoverStickCommandInput {
  room_id: string;
  expected_turn_id: number;
  reason: string;
  operator_override?: boolean;
}

export interface AddNoteCommandInput {
  room_id: string;
  body: string;
  turn_id?: number;
}

export interface ListNotesCommandInput {
  room_id: string;
  after_note_id?: string;
  include_resolved?: boolean;
  limit?: number;
}

export class TalkingStickCommands {
  constructor(private readonly service = new TalkingStickService()) {}

  close(): void {
    this.service.close();
  }

  listRooms(input: ListRoomsInput = {}): ListRoomsResult {
    return this.service.listRooms(input);
  }

  joinPath(
    identity: DerivedIdentity,
    input: JoinPathCommandInput
  ): JoinPathResult {
    return this.service.joinPath({
      agent_id: identity.agent_id,
      context_path: input.context_path,
      force_new: input.force_new,
      process_metadata: identity.process_metadata
    });
  }

  leaveRoom(
    identity: DerivedIdentity,
    input: LeaveRoomCommandInput
  ): LeaveRoomResult {
    return this.service.leaveRoom({
      agent_id: identity.agent_id,
      room_id: input.room_id
    });
  }

  waitForTurn(
    identity: DerivedIdentity,
    input: WaitForTurnCommandInput
  ): Promise<WaitForTurnResult> {
    return this.service.waitForTurn({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      max_wait_ms: input.max_wait_ms
    });
  }

  heartbeat(
    identity: DerivedIdentity,
    input: HeartbeatCommandInput
  ): HeartbeatResult {
    return this.service.heartbeat({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      lease_id: input.lease_id,
      expected_turn_id: input.expected_turn_id
    });
  }

  releaseStick(
    identity: DerivedIdentity,
    input: ReleaseStickCommandInput
  ): ReleaseStickResult {
    return this.service.releaseStick({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      lease_id: input.lease_id,
      expected_turn_id: input.expected_turn_id,
      handoff: input.handoff
    });
  }

  passStick(
    identity: DerivedIdentity,
    input: PassStickCommandInput
  ): PassStickResult {
    return this.service.passStick({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      lease_id: input.lease_id,
      expected_turn_id: input.expected_turn_id,
      to_agent_id: input.to_agent_id,
      handoff: input.handoff
    });
  }

  takeoverStick(
    identity: DerivedIdentity,
    input: TakeoverStickCommandInput
  ): TakeoverStickResult {
    return this.service.takeoverStick({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      expected_turn_id: input.expected_turn_id,
      reason: input.reason,
      operator_override: input.operator_override
    });
  }

  getRoomState(input: GetRoomStateInput): GetRoomStateResult {
    return this.service.getRoomState(input);
  }

  getRoomEvents(input: GetRoomEventsInput): RoomEvent[] {
    return this.service.getRoomEvents(input);
  }

  addNote(
    identity: DerivedIdentity,
    input: AddNoteCommandInput
  ): AddNoteResult {
    return this.service.addNote({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      body: input.body,
      turn_id: input.turn_id
    });
  }

  listNotes(
    identity: DerivedIdentity | null,
    input: ListNotesCommandInput
  ): ListNotesResult {
    return this.service.listNotes({
      room_id: input.room_id,
      agent_id: identity?.agent_id,
      after_note_id: input.after_note_id,
      include_resolved: input.include_resolved,
      limit: input.limit
    });
  }
}
