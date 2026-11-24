import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveDataDir } from "../config.js";
import { createSystemHerdrRunner, listHerdrAgents, readPaneProcesses, runHerdrJson, type HerdrRunner } from "../herdr.js";
import { proveMemberInPane, proveOpencodeV2MemberInPane } from "../launch-identity.js";
import { readLaunchRecord } from "../launch-record.js";
import { openPaneSession } from "../pane-backend.js";
import { createSystemProcessInspector, terminateKnownProcess, type ProcessInspector } from "../process-utils.js";
import { deliveryTokenHash } from "../supervisor/membership-gc.js";
import { inspectSupervisorState } from "../supervisor/root.js";
import { supervisorPaths } from "../supervisor/run.js";
import { openSqlite } from "../sqlite.js";
import { SupervisorStore, type GenerationRow, type WorkerRow } from "../supervisor/state.js";
import { HUMAN_CHAT_SESSION_KIND, type KickMemberProof, type RoomMember } from "../types.js";
import type { DerivedIdentity } from "../identity.js";
import { codexControlSocket, interruptCodexThread } from "./codex-interrupt.js";
import type { Runtime } from "./runtime.js";

type Method = "supervisor" | "pane" | "session" | "process" | "shared_process" | "none";
export interface KickStopPlan {
  method: Method;
  target: string;
  description: string;
  affected_members: string[];
  confirmation: string;
  /** Use this token only when deliberately stopping the entire shared process. */
  shared_confirmation?: string;
  shared_pid?: number;
}

interface ProcessRef { host: string; pid: number; process_started_at: string }

interface StopAction {
  plan: KickStopPlan;
  proof: KickMemberProof;
  stop(): Promise<string>;
}

function proof(member: RoomMember): KickMemberProof {
  return { joined_at: member.joined_at, harness_session_id: member.harness_session_id,
    harness_host_id: member.harness_host_id, harness_pid: member.harness_pid,
    harness_process_started_at: member.harness_process_started_at, host_id: member.host_id,
    pid: member.pid, process_started_at: member.process_started_at };
}

function exactProcess(member: RoomMember): ProcessRef | null {
  const harness = member.harness_name !== null;
  const pid = harness ? member.harness_pid : member.pid;
  const host = harness ? member.harness_host_id : member.host_id;
  const start = (harness ? member.harness_process_started_at : member.process_started_at)?.trim();
  return host === os.hostname() && pid && pid > 1 && start ? { host, pid, process_started_at: start } : null;
}

function isOwnProcess(pid: number, inspector: ProcessInspector): boolean {
  if (pid === process.pid || pid === process.ppid) return true;
  let current: number | null | undefined = process.ppid;
  const seen = new Set<number>();
  while (current && current > 1 && !seen.has(current)) {
    if (pid === current) return true;
    seen.add(current);
    current = inspector.inspect(current)?.ppid;
  }
  return false;
}

async function observeSignal(ref: ProcessRef, inspector: ProcessInspector, description: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  do {
    const current = inspector.inspect(ref.pid);
    if (current === null || (current?.startTime && current.startTime.trim() !== ref.process_started_at))
      return `${description} The selected process exited.`;
    await sleep(50);
  } while (Date.now() < deadline);
  return `${description} Exit is unconfirmed.`;
}

function runLocal(file: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(file, args, { env, encoding: "utf8", timeout: 2_000, maxBuffer: 32_768, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function ownsSocket(pid: number, args: string[], name?: string): boolean {
  try {
    const files = runLocal("lsof", ["-a", "-p", String(pid), "-Fn", ...args]);
    return name ? files.split("\n").includes(`n${name}`) : files.split("\n").some(line => line.startsWith("n"));
  } catch { return false; }
}

function openCodeService(pid: number): { url: string; port: string; password: string } | null {
  const stateHome = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  try {
    const fd = fs.openSync(path.join(stateHome, "opencode", "service.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) return null;
      const entry = JSON.parse(fs.readFileSync(fd, "utf8")) as { url?: string; pid?: number; password?: string };
      const port = typeof entry.url === "string" ? /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(entry.url)?.[1] : undefined;
      return port && entry.url && entry.pid === pid && typeof entry.password === "string" && entry.password
        ? { url: entry.url, port, password: entry.password } : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function prepareSessionStop(member: RoomMember, ref: ProcessRef, command: string): (() => Promise<string>) | null {
  const session = member.harness_session_id?.match(/^harness:(.+)$/)?.[1];
  if (!session) return null;
  if (member.harness_name === "codex" && /\bapp-server\b/.test(command) &&
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(session)) {
    const socket = codexControlSocket();
    if (!ownsSocket(ref.pid, ["-U"], socket)) return null;
    return async () => {
      if (!ownsSocket(ref.pid, ["-U"], socket)) return "Codex control socket no longer belongs to the selected process.";
      const result = await interruptCodexThread(session, socket);
      if (result === "sent") return "Codex confirmed the selected turn was interrupted.";
      if (result === "idle") return "The selected Codex thread had no active turn.";
      return "Codex did not confirm cancellation of the selected turn.";
    };
  }
  if (member.harness_name !== "opencode" || !/\bserve\s+--service\b/.test(command) || !/^ses_[a-zA-Z0-9]+$/.test(session)) return null;
  const executable = command.trim().split(/\s+/, 1)[0];
  if (!executable.startsWith("/") || !executable.endsWith("/opencode")) return null;
  const service = openCodeService(ref.pid);
  if (!service || !ownsSocket(ref.pid, ["-nP", `-iTCP:${service.port}`, "-sTCP:LISTEN"])) return null;
  return async () => {
    const current = openCodeService(ref.pid);
    if (!current || current.url !== service.url || !ownsSocket(ref.pid, ["-nP", `-iTCP:${current.port}`, "-sTCP:LISTEN"]))
      return "OpenCode server no longer owns the selected port.";
    // The service credential stays in the native client's environment. No
    // endpoint discovery or credential fallback can start another server.
    const reply = JSON.parse(runLocal(executable, ["api", "--server", current.url, "POST",
      `/api/session/${session}/interrupt`, "--data", "{}"], { HOME: process.env.HOME, PATH: process.env.PATH,
        NO_PROXY: "127.0.0.1", OPENCODE_PASSWORD: current.password })) as { interrupted?: boolean };
    return reply.interrupted === true ? "OpenCode confirmed the selected session was interrupted."
      : reply.interrupted === false ? "The selected OpenCode session had no active execution." : "OpenCode did not confirm cancellation.";
  };
}

function prepareOwnedPane(member: RoomMember, roomPath: string, dataDir: string, inspector: ProcessInspector,
  otherMemberOnPid: (pid: number) => boolean):
  { pane: string; runner: HerdrRunner; verify(): boolean; backend: string } | null {
  try {
    const record = readLaunchRecord(dataDir, roomPath);
    const entry = Object.values(record?.agents ?? {}).find(candidate => candidate.member_id === member.agent_id &&
      candidate.state === "confirmed" && candidate.pane_id);
    if (!entry?.pane_id || !member.harness_name || record?.chat_pane_id === entry.pane_id) return null;
    const pane = entry.pane_id;
    const backend = /^%\d+$/.test(pane) ? "tmux" : "herdr";
    const current = openPaneSession(process.env, { readMembers: () => [member] });
    if (backend === "tmux" && current.backend !== "tmux") return null;
    const runner = backend === "tmux" ? current.runner : createSystemHerdrRunner();
    const deps = { runner, inspector, readStartTime: (pid: number) => inspector.inspect(pid)?.startTime ?? null };
    const verify = () => {
      const proved = entry.opencode_session_id
        ? proveOpencodeV2MemberInPane(member, pane, entry.opencode_session_id, deps).confirmed
        : listHerdrAgents(runner).some(agent => agent.pane_id === pane &&
          proveMemberInPane(member, agent, member.harness_name === "antigravity" ? "agy" : member.harness_name!, deps).confirmed);
      return proved && !readPaneProcesses(runner, pane).some(({ pid }) => otherMemberOnPid(pid));
    };
    return verify() ? { pane, runner, verify, backend } : null;
  } catch { return null; }
}

function prepareKickStop(runtime: Runtime, roomId: string, agentId: string, actor: string,
  inspector = createSystemProcessInspector({ cacheTtlMs: 0 })): StopAction {
  const evidence = runtime.commands.kickTarget(roomId, agentId);
  const member = evidence.member;
  if (!member) throw new Error("That member has left the room.");
  if (member.session_kind === HUMAN_CHAT_SESSION_KIND || agentId === actor) throw new Error("Choose another room member.");
  const ref = exactProcess(member);
  const dataDir = resolveDataDir();
  const peers = () => ref ? runtime.commands.kickProcessPeers(ref.host, ref.pid, ref.process_started_at, roomId, agentId) : [];
  const affected = peers();
  const live = () => ref && inspector.inspect(ref.pid)?.startTime?.trim() === ref.process_started_at &&
    !isOwnProcess(ref.pid, inspector);
  const inspect = ref ? inspector.inspect(ref.pid) : null;
  const sharedHost = Boolean(affected.length || /\b(?:app-server|serve)\b/.test(inspect?.command ?? ""));
  const confirmations = (method: Method, description: string, group: string[]) => createHash("sha256")
    .update(JSON.stringify([roomId, agentId, proof(member), method, description, group])).digest("hex").slice(0, 16);
  const action = (method: Method, description: string, stop: () => Promise<string>, shared = false): StopAction => ({
    proof: proof(member),
    plan: { method, target: agentId, description, affected_members: affected,
      confirmation: confirmations(method, description, affected),
      ...(shared && ref ? { shared_confirmation: confirmations("shared_process", `pid ${ref.pid}`, affected), shared_pid: ref.pid } : {}) },
    stop
  });
  const blocked = (reason: string, shared = false) => action("none", reason, async () => reason, shared);
  if (!ref || !live()) return blocked("No matching local process can be safely stopped.");

  const state = inspectSupervisorState(dataDir);
  const paths = supervisorPaths(state.root.dir);
  if (evidence.managed) {
    const endpoint = evidence.managed;
    const match = /#([a-z0-9][a-z0-9._-]*)@(\d+)$/.exec(endpoint.address);
    if (!endpoint.secret || !match || endpoint.address !== `${paths.socket}${match[0]}` || state.kind !== "ready")
      return blocked("The recorded supervisor generation could not be verified.");
    const [, workerId, generation] = match;
    const generationNumber = Number(generation);
    const latest = () => {
      const db = openSqlite(paths.database, { readonly: true, timeout: 1_000 });
      try {
        const w = db.prepare<[string], WorkerRow>("SELECT * FROM workers WHERE worker_id = ?").get(workerId);
        const g = db.prepare<[string], GenerationRow>(
          "SELECT * FROM generations WHERE worker_id = ? ORDER BY generation DESC LIMIT 1").get(workerId);
        if (!w || !g || g.ended_at || g.generation !== generationNumber || g.pid !== ref.pid ||
            g.process_started_at?.trim() !== ref.process_started_at ||
            member.harness_session_id !== `harness:${g.session_id}` ||
            g.delivery_token_hash !== deliveryTokenHash(endpoint.secret!)) return null;
        return { worker_id: workerId, generation: generationNumber, pid: ref.pid,
          process_started_at: ref.process_started_at, desired_version: w.desired_version };
      } finally { db.close(); }
    };
    let expected: ReturnType<typeof latest>;
    try { expected = latest(); } catch { return blocked("The recorded supervisor generation could not be read."); }
    if (!expected || affected.length) return blocked(affected.length
      ? `The supervisor process also hosts ${affected.join(", ")}.` : "The supervisor generation changed.");
    return action("supervisor", `Stop supervisor worker ${workerId}#${generationNumber} (PID ${ref.pid})`, async () => {
      const queued = runtime.commands.withKickProcessPeers(ref.host, ref.pid, ref.process_started_at, roomId, agentId, current => {
        if (current.length || !live()) return false;
        const store = new SupervisorStore(paths.database);
        try {
          return store.requestGenerationStop(expected, actor, new Date().toISOString(),
            { reason: "kicked", room_id: roomId, agent_id: agentId });
        } finally { store.close(); }
      });
      return queued ? `Supervisor stop queued for ${workerId}#${generationNumber}.`
        : `Supervisor stop was not queued for ${workerId}#${generationNumber}; its status or process ownership changed.`;
    });
  }

  if (state.kind === "ready") {
    const db = openSqlite(paths.database, { readonly: true, timeout: 1_000 });
    try {
      if (db.prepare(`SELECT 1 FROM generations WHERE ended_at IS NULL
        AND pid = ? AND trim(process_started_at) = ? LIMIT 1`).get(ref.pid, ref.process_started_at))
        return blocked("This process belongs to the supervisor, but its room endpoint is missing.");
    } finally { db.close(); }
  }

  if (!sharedHost || (member.harness_name === "opencode" && /\bserve\s+--stdio\b/.test(inspect?.command ?? "") && !affected.length)) {
    const recorded = prepareOwnedPane(member, evidence.canonical_path, dataDir, inspector, pid => {
      const startedAt = inspector.inspect(pid)?.startTime?.trim();
      return Boolean(startedAt && runtime.commands.kickProcessPeers(ref.host, pid, startedAt, roomId, agentId).length);
    });
    if (recorded) return action("pane", `Close verified ${recorded.backend} pane ${recorded.pane} (PID ${ref.pid})`, async () => {
      if (!live() || peers().length || !recorded.verify()) return "The pane no longer matches the selected process.";
      runHerdrJson(recorded.runner, ["pane", "close", recorded.pane]);
      return `Close requested for ${recorded.backend} pane ${recorded.pane}.`;
    });
  }
  if (sharedHost) {
    const scope = prepareSessionStop(member, ref, inspect?.command ?? "");
    if (scope) return action("session", `Stop active work in ${member.harness_name} session ${member.harness_session_id!.slice(8)}`,
      async () => live() ? scope() : "The selected session's host process changed.", affected.length > 0);
    return blocked(affected.length ? `The process also hosts ${affected.join(", ")}; no verified session stop is available.`
      : "A shared harness host is running; no verified session stop is available.", affected.length > 0);
  }
  return action("process", `Send SIGTERM to verified PID ${ref.pid}`, async () => {
    const sent = runtime.commands.withKickProcessPeers(ref.host, ref.pid, ref.process_started_at, roomId, agentId, current =>
      !current.length && live() && terminateKnownProcess(ref, { inspector }));
    return sent ? observeSignal(ref, inspector, `SIGTERM sent to PID ${ref.pid}.`)
      : "The process changed or is shared; no signal sent.";
  });
}

export function previewKickStop(runtime: Runtime, roomId: string, target: string, actor: string): KickStopPlan {
  return prepareKickStop(runtime, roomId, target, actor).plan;
}

export async function kickAndStop(runtime: Runtime, identity: DerivedIdentity, input: {
  room_id: string; target_agent_id: string; reason?: string; confirmed?: string; sharedConfirmation?: string;
}) {
  const inspector = createSystemProcessInspector({ cacheTtlMs: 0 });
  const action = prepareKickStop(runtime, input.room_id, input.target_agent_id, identity.agent_id, inspector);
  if (input.confirmed && input.confirmed !== action.plan.confirmation) throw new Error("The stop target changed. Preview it again.");
  const shared = input.sharedConfirmation;
  if (shared && shared !== action.plan.shared_confirmation) throw new Error("The shared-process confirmation is stale. Run tt kick --stop --print again.");
  const result = runtime.commands.kickMember(identity, { ...input, force: true, stop_target: action.proof });
  let description: string;
  try {
    if (shared) {
      const p = action.proof;
      const pid = p.harness_pid ?? p.pid;
      const process_started_at = p.harness_process_started_at ?? p.process_started_at;
      const host = p.harness_host_id ?? p.host_id;
      const expected = action.plan.affected_members;
      const ref = pid && process_started_at && host ? { host, pid, process_started_at: process_started_at.trim() } : null;
      const sent = ref && runtime.commands.withKickProcessPeers(ref.host, ref.pid, ref.process_started_at,
        input.room_id, input.target_agent_id, current => JSON.stringify(current) === JSON.stringify(expected) &&
          !isOwnProcess(ref.pid, inspector) && terminateKnownProcess(ref, { inspector }));
      description = ref && sent ? await observeSignal(ref, inspector,
        `SIGTERM sent to shared PID ${pid}, affecting ${expected.join(", ")}.`)
        : "The affected members or shared process changed; no signal sent.";
    } else description = await action.stop();
  } catch {
    description = "The selected stop control failed; check the process before retrying.";
  }
  runtime.commands.recordKickStop(identity, input.room_id, input.target_agent_id, description);
  return { ...result, stop: { ...action.plan, method: shared ? "shared_process" as const : action.plan.method, result: description } };
}
