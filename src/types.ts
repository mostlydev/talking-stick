export type AgentId = string;

export type StoredRoomState = "idle" | "owned" | "reserved" | "closed";

export type RoomState =
  | StoredRoomState
  | "stale_owner"
  | "owner_gone"
  | "owner_idle"
  | "recipient_gone"
  | "dormant";

export type SessionKind =
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
  harness_name?: string | null;
  harness_session_id?: string | null;
  harness_host_id?: string | null;
  harness_pid?: number | null;
  harness_process_started_at?: string | null;
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
  /**
   * How long an owner's harness can go without any `tt` activity (last_seen_at)
   * before a waiting peer may take over via `owner_idle`. The owner's harness
   * process is still alive (so this is not `owner_gone`/`owner_timeout`); the
   * takeover is gated on an actively-waiting peer, so a long solo edit with no
   * peers waiting is never disturbed.
   */
  ownerActivityTtlMs: number;
  heartbeatIntervalMs: number;
  claimTtlMs: number;
  waitForTurnMaxWaitMs: number;
  waitForTurnPollMs: number;
  waitForEventsMaxWaitMs: number;
  waitForEventsPollMs: number;
  waitForEventsBatchLimit: number;
  presenceTtlMs: number;
  waiterGraceMs: number;
  idleRoomTtlMs: number;
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
  last_wait_at: string | null;
  host_id: string | null;
  pid: number | null;
  process_started_at: string | null;
  session_kind: SessionKind;
  display_name: string | null;
  harness_name: string | null;
  harness_session_id: string | null;
  harness_host_id: string | null;
  harness_pid: number | null;
  harness_process_started_at: string | null;
  last_park_hint_event_seq: number | null;
  status: "active" | "inactive";
}

export type EventType =
  | "claim"
  | "release"
  | "pass"
  | "takeover"
  | "close"
  | "kick"
  | "session_superseded"
  | "message_sent";

export type DeliveryHint = "normal" | "interrupt";

export interface MessagePayload {
  body: string;
  delivery_hint: DeliveryHint;
}

export interface RoomEvent {
  event_seq: number;
  event_id: string;
  room_id: string;
  turn_id: number;
  event_type: EventType;
  from_agent_id: AgentId | null;
  to_agent_id: AgentId | null;
  handoff: Handoff | null;
  reason: string | null;
  created_at: string;
  payload: MessagePayload | null;
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
  cursor_event_seq: number;
  warning?: string;
  policy: Policy;
  room_state: PathRoom;
  handoff_template: Handoff;
}

export interface LeaveRoomInput {
  agent_id: AgentId;
  room_id: string;
}

export interface LeaveRoomResult {
  status: "left" | "room_deleted";
  room_id: string;
  canonical_path: string;
  remaining_members: number;
}

export interface KickMemberInput {
  agent_id: AgentId;
  room_id: string;
  target_agent_id: AgentId;
  force?: boolean;
  reason?: string;
}

export interface KickMemberResult {
  status: "kicked" | "room_deleted";
  room_id: string;
  canonical_path: string;
  kicked_agent_id: AgentId;
  remaining_members: number;
  target_was_owner: boolean;
  target_was_reserved_for: boolean;
}

export interface WaitForTurnInput {
  agent_id: AgentId;
  room_id: string;
  max_wait_ms?: number;
  auto_claim?: boolean;
  include_events?: boolean;
  after_event_seq?: number;
  target_agent_id?: TargetAgentFilter;
  process_metadata?: ProcessMetadata;
}

export type WaitWakeReason = "turn" | "event" | "timeout" | "closed";

export interface WaitForTurnEventFields {
  events: RoomEvent[];
  cursor_event_seq: number;
  wake_reason: WaitWakeReason;
}

export type WaitForTurnCoreResult =
  | {
      status: "your_turn";
      room_id: string;
      turn_id: number;
      lease_id: string;
      handoff: Handoff | null;
      from_agent_id: AgentId | null;
      reason: "direct_pass" | "sequence" | "open_claim" | "already_owner";
    }
  | {
      status: "not_yet";
      room_state: RoomState;
      turn_id: number;
      current_owner?: AgentId;
      reserved_for?: AgentId;
      lease_expires_at?: string;
      claim_expires_at?: string;
      reason?: "auto_claim_disabled" | "lost_turn";
      hint?: string;
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
        | "owner_idle"
        | "recipient_gone";
      reason:
        | "claim_timeout"
        | "owner_timeout"
        | "owner_gone"
        | "owner_idle"
        | "recipient_gone";
      current_owner?: AgentId;
      reserved_for?: AgentId;
    }
  | {
      status: "closed";
      room_id: string;
    };

export type WaitForTurnResult = WaitForTurnCoreResult &
  Partial<WaitForTurnEventFields>;

export interface OwnerMutationInput {
  room_id: string;
  agent_id: AgentId;
  lease_id: string;
  expected_turn_id: number;
  process_metadata?: ProcessMetadata;
}

export interface HeartbeatResult {
  status: "ok";
  room_id: string;
  turn_id: number;
  lease_id: string;
  lease_expires_at: string;
}

export type RelinquishOwnershipResult =
  | {
      status: "relinquished";
      room_id: string;
      event_seq: number;
    }
  | {
      status: "retained";
      room_id: string;
    }
  | {
      status: "noop";
      room_id: string;
    };

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
  operator_override?: boolean;
  process_metadata?: ProcessMetadata;
}

export interface TakeoverStickResult {
  status: "your_turn";
  room_id: string;
  turn_id: number;
  lease_id: string;
  revoked_agent_id: AgentId | null;
  reason:
    | "claim_timeout"
    | "owner_timeout"
    | "owner_gone"
    | "owner_idle"
    | "recipient_gone"
    | "operator_override";
}

export interface GetRoomStateInput {
  room_id: string;
  agent_id?: AgentId;
  process_metadata?: ProcessMetadata;
  include_all?: boolean;
}

export interface GetRoomStateResult {
  room: PathRoom;
  members: RoomMember[];
  cursor_event_seq: number;
  hidden?: {
    members: HiddenRowsSummary;
  };
}

export interface GetRoomEventsInput {
  room_id: string;
  agent_id?: AgentId;
  after_event_seq?: number;
  limit?: number;
  process_metadata?: ProcessMetadata;
  include_all?: boolean;
}

export interface GetRoomEventsViewResult {
  events: RoomEvent[];
  hidden?: {
    events: HiddenRowsSummary;
  };
}

export interface GetRoomHealthInput {
  context_path: string;
  agent_id?: AgentId;
  process_metadata?: ProcessMetadata;
  include_all?: boolean;
}

export interface GetRoomHealthResult {
  room: PathRoom;
  members: RoomMember[];
  cursor_event_seq: number;
  pending_handoff: RoomEvent | null;
  takeover: RoomHealthTakeover;
  hidden?: {
    members: HiddenRowsSummary;
  };
}

export interface RoomHealthTakeover {
  available: boolean;
  reason?:
    | "claim_timeout"
    | "owner_timeout"
    | "owner_gone"
    | "owner_idle"
    | "recipient_gone";
  room_state?: RoomState;
  current_owner?: AgentId;
  reserved_for?: AgentId;
}

export interface SendMessageInput {
  agent_id: AgentId;
  room_id: string;
  body: string;
  to_agent_id?: AgentId | null;
  delivery_hint?: DeliveryHint;
  process_metadata?: ProcessMetadata;
}

export interface SendMessageResult {
  event_seq: number;
  event_id: string;
  created_at: string;
}

export type EventTypeFilter = EventType | EventType[];

export type TargetAgentFilter = "self" | "any" | AgentId;

export interface WaitForEventsInput {
  agent_id?: AgentId;
  room_id: string;
  after_event_seq?: number;
  event_type?: EventTypeFilter;
  target_agent_id?: TargetAgentFilter;
  from_agent_id?: AgentId;
  max_wait_ms?: number;
  process_metadata?: ProcessMetadata;
}

export interface WaitForEventsResult {
  events: RoomEvent[];
  cursor_event_seq: number;
}

export interface ListRoomsInput {
  context_path?: string;
}

export interface ListRoomsResult {
  rooms: PathRoom[];
}

export interface Note {
  note_id: string;
  room_id: string;
  turn_id: number | null;
  author_agent_id: AgentId;
  body: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_agent_id: AgentId | null;
}

export interface AddNoteInput {
  agent_id: AgentId;
  room_id: string;
  body: string;
  turn_id?: number;
  process_metadata?: ProcessMetadata;
}

export interface AddNoteResult {
  note_id: string;
  room_id: string;
  turn_id: number | null;
  author_agent_id: AgentId;
  created_at: string;
}

export interface ListNotesInput {
  room_id: string;
  agent_id?: AgentId;
  after_note_id?: string;
  include_resolved?: boolean;
  include_all?: boolean;
  limit?: number;
  process_metadata?: ProcessMetadata;
}

export interface ListNotesResult {
  notes: Note[];
  hidden?: {
    notes: HiddenRowsSummary;
  };
}

export interface HiddenRowsSummary {
  older_count: number;
  shown_count: number;
  total_count: number;
  latest_activity_at: string | null;
  horizon_start_at: string | null;
}
