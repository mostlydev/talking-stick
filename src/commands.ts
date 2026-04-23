import { TalkingStickService } from "./service.js";
import type {
  GetRoomEventsInput,
  GetRoomStateInput,
  GetRoomStateResult,
  HeartbeatResult,
  JoinPathResult,
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
  cursor?: string;
  max_wait_ms?: number;
}

export interface TakeoverStickCommandInput {
  room_id: string;
  expected_turn_id: number;
  reason: string;
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

  waitForTurn(
    identity: DerivedIdentity,
    input: WaitForTurnCommandInput
  ): Promise<WaitForTurnResult> {
    return this.service.waitForTurn({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      cursor: input.cursor,
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
      reason: input.reason
    });
  }

  getRoomState(input: GetRoomStateInput): GetRoomStateResult {
    return this.service.getRoomState(input);
  }

  getRoomEvents(input: GetRoomEventsInput): RoomEvent[] {
    return this.service.getRoomEvents(input);
  }
}
