import os from "node:os";
import type { TalkingStickService } from "../service.js";
import { readCliSessions, resolveCliSessionPath } from "../session-store.js";
import type { Harness } from "./adapter.js";

// What the supervisor asks of the room. It never writes presence or model
// activity; the only membership it touches is an authorized recovery join for
// a worker it owns.

export interface RoomBridge {
  /** fenceManagedDelivery for one batch, proven by this generation's endpoint and token. */
  fence(input: { endpoint_address: string; delivery_secret: string; batch_token: string;
    transition: "writing" | "written" | "unsent" }): void;
  /**
   * Recovers the lost memberships of one owned worker's exact process with its
   * own recovery credential, and registers its supervisor endpoint. Returns
   * what it recovered and why anything was refused.
   */
  recover(input: { harness: Harness; session_id: string; pid: number; process_started_at: string;
    endpoint_address: string; delivery_secret: string }): { recovered: string[]; refused: Array<{ agent_id: string; error: string }> };
}

export function createRoomBridge(service: TalkingStickService, options: { dataDir?: string; hostId?: string } = {}): RoomBridge {
  const hostId = options.hostId ?? os.hostname();
  return {
    fence: (input) => { service.fenceManagedBatch(input); },
    recover(input) {
      const harnessSessionId = `harness:${input.session_id}`;
      const recovered: string[] = [];
      const refused: Array<{ agent_id: string; error: string }> = [];
      const credentials = new Map(readCliSessions(resolveCliSessionPath(options.dataDir ? { dataDir: options.dataDir } : {}))
        .filter((session) => session.recovery_credential)
        .map((session) => [`${session.agent_id}\u0000${session.room_id}`, session.recovery_credential!]));
      for (const lost of service.findLostMembersForProcess({ harness_name: input.harness, harness_session_id: harnessSessionId,
        pid: input.pid, process_started_at: input.process_started_at })) {
        const credential = credentials.get(`${lost.agent_id}\u0000${lost.room_id}`);
        try {
          service.joinPath({ agent_id: lost.agent_id, context_path: lost.canonical_path, room_id: lost.room_id, recover: true,
            ...(credential ? { recovery_credentials: { [lost.room_id]: credential } } : {}),
            process_metadata: { host_id: hostId, pid: input.pid, process_started_at: input.process_started_at,
              session_kind: "harness_cli", display_name: input.harness, harness_name: input.harness,
              harness_session_id: harnessSessionId, harness_host_id: hostId, harness_pid: input.pid,
              harness_process_started_at: input.process_started_at } });
          service.registerNativeWakeEndpoint({ agent_id: lost.agent_id, room_id: lost.room_id, transport: "supervisor",
            address: input.endpoint_address, secret: input.delivery_secret, harness_session_id: harnessSessionId, host_id: hostId });
          recovered.push(lost.agent_id);
        } catch (error) {
          refused.push({ agent_id: lost.agent_id, error: (error as { code?: string }).code ?? String(error) });
        }
      }
      return { recovered, refused };
    }
  };
}
