import type { RoomEvent } from "./types.js";

/** Console sessions share explicit acknowledgements for the same local human. */
export function humanAttentionIdentity(id: string): string {
  return id.replace(/:chat:[a-f0-9]{8}$/i, "");
}

export function isHumanDirected(event: RoomEvent, viewer?: string): boolean {
  if (event.event_type !== "message_sent") return false;
  const payload = event.payload as { recipients?: unknown; sent_to?: unknown } | null;
  const listed = payload?.recipients;
  const targets = event.to_agent_id ? [event.to_agent_id] : Array.isArray(listed) ? listed : [];
  return targets.some(target => typeof target === "string" && target.startsWith("human:") &&
    (!viewer || humanAttentionIdentity(target) === humanAttentionIdentity(viewer)));
}


export function isHumanAttentionMessage(event: RoomEvent, viewer: string): boolean {
  return isHumanDirected(event, viewer) &&
    humanAttentionIdentity(event.from_agent_id ?? "") !== humanAttentionIdentity(viewer);
}

/**
 * The SQL condition (over `room_events e`) for messages addressed to this
 * human in this room that no console of theirs has acknowledged. Shared by
 * chat's pins and `rooms prompt`, so both count the same messages.
 */
export function humanAttentionWhere(roomId: string, humanId: string, clearedThroughEventSeq: number): { where: string; values: unknown[] } {
  const human = humanAttentionIdentity(humanId);
  if (!human.startsWith("human:")) throw new Error("Human attention requires a human identity.");
  // Recipient filtering precedes LIMIT; ordinary delivery receipts never dismiss a pin.
  const stable = (column: string) => `(CASE WHEN substr(${column}, -14, 6) = ':chat:'
    AND length(substr(${column}, -8)) = 8 AND substr(${column}, -8) NOT GLOB '*[^a-fA-F0-9]*'
    THEN substr(${column}, 1, length(${column}) - 14) ELSE ${column} END)`;
  const where = `e.room_id = ? AND e.event_type = 'message_sent'
    AND e.event_seq > (SELECT event_seq FROM human_attention_start WHERE id = 1)
    AND e.event_seq > ?
    AND COALESCE(${stable("e.from_agent_id")}, '') != ?
    AND (${stable("e.to_agent_id")} = ?
      OR (e.to_agent_id IS NULL AND EXISTS (SELECT 1 FROM json_each(
        COALESCE(json_extract(e.payload_json, '$.recipients'), '[]')) r
        WHERE ${stable("r.value")} = ?)))
    AND NOT EXISTS (SELECT 1 FROM human_message_acknowledgements a
      WHERE a.room_id = e.room_id AND a.human_id = ? AND a.event_seq = e.event_seq)`;
  return { where, values: [roomId, clearedThroughEventSeq, human, human, human, human] };
}
