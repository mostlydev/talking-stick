import path from "node:path";
import { readPaneProcesses, type HerdrAgent, type HerdrRunner } from "./herdr.js";
import { createSystemProcessInspector } from "./process-utils.js";
import type { RoomMember } from "./types.js";

// Reads a local process start time in the same format members record.
export type StartTimeReader = (pid: number) => string | null;

export interface IdentityDeps {
  runner: HerdrRunner;
  readStartTime: StartTimeReader;
}

export interface IdentityProof {
  confirmed: boolean;
  reason: string;
}

export const HARNESS_SESSION_PREFIX = "harness:";

export function createSystemStartTimeReader(): StartTimeReader {
  const inspector = createSystemProcessInspector();
  return (pid) => inspector.inspect(pid)?.startTime ?? null;
}

// A member is the agent in a pane only when Herdr's session id, the pane's
// foreground harness process, and that process's start time all agree with
// what the member registered. Provisional pid:/term:/userhost: identities and
// a missing Herdr session never count as proof.
export function proveMemberInPane(
  member: RoomMember,
  herdrAgent: HerdrAgent,
  executable: string,
  deps: IdentityDeps
): IdentityProof {
  const sessionId = member.harness_session_id ?? "";
  if (!sessionId.startsWith(HARNESS_SESSION_PREFIX)) {
    return { confirmed: false, reason: `${member.agent_id} has no verified harness session yet.` };
  }
  if (!herdrAgent.session_id) {
    return { confirmed: false, reason: `Herdr reports no agent session for pane ${herdrAgent.pane_id}.` };
  }
  if (sessionId.slice(HARNESS_SESSION_PREFIX.length) !== herdrAgent.session_id) {
    return { confirmed: false, reason: `Pane ${herdrAgent.pane_id} hosts a different ${executable} session.` };
  }
  const pid = member.harness_pid;
  const recordedStart = member.harness_process_started_at?.trim();
  if (!pid || !recordedStart) {
    return { confirmed: false, reason: `${member.agent_id} has no recorded harness process.` };
  }
  let processes;
  try {
    processes = readPaneProcesses(deps.runner, herdrAgent.pane_id);
  } catch (error) {
    return { confirmed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const harness = processes.find((candidate) =>
    candidate.pid === pid && path.basename(candidate.argv0) === executable
  );
  if (!harness) {
    return { confirmed: false, reason: `Pane ${herdrAgent.pane_id} is not running ${executable} pid ${pid}.` };
  }
  if (deps.readStartTime(pid)?.trim() !== recordedStart) {
    return { confirmed: false, reason: `${executable} pid ${pid} is a different process incarnation.` };
  }
  return { confirmed: true, reason: `${member.agent_id} is confirmed in pane ${herdrAgent.pane_id}.` };
}

export function isLiveMember(member: RoomMember, harness: string): boolean {
  return member.status === "active" && member.harness_name === harness;
}

// False means unproven, including read failure; it never proves the pane gone.
export function proveChatMemberInPane(member: RoomMember, paneId: string, deps: IdentityDeps): boolean {
  if (member.status !== "active" || member.session_kind !== "human_chat" ||
      member.process_liveness !== "alive" || !member.pid || !member.process_started_at?.trim()) return false;
  try {
    return readPaneProcesses(deps.runner, paneId).some((candidate) => candidate.pid === member.pid) &&
      deps.readStartTime(member.pid)?.trim() === member.process_started_at.trim();
  } catch {
    return false;
  }
}

// Correlate by session id first; kind or cwd alone cannot tell two agents apart.
export function findHerdrAgentForMember(
  member: RoomMember,
  herdrAgents: HerdrAgent[]
): HerdrAgent | null {
  const sessionId = member.harness_session_id ?? "";
  if (!sessionId.startsWith(HARNESS_SESSION_PREFIX)) return null;
  const bare = sessionId.slice(HARNESS_SESSION_PREFIX.length);
  return herdrAgents.find((agent) => agent.session_id === bare) ?? null;
}
