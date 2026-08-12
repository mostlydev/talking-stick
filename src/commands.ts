import { TalkingStickService } from "./service.js";
import type {
  AddNoteResult,
  GetRoomEventsInput,
  GetRoomEventsViewResult,
  GetRoomHealthInput,
  GetRoomHealthResult,
  GetRoomStateInput,
  GetRoomStateResult,
  HeartbeatReceiverResult,
  HeartbeatResult,
  JoinPathResult,
  KickMemberResult,
  LeaveRoomResult,
  ListNotesResult,
  ListRoomsInput,
  ListRoomsResult,
  PassStickInput,
  PassStickResult,
  RelinquishOwnershipResult,
  RegisterStandbyResult,
  RegisterReceiverResult,
  ReleaseStickInput,
  ReleaseStickResult,
  RoomEvent,
  SendMessageResult,
  TakeoverStickInput,
  TakeoverStickResult,
  WaitForEventsInput,
  WaitForEventsResult,
  WaitForTurnInput,
  WaitForTurnResult,
  UnregisterReceiverResult
} from "./types.js";
import type { DerivedIdentity } from "./identity.js";

export interface JoinPathCommandInput {
  context_path: string;
  force_new?: boolean;
}

export interface LeaveRoomCommandInput {
  room_id: string;
}

export interface KickMemberCommandInput {
  room_id: string;
  target_agent_id: string;
  force?: boolean;
  reason?: string;
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
  auto_claim?: boolean;
  mode?: WaitForTurnInput["mode"];
  include_events?: boolean;
  after_event_seq?: number;
  target_agent_id?: WaitForTurnInput["target_agent_id"];
}

export interface RegisterReceiverCommandInput {
  room_id: string;
  receiver_id: string;
  harness_session_id?: string | null;
  host_id: string;
  pid: number;
  process_started_at: string;
  cursor_event_seq: number;
}

export interface HeartbeatReceiverCommandInput {
  room_id: string;
  receiver_id: string;
  cursor_event_seq: number;
}

export interface UnregisterReceiverCommandInput
  extends HeartbeatReceiverCommandInput {}

export interface RegisterStandbyCommandInput {
  room_id: string;
  transport: "cmux" | "manual";
  workspace_id?: string | null;
  surface_id?: string | null;
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
  include_all?: boolean;
  limit?: number;
}

export interface SendMessageCommandInput {
  room_id: string;
  body: string;
  to_agent_id?: string | null;
  delivery_hint?: "normal" | "interrupt";
}

export interface WaitForEventsCommandInput extends WaitForEventsInput {}

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

  kickMember(
    identity: DerivedIdentity,
    input: KickMemberCommandInput
  ): KickMemberResult {
    return this.service.kickMember({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      target_agent_id: input.target_agent_id,
      force: input.force,
      reason: input.reason
    });
  }

  waitForTurn(
    identity: DerivedIdentity,
    input: WaitForTurnCommandInput
  ): Promise<WaitForTurnResult> {
    return this.service.waitForTurn({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      max_wait_ms: input.max_wait_ms,
      auto_claim: input.auto_claim,
      mode: input.mode,
      include_events: input.include_events,
      after_event_seq: input.after_event_seq,
      target_agent_id: input.target_agent_id,
      process_metadata: identity.process_metadata
    });
  }

  registerReceiver(
    identity: DerivedIdentity,
    input: RegisterReceiverCommandInput
  ): RegisterReceiverResult {
    return this.service.registerReceiver({
      agent_id: identity.agent_id,
      ...input
    });
  }

  heartbeatReceiver(
    identity: DerivedIdentity,
    input: HeartbeatReceiverCommandInput
  ): HeartbeatReceiverResult {
    return this.service.heartbeatReceiver({
      agent_id: identity.agent_id,
      ...input
    });
  }

  unregisterReceiver(
    identity: DerivedIdentity,
    input: UnregisterReceiverCommandInput
  ): UnregisterReceiverResult {
    return this.service.unregisterReceiver({
      agent_id: identity.agent_id,
      ...input
    });
  }

  registerStandby(
    identity: DerivedIdentity,
    input: RegisterStandbyCommandInput
  ): RegisterStandbyResult {
    return this.service.registerStandby({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      transport: input.transport,
      workspace_id: input.workspace_id,
      surface_id: input.surface_id,
      process_metadata: identity.process_metadata
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

  relinquishOwnership(
    identity: DerivedIdentity,
    input: HeartbeatCommandInput
  ): RelinquishOwnershipResult {
    return this.service.relinquishOwnership({
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
      handoff: input.handoff,
      process_metadata: identity.process_metadata
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
      handoff: input.handoff,
      process_metadata: identity.process_metadata
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
      operator_override: input.operator_override,
      process_metadata: identity.process_metadata
    });
  }

  getRoomState(input: GetRoomStateInput): GetRoomStateResult {
    return this.service.getRoomState(input);
  }

  getRoomEvents(input: GetRoomEventsInput): RoomEvent[] {
    return this.service.getRoomEvents(input);
  }

  getRoomEventsView(input: GetRoomEventsInput): GetRoomEventsViewResult {
    return this.service.getRoomEventsView(input);
  }

  getRoomHealth(
    identity: DerivedIdentity | null,
    input: GetRoomHealthInput
  ): GetRoomHealthResult {
    return this.service.getRoomHealth({
      ...input,
      agent_id: identity?.agent_id ?? input.agent_id,
      process_metadata: identity?.process_metadata ?? input.process_metadata
    });
  }

  sendMessage(
    identity: DerivedIdentity,
    input: SendMessageCommandInput
  ): SendMessageResult {
    return this.service.sendMessage({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      body: input.body,
      to_agent_id: input.to_agent_id,
      delivery_hint: input.delivery_hint,
      process_metadata: identity.process_metadata
    });
  }

  waitForEvents(input: WaitForEventsCommandInput): Promise<WaitForEventsResult> {
    return this.service.waitForEvents(input);
  }

  getLatestEventSeq(input: { room_id: string }): number {
    return this.service.getLatestEventSeq(input);
  }

  addNote(
    identity: DerivedIdentity,
    input: AddNoteCommandInput
  ): AddNoteResult {
    return this.service.addNote({
      agent_id: identity.agent_id,
      room_id: input.room_id,
      body: input.body,
      turn_id: input.turn_id,
      process_metadata: identity.process_metadata
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
      include_all: input.include_all,
      limit: input.limit,
      process_metadata: identity?.process_metadata
    });
  }
}
