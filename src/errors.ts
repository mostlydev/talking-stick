import type { RoomState } from "./types.js";

export type ProtocolErrorCode =
  | "room_not_found"
  | "unknown_member"
  | "invalid_handoff"
  | "stale_lease"
  | "turn_mismatch"
  | "takeover_not_available"
  | "takeover_ineligible"
  | "invalid_input"
  | "invalid_body"
  | "body_too_large"
  | "room_closed"
  | "invalid_turn_id"
  | "invalid_cursor";

export interface ProtocolErrorDetails {
  field?: string;
  current_owner?: string | null;
  current_turn_id?: number;
  room_state?: RoomState;
  to_agent_id?: string;
  reserved_for?: string | null;
  reason?: string;
  room_id?: string;
  supplied?: number;
  after_note_id?: string;
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
