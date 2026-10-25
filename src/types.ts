import type { MessageAttachment } from "./attachments.js";
import type { NativeWakeState, NativeWakeTransportName } from "./native-wake.js";
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
  | "human_chat"
  | "harness_cli"
  | string;

export const HUMAN_CHAT_SESSION_KIND = "human_chat";

export type WaitIntent = "active" | "parked";
export type WaitMode = WaitIntent;
export type StandbyTransport = "cmux" | "manual";

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
  wait_intent: WaitIntent | null;
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
  standby_transport: StandbyTransport | null;
  standby_workspace_id: string | null;
  standby_surface_id: string | null;
  standby_generation: number;
  standby_wake_pending: boolean;
  standby_registered_at: string | null;
  standby_last_error: string | null;
  standby_delivered_at: string | null;
  wake_workspace_id: string | null;
  wake_surface_id: string | null;
  wake_endpoint_session_id: string | null;
  wake_endpoint_generation: number;
  wake_endpoint_recorded_at: string | null;
  wake_interrupt_delivered_at: string | null;
  status: "active" | "inactive";
  // Whether the member's harness process is still running on this host;
  // unknown for other hosts or missing process identity.
  process_liveness: "alive" | "gone" | "unknown";
}

export type EventType =
  | "join"
  | "leave"
  | "claim"
  | "release"
  | "pass"
  | "takeover"
  | "close"
  | "kick"
  | "session_superseded"
  | "reservation_expired"
  | "message_sent";

export type DeliveryHint = "normal" | "interrupt";

export interface MessagePayload {
  body: string;
  delivery_hint: DeliveryHint;
  // Present when several named agents share one message instead of to_agent_id.
  recipients?: AgentId[];
  // Agents an operator's room message was delivered to; display only.
  sent_to?: AgentId[];
  // Stored images, in the order the message numbers them.
  attachments?: MessageAttachment[];
  // A visitor's question (tt room ask), and an answer to one (tt msg reply).
  request_id?: string;
  in_reply_to?: string;
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
  /** Join exactly this existing room instead of resolving context_path. */
  room_id?: string;
  force_new?: boolean;
  process_metadata?: ProcessMetadata;
  /** An explicit join may restore this session's lost membership. */
  recover?: boolean;
  /** Credentials from earlier joins, by room id. */
  recovery_credentials?: Record<string, string>;
}

/** How a lost membership was restored by its own session's join. */
export interface JoinRecovery {
  lost_at: string;
  hook_reason: string | null;
  evidence: "credential" | "process_identity" | "session_start";
  /** Read the room's events after this one: they were not received before the loss. */
  replay_from_event_seq: number;
  gap?: { from_event_seq: number; to_event_seq: number };
  /** Receipts for events the room no longer has; those deliveries are gone. */
  dropped_receipts?: number;
}

/** What a lost member's recovery notice did; queued is not delivered. */
export type RecoveryNoticeStatus =
  | "injected" | "queued" | "ambiguous" | "unreachable" | "process_not_running" | "already_sent" | "recovered";

/** A member whose harness reported its session ended, still recoverable. */
export interface LostMember {
  agent_id: AgentId;
  harness_name: string;
  lost_at: string;
  hook_reason: string | null;
  notice_status: string | null;
  notice_at: string | null;
}

/** A recipient that was not woken: the message waits for it to recover. */
export interface HeldRecipient {
  agent_id: AgentId;
  reason: "member_lost";
  lost_at: string;
  notice?: RecoveryNoticeStatus;
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
  members: Array<Pick<RoomMember, "agent_id" | "status" | "last_seen_at">>;
  policy: Policy;
  room_state: PathRoom;
  handoff_template: Handoff;
  recovered?: JoinRecovery;
  /** Issued once per session; keep it private to recover after a loss. */
  recovery_credential?: string;
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
  allow_solo_claim?: boolean;
  mode?: WaitMode;
  include_events?: boolean;
  after_event_seq?: number;
  target_agent_id?: TargetAgentFilter;
  process_metadata?: ProcessMetadata;
  // When false, an advisory `takeover_available` (reason `owner_idle`, owner
  // still alive) does not end the wait; ownership hazards always do.
  advisory_takeover_wake?: boolean;
}

export interface RegisterReceiverInput {
  agent_id: AgentId;
  room_id: string;
  receiver_id: string;
  harness_session_id?: string | null;
  host_id: string;
  pid: number;
  process_started_at: string;
  cursor_event_seq: number;
}

export interface HeartbeatReceiverInput {
  agent_id: AgentId;
  room_id: string;
  receiver_id: string;
  cursor_event_seq: number;
}

export interface UnregisterReceiverInput {
  agent_id: AgentId;
  room_id: string;
  receiver_id: string;
  cursor_event_seq: number;
}

export interface RoomReceiver {
  room_id: string;
  agent_id: AgentId;
  receiver_id: string;
  harness_session_id: string | null;
  host_id: string;
  pid: number;
  process_started_at: string;
  cursor_event_seq: number;
  generation: number;
  registered_at: string;
  heartbeat_at: string;
  liveness: "alive" | "gone" | "unknown";
}

export interface RegisterReceiverResult {
  status: "receiver_registered";
  receiver: RoomReceiver;
}

export interface HeartbeatReceiverResult {
  status: "receiver_heartbeat" | "receiver_replaced";
  updated: boolean;
}

export interface UnregisterReceiverResult {
  status: "receiver_unregistered" | "receiver_replaced";
  removed: boolean;
}

export interface RegisterStandbyInput {
  agent_id: AgentId;
  room_id: string;
  transport: StandbyTransport;
  workspace_id?: string | null;
  surface_id?: string | null;
  process_metadata?: ProcessMetadata;
}

export interface RegisterStandbyResult {
  status: "standby_registered";
  room_id: string;
  agent_id: AgentId;
  wait_intent: "parked";
  transport: StandbyTransport;
  generation: number;
  can_self_wake: boolean;
  // How this session will be woken, in delivery order; no addresses or secrets.
  wake_transports: NativeWakeTransportName[];
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
      reason?: "auto_claim_disabled" | "lost_turn" | "solo_room";
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
  no_active_waiters: boolean;
  parked_hinted: AgentId[];
}

export interface PassStickInput extends OwnerMutationInput {
  to_agent_id: AgentId;
  handoff: Handoff;
  operator_override?: boolean;
}

export interface PassStickResult {
  status: "passed";
  room_id: string;
  reserved_for: AgentId;
  event_seq: number;
  routed_to_parked: boolean;
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
  lost_members?: LostMember[];
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
  receivers: RoomReceiver[];
  wake_endpoints: NativeWakeEndpointSummary[];
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
  // Several named recipients share one room message instead of one event each.
  // Mutually exclusive with to_agent_id.
  to_agent_ids?: AgentId[];
  delivery_hint?: DeliveryHint;
  /** Stored images (see attachments.ts); the body may be empty when present. */
  attachments?: MessageAttachment[];
  process_metadata?: ProcessMetadata;
}

export interface AskRoomInput {
  agent_id: AgentId;
  room_id: string;
  /** "room" asks every live agent; otherwise agent ids, or display or
   * harness names that each match exactly one agent. */
  to: "room" | string[];
  body: string;
  /** Deduplicates a retry by the same requester. */
  request_key?: string;
}

export interface AskRoomResult extends SendMessageResult {
  request_id: string;
  room_id: string;
  recipients: AgentId[];
  /** True when request_key matched an earlier identical request. */
  deduplicated: boolean;
}

export interface ReplyToRequestInput {
  agent_id: AgentId;
  request_id: string;
  body: string;
  process_metadata?: ProcessMetadata;
}

export interface ReplyToRequestResult {
  request_id: string;
  room_id: string;
  event_seq: number;
  event_id: string;
  created_at: string;
}

export interface RequestRepliesInput {
  request_id: string;
  after_event_seq?: number;
  limit?: number;
}

export interface RequestRecipientStatus {
  agent_id: AgentId;
  /** Still a member of the request's room. */
  in_room: boolean;
  /** The wake attempt that dispatched this request, while still on record;
   * null when a later attempt replaced it. Never proof it was read. */
  delivery: MessageDelivery | null;
  /** When this agent's tt received the request (its wait, or an acknowledged
   * envelope); not proof the model read or acted on it. Null means no receipt
   * is on record: receipts go when a member leaves. */
  received_at: string | null;
  /** Whether this agent has answered with tt msg reply. */
  replied: boolean;
}

export interface RequestRepliesResult {
  request_id: string;
  room_id: string;
  requester_agent_id: AgentId;
  recipients: AgentId[];
  /** Each recipient's delivery, receipt, and reply state, separately. */
  recipient_status: RequestRecipientStatus[];
  request_event_seq: number;
  replies: RoomEvent[];
  /** Pass as after_event_seq to read the next page or later replies. */
  cursor_event_seq: number;
  has_more: boolean;
}

export interface MessageDelivery {
  agent_id: AgentId;
  status: MessageDeliveryStatus;
  transport?: NativeWakeTransportName;
  state?: "woken" | "queued" | "steered" | "ambiguous" | "failed";
  error?: string;
  /** Where delivery failed and why, e.g. "connect:EPERM" or "exit:1 rpc:-32603". */
  error_detail?: string;
  interrupt_status?: "injected" | "unsupported";
}

export type MessageDeliveryStatus =
  | "receiver"
  | "endpoint"
  | "pending"
  | "unreachable";

export interface MessageReceipt {
  event_seq: number;
  agent_id: AgentId;
  delivered_at: string;
}

export interface SendMessageResult {
  event_seq: number;
  event_id: string;
  created_at: string;
  delivery_status?: MessageDeliveryStatus;
  delivery_target?: AgentId;
  delivery_error?: string;
  delivery_error_detail?: string;
  delivery_transport?: NativeWakeTransportName;
  delivery_state?: "woken" | "queued" | "steered" | "ambiguous" | "failed";
  interrupt_status?: "injected" | "unsupported";
  // Every agent this message was routed to, in send order. A single directed
  // message also fills the delivery_* fields above for existing callers.
  deliveries?: MessageDelivery[];
  held?: HeldRecipient[];
}

export interface RegisterNativeWakeEndpointInput {
  agent_id: AgentId;
  room_id: string;
  transport: NativeWakeTransportName;
  address: string;
  secret: string | null;
  harness_session_id: string;
  host_id: string;
}

export interface RegisterNativeWakeEndpointResult {
  status: "native_wake_endpoint_registered";
  transport: NativeWakeTransportName;
  generation: number;
}

// Public view of a native wake endpoint: never carries the address or secret.
export interface NativeWakeEndpointSummary {
  agent_id: AgentId;
  transport: NativeWakeTransportName;
  recorded_at: string;
  last_attempt_at: string | null;
  last_status: NativeWakeState | "failed" | null;
  last_error: string | null;
  /** Where the last attempt failed and the system's code, e.g. "connect:EPERM". */
  last_error_detail: string | null;
}

export interface RegisterWakeEndpointInput {
  agent_id: AgentId;
  room_id: string;
  workspace_id: string;
  surface_id: string;
  harness_session_id: string;
}

export interface RegisterWakeEndpointResult {
  status: "wake_endpoint_registered";
  generation: number;
}

export interface InspectStopGuardInput {
  context_path: string;
  harness_session_id: string;
}

export type StopGuardInspection =
  | {
      blocked: false;
      reason: "no_room" | "room_closed" | "not_a_member" | "no_live_grant";
    }
  | {
      blocked: true;
      reason: "owner" | "reservation";
      agent_id: AgentId;
      room_id: string;
      canonical_path: string;
      turn_id: number;
      expires_at: string;
    };

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
  /** Ends the long-poll early with no events, e.g. when a watcher is stopped. */
  signal?: AbortSignal;
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

export interface RoomActivity {
  room_id: string;
  /** Time of the room's newest event, or null for a room without events. */
  last_event_at: string | null;
  /** The newest event that carried a handoff (release, pass, or assign). */
  last_handoff: {
    event_seq: number;
    event_type: EventType;
    from_agent_id: AgentId | null;
    to_agent_id: AgentId | null;
    created_at: string;
    handoff: Handoff;
  } | null;
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
