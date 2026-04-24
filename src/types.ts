export type AgentId = string;

export type StoredRoomState = "idle" | "owned" | "reserved" | "closed";

export type RoomState =
  | StoredRoomState
  | "stale_owner"
  | "owner_gone"
  | "recipient_gone"
  | "dormant";

export type SessionKind =
  | "mcp_harness"
  | "human_guardian"
  | "human_cli"
  | "harness_cli"
  | string;

export interface ProcessMetadata {
  host_id?: string | null;
  pid?: number | null;
  process_started_at?: string | null;
  session_kind?: SessionKind;
  display_name?: string | null;
}

export type HandoffArtifactRole =
  | "examine"
  | "review"
  | "edit"
  | "context"
  | "output";

export interface HandoffArtifact {
  path: string;
  lines?: number[];
  role: HandoffArtifactRole;
  note?: string;
}

export interface Handoff {
  status: string;
  next_action: string;
  artifacts?: HandoffArtifact[];
  open_questions?: string[];
  do_not?: string[];
}

export interface Policy {
  ownerLeaseTtlMs: number;
  heartbeatIntervalMs: number;
  claimTtlMs: number;
  waitForTurnMaxWaitMs: number;
  waitForTurnPollMs: number;
  presenceTtlMs: number;
}

export interface PathRoom {
  room_id: string;
  canonical_path: string;
  sequence_index: number;
  owner: AgentId | null;
  reserved_for: AgentId | null;
  pending_handoff_event_seq: number | null;
  turn_id: number;
  lease_id: string | null;
  lease_expires_at: string | null;
  claim_expires_at: string | null;
  state: RoomState;
  updated_at: string;
}

export interface RoomMember {
  room_id: string;
  agent_id: AgentId;
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

export interface RoomEvent {
  event_seq: number;
  event_id: string;
  room_id: string;
  turn_id: number;
  event_type: "claim" | "release" | "pass" | "takeover" | "close";
  from_agent_id: AgentId | null;
  to_agent_id: AgentId | null;
  handoff: Handoff | null;
  reason: string | null;
  created_at: string;
}

export interface JoinPathInput {
  agent_id: AgentId;
  context_path: string;
  force_new?: boolean;
  process_metadata?: ProcessMetadata;
}

export interface JoinPathResult {
  agent_id: AgentId;
  room_id: string;
  canonical_path: string;
  requested_path: string;
  workspace_root: string;
  joined_existing_room: boolean;
  warning?: string;
  policy: Policy;
  room_state: PathRoom;
  handoff_template: Handoff;
}

export interface WaitForTurnInput {
  agent_id: AgentId;
  room_id: string;
  cursor?: string;
  max_wait_ms?: number;
}

export type WaitForTurnResult =
  | {
      status: "your_turn";
      room_id: string;
      turn_id: number;
      lease_id: string;
      handoff: Handoff | null;
      from_agent_id: AgentId | null;
      reason: "direct_pass" | "sequence" | "open_claim";
    }
  | {
      status: "not_yet";
      cursor: string;
      room_state: RoomState;
    }
  | {
      status: "takeover_available";
      room_id: string;
      turn_id: number;
      room_state:
        | "owned"
        | "reserved"
        | "stale_owner"
        | "owner_gone"
        | "recipient_gone";
      reason:
        | "claim_timeout"
        | "owner_timeout"
        | "owner_gone"
        | "recipient_gone";
      current_owner?: AgentId;
      reserved_for?: AgentId;
    }
  | {
      status: "closed";
      room_id: string;
    };

export interface OwnerMutationInput {
  room_id: string;
  agent_id: AgentId;
  lease_id: string;
  expected_turn_id: number;
}

export interface HeartbeatResult {
  status: "ok";
  room_id: string;
  turn_id: number;
  lease_id: string;
  lease_expires_at: string;
}

export interface ReleaseStickInput extends OwnerMutationInput {
  handoff: Handoff;
}

export interface ReleaseStickResult {
  status: "released";
  room_id: string;
  reserved_for: AgentId | null;
  event_seq: number;
}

export interface PassStickInput extends OwnerMutationInput {
  to_agent_id: AgentId;
  handoff: Handoff;
}

export interface PassStickResult {
  status: "passed";
  room_id: string;
  reserved_for: AgentId;
  event_seq: number;
}

export interface TakeoverStickInput {
  agent_id: AgentId;
  room_id: string;
  expected_turn_id: number;
  reason: string;
}

export interface TakeoverStickResult {
  status: "your_turn";
  room_id: string;
  turn_id: number;
  lease_id: string;
  revoked_agent_id: AgentId | null;
  reason: "claim_timeout" | "owner_timeout" | "owner_gone" | "recipient_gone";
}

export interface GetRoomStateInput {
  room_id: string;
  agent_id?: AgentId;
}

export interface GetRoomStateResult {
  room: PathRoom;
  members: RoomMember[];
}

export interface GetRoomEventsInput {
  room_id: string;
  agent_id?: AgentId;
  after_event_seq?: number;
  limit?: number;
}

export interface ListRoomsInput {
  context_path?: string;
}

export interface ListRoomsResult {
  rooms: PathRoom[];
}
