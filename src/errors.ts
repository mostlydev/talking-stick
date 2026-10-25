import type { RoomState } from "./types.js";

export type ProtocolErrorCode =
  | "room_not_found"
  | "request_not_found"
  | "request_key_conflict"
  | "no_recipients"
  | "unknown_member"
  | "session_ended"
  | "member_lost"
  | "member_revoked"
  | "operator_only"
  | "observer_cannot_hold_turn"
  | "unknown_target"
  | "target_active"
  | "cannot_kick_self"
  | "invalid_handoff"
  | "stale_lease"
  | "stale_roles"
  | "turn_mismatch"
  | "takeover_not_available"
  | "takeover_ineligible"
  | "invalid_input"
  | "invalid_body"
  | "invalid_attachment"
  | "body_too_large"
  | "message_too_large"
  | "invalid_delivery_hint"
  | "unknown_recipient"
  | "ambiguous_recipient"
  | "agent_id_required"
  | "invalid_event_type_filter"
  | "room_closed"
  | "invalid_turn_id"
  | "invalid_cursor"
  | "invalid_standby_transport"
  | "cmux_endpoint_required"
  | "park_requires_release"
  | "duplicate_listener"
  | "recipient_unreachable"
  | "invalid_wait_mode"
  | "holds_turn_elsewhere";

export interface ProtocolErrorDetails {
  field?: string;
  agent_id?: string;
  current_owner?: string | null;
  current_turn_id?: number;
  room_state?: RoomState;
  to_agent_id?: string;
  request_id?: string;
  reserved_for?: string | null;
  reason?: string;
  room_id?: string;
  supplied?: number;
  after_note_id?: string;
  candidates?: string[];
  receiver_id?: string;
  receiver_pid?: number;
  lost_at?: string;
  hook_reason?: string | null;
  recover_with?: string;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details: ProtocolErrorDetails;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    details: ProtocolErrorDetails = {}
  ) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...this.details
    };
  }
}

export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error.code);
}
