import os from "node:os";
import { executableName } from "./executable-name.js";
import { readPaneProcesses, type HerdrAgent, type HerdrRunner } from "./herdr.js";
import { isOpencodeStdioServer } from "./identity.js";
import { createSystemProcessInspector, type ProcessInspector } from "./process-utils.js";
import type { RoomMember } from "./types.js";

// Reads a local process start time in the same format members record.
export type StartTimeReader = (pid: number) => string | null;

export interface IdentityDeps {
  platform?: NodeJS.Platform;
  runner: HerdrRunner;
  readStartTime: StartTimeReader;
  inspector?: ProcessInspector;
  hostId?: string;
}

export interface IdentityProof {
  confirmed: boolean;
  reason: string;
  /** The exact session and pane process match, but the member stored no
   * start time of its own, so the process incarnation cannot be compared. */
  unrecordedStart?: true;
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
  if (!pid) {
    return { confirmed: false, reason: `${member.agent_id} has no recorded harness process.` };
  }
  let processes;
  try {
    processes = readPaneProcesses(deps.runner, herdrAgent.pane_id);
  } catch (error) {
    return { confirmed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const harness = processes.find((candidate) =>
    candidate.pid === pid && executableName(candidate.argv0, deps.platform) === executableName(executable, deps.platform)
  );
  if (!harness) {
    return { confirmed: false, reason: `Pane ${herdrAgent.pane_id} is not running ${executable} pid ${pid}.` };
  }
  // Only after the session and pane process match: a member that could not
  // read its own process start still cannot be told from a reused pid.
  const recordedStart = member.harness_process_started_at?.trim();
  if (!recordedStart) {
    return { confirmed: false, unrecordedStart: true, reason: `${member.agent_id} matches the session and ${executable} pid ${pid} in pane ${herdrAgent.pane_id}, but recorded no process start time, so its join cannot be proven. One possible cause is a Windows account that cannot inspect processes, such as Codex's sandbox; see the README note on Windows join confirmation.` };
  }
  if (deps.readStartTime(pid)?.trim() !== recordedStart) {
    return { confirmed: false, reason: `${executable} pid ${pid} is a different process incarnation.` };
  }
  return { confirmed: true, reason: `${member.agent_id} is confirmed in pane ${herdrAgent.pane_id}.` };
}

// V2's TUI and private server are different processes. The same local proof
// works in tmux and Herdr, without treating a pane title or a cwd as identity.
export function proveOpencodeV2MemberInPane(
  member: RoomMember, paneId: string, sessionId: string, deps: IdentityDeps
): IdentityProof {
  if (member.harness_name !== "opencode" || member.harness_session_id !== `${HARNESS_SESSION_PREFIX}${sessionId}`) {
    return { confirmed: false, reason: `${member.agent_id} is not the OpenCode session launched in pane ${paneId}.` };
  }
  if ((member.harness_host_id ?? member.host_id) !== (deps.hostId ?? os.hostname())) {
    return { confirmed: false, reason: `${member.agent_id} is not a local OpenCode member.` };
  }
  const pid = member.harness_pid;
  const started = member.harness_process_started_at?.trim();
  const inspector = deps.inspector ?? createSystemProcessInspector();
  const server = pid ? inspector.inspect(pid) : null;
  if (!server?.ppid || !started || server.startTime?.trim() !== started || !isOpencodeStdioServer(server.command)) {
    return { confirmed: false, reason: `${member.agent_id} has no matching OpenCode private server process.` };
  }
  try {
    const foreground = readPaneProcesses(deps.runner, paneId);
    const client = foreground.find(({ pid: candidate, argv0 }) =>
      candidate === server.ppid && executableName(argv0, deps.platform) === "opencode");
    if (client) return { confirmed: true, reason: `${member.agent_id} is confirmed in pane ${paneId} (OpenCode V2 private server).` };
  } catch (error) {
    return { confirmed: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { confirmed: false, reason: `OpenCode server pid ${pid} does not belong to the foreground client in pane ${paneId}.` };
}

// A parked agent can go quiet long enough to read "inactive" while its
// process is still running, so a verified-alive process counts too.
export function isLiveMember(member: RoomMember, harness: string): boolean {
  return member.harness_name === harness &&
    (member.status === "active" || member.process_liveness === "alive");
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
