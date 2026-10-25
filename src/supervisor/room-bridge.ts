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
  /**
   * Records that this exact process started the session, as its supervisor
   * observed through the harness protocol. A headless worker loads no user
   * hooks, so this is the evidence a resumed process needs to recover.
   */
  sessionStarted(input: { harness: Harness; session_id: string; pid: number; process_started_at: string }): void;
  lostSessions(input: { harness: Harness; session_id: string }): Array<{ room_id: string; agent_id: string }>;
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
      const metadata = { host_id: hostId, pid: input.pid, process_started_at: input.process_started_at,
        session_kind: "harness_cli" as const, display_name: input.harness, harness_name: input.harness,
        harness_session_id: harnessSessionId, harness_host_id: hostId, harness_pid: input.pid,
        harness_process_started_at: input.process_started_at };
      const attempt = (agentId: string, act: () => void) => {
        try {
          act();
          recovered.push(agentId);
        } catch (error) {
          refused.push({ agent_id: agentId, error: (error as { code?: string }).code ?? String(error) });
        }
      };
      // A membership still bound to an earlier generation of this session, or
      // missing its endpoint, is re-bound atomically by the room.
      for (const member of service.findMembersForSession({ harness_name: input.harness, harness_session_id: harnessSessionId })) {
        if (member.harness_pid === input.pid && member.harness_process_started_at === input.process_started_at.trim()) {
          const endpoint = service.db.prepare("SELECT address FROM member_wake_endpoints WHERE room_id = ? AND agent_id = ? AND transport = 'supervisor'")
            .get(member.room_id, member.agent_id) as { address: string } | undefined;
          if (endpoint?.address === input.endpoint_address) continue;
        }
        const credential = credentials.get(`${member.agent_id}\u0000${member.room_id}`);
        attempt(member.agent_id, () => {
          if (!credential || member.harness_pid === null || member.harness_process_started_at === null) {
            throw Object.assign(new Error("credential_required"), { code: "credential_required" });
          }
          service.rebindSupervisedMember({ room_id: member.room_id, agent_id: member.agent_id, harness_session_id: harnessSessionId,
            credential, prior_pid: member.harness_pid, prior_process_started_at: member.harness_process_started_at,
            process_metadata: metadata, endpoint_address: input.endpoint_address, delivery_secret: input.delivery_secret });
        });
      }
      // The room checks the evidence: this exact process, or a new one with the
      // credential and its own session start.
      for (const lost of service.findLostMembersForSession({ harness_name: input.harness, harness_session_id: harnessSessionId })) {
        const credential = credentials.get(`${lost.agent_id}\u0000${lost.room_id}`);
        attempt(lost.agent_id, () => {
          service.joinPath({ agent_id: lost.agent_id, context_path: lost.canonical_path, room_id: lost.room_id, recover: true,
            ...(credential ? { recovery_credentials: { [lost.room_id]: credential } } : {}), process_metadata: metadata });
          service.registerNativeWakeEndpoint({ agent_id: lost.agent_id, room_id: lost.room_id, transport: "supervisor",
            address: input.endpoint_address, secret: input.delivery_secret, harness_session_id: harnessSessionId, host_id: hostId });
        });
      }
      return { recovered, refused };
    },
    sessionStarted(input) {
      service.recordSessionLifecycle({ harness: input.harness, sessionId: input.session_id, pid: input.pid,
        processStartedAt: input.process_started_at, event: "SessionStart", hookSource: "supervisor" });
    },
    lostSessions(input) {
      return service.findLostMembersForSession({ harness_name: input.harness, harness_session_id: `harness:${input.session_id}` });
    }
  };
}
