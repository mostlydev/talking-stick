import { createHash } from "node:crypto";

export type AdoptableHarness = "claude" | "codex" | "antigravity";

export interface HeadlessAdoption {
  room_id: string;
  agent_id: string;
  harness: AdoptableHarness;
  session_id: string;
  host_id: string;
  pid: number;
  started_at: string;
  worker_id: string;
  state: "pending" | "complete" | "failed";
}

export interface AdoptionSource {
  handoff: HeadlessAdoption;
  process: "alive" | "gone";
  uncertain_deliveries: number;
}

export function adoptionWorkerId(roomId: string, agentId: string): string {
  return `adopt-${createHash("sha256").update(JSON.stringify([roomId, agentId])).digest("hex").slice(0, 20)}`;
}
