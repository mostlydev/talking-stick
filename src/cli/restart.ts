import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../config.js";
import { resolveDatabasePath } from "../db.js";
import { resolveContextPath, roomCandidatePaths } from "../path-resolution.js";
import { TalkingStickService } from "../service.js";
import { findCliSessionByRoom, resolveCliSessionPath } from "../session-store.js";
import { openSqlite } from "../sqlite.js";
import { adoptionWorkerId } from "../supervisor/adoption.js";
import type { WorkerPermissions, WorkerSpec } from "../supervisor/adapter.js";
import { readSupervisorOwnerLock } from "../supervisor/daemon.js";
import { preflightWorkerExecutable } from "../supervisor/executable.js";
import { inspectSupervisorState } from "../supervisor/root.js";
import { supervisorPaths, systemProcessLiveness } from "../supervisor/run.js";
import { SupervisorStore } from "../supervisor/state.js";
import type { PathRoom } from "../types.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, type ParsedCommand } from "./parser.js";
import { resolveRoomSelector, roomSelectorFrom } from "./room-selector.js";

export const RESTART_USAGE = "tt restart <agent-id> --headless [--in ROOM] [--print] [--restricted | --permission-mode bypassPermissions]";
const OPTIONS = new Set(["headless", "in", "print", "restricted", "permission-mode", "json", "text"]);

export function handleRestartCommand(parsed: ParsedCommand): void {
  const [agentId] = parsed.positionals;
  if (!agentId || parsed.positionals.length !== 1 || !hasOption(parsed, "headless")) throw new Error(RESTART_USAGE);
  for (const flag of parsed.options.keys()) if (!OPTIONS.has(flag)) throw new Error(`Unknown restart flag --${flag}.`);
  if (hasOption(parsed, "in") && !getStringOption(parsed, "in")) throw new Error("--in needs a room.");
  const mode = getStringOption(parsed, "permission-mode");
  if (hasOption(parsed, "permission-mode") && (mode !== "bypassPermissions" || hasOption(parsed, "restricted"))) {
    throw new Error("Use --restricted or --permission-mode bypassPermissions.");
  }

  const preview = hasOption(parsed, "print");
  const dataDir = resolveDataDir();
  const roomDb = resolveDatabasePath({ dataDir });
  if (!fs.existsSync(roomDb)) throw new Error("No rooms database.");
  const db = preview ? openSqlite(roomDb, { readonly: true, timeout: 100 }) : undefined;
  const service = new TalkingStickService({ dataDir, db });
  try {
    if (db && !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'headless_adoptions'").get()) {
      throw new Error("The room database needs the new supervisor before adoption can be previewed.");
    }
    const rooms = service.db.prepare<[], PathRoom>("SELECT * FROM path_rooms WHERE state != 'closed'").all();
    const selector = roomSelectorFrom(parsed);
    const room = selector ? resolveRoomSelector(rooms, selector) :
      roomCandidatePaths(resolveContextPath(process.cwd())).map(candidate => rooms.find(room => room.canonical_path === candidate)).find(Boolean);
    if (!room) throw new Error("No open room for this directory. Use --in to select one.");
    const cached = findCliSessionByRoom(resolveCliSessionPath({ dataDir }), agentId, room.room_id);
    if (!cached?.recovery_credential) throw new Error("No local recovery credential for that exact agent ID in this room.");
    const cwd = cached.context_path;
    if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("The original join directory is unknown or unavailable. Run rooms join again in the interactive session before exiting.");
    }
    const workerId = adoptionWorkerId(room.room_id, agentId);
    const source = service.previewHeadlessAdoption(room.room_id, agentId, workerId, cached.recovery_credential);
    const { harness } = source.handoff;
    const unrestricted = mode === "bypassPermissions";
    const permissions: WorkerPermissions = harness === "codex" ?
      { harness, sandbox: unrestricted ? "danger-full-access" : "read-only", approval: unrestricted ? "never" : "on-request" } :
      harness === "claude" ? { harness, mode: unrestricted ? "bypassPermissions" : "plan" } :
        { harness, mode: unrestricted ? "bypassPermissions" : "default" };
    const searchPath = process.env.PATH;
    const executableKey = harness === "antigravity" ? "AGY_EXECUTABLE" : harness === "codex" ? "CODEX_EXECUTABLE" : "CLAUDE_EXECUTABLE";
    const executable = process.env[executableKey];
    const profile = cached.harness_profile;
    const spec: WorkerSpec = { worker_id: workerId, cwd, harness, permissions,
      adoption: { room_id: room.room_id, room_path: room.canonical_path, agent_id: agentId },
      env: [
        ...(profile ? [{ name: "HOME", from: "literal" as const, value: profile.home }] : []),
        ...(profile?.codex_home ? [{ name: "CODEX_HOME", from: "literal" as const, value: profile.codex_home }] : []),
        ...(profile?.claude_config_dir ? [{ name: "CLAUDE_CONFIG_DIR", from: "literal" as const, value: profile.claude_config_dir }] : []),
        ...(searchPath ? [{ name: "PATH", from: "literal" as const, value: searchPath }] : []),
        ...(executable ? [{ name: executableKey, from: "literal" as const, value: executable }] : [])
      ] };
    const { root } = inspectSupervisorState(dataDir);
    const paths = supervisorPaths(root.dir);
    const owner = readSupervisorOwnerLock(paths.lock);
    const supported = typeof owner === "object" && owner.headless_adoption &&
      systemProcessLiveness()(owner.pid, owner.process_started_at) === "alive";
    if (!preview) {
      if (!supported) throw new Error("Start or restart a supervisor that supports interactive adoption first.");
      preflightWorkerExecutable(spec);
      const store = new SupervisorStore(paths.database);
      try {
        const existing = store.worker(workerId);
        const assertSameWorker = (saved: typeof spec) => {
          if (saved.adoption?.room_id !== room.room_id || saved.adoption.agent_id !== agentId ||
              saved.cwd !== spec.cwd || JSON.stringify(saved.permissions) !== JSON.stringify(spec.permissions)) {
            throw new Error(`Worker ${workerId} already exists with a different handoff or permissions.`);
          }
        };
        if (existing) assertSameWorker(JSON.parse(existing.spec_json) as WorkerSpec);
        if (existing && ((existing.hold_reason && existing.hold_reason !== "adoption_pending") || existing.desired !== "running")) {
          throw new Error(`Remove the stopped or held worker ${workerId} before requesting adoption again.`);
        }
        service.beginHeadlessAdoption(room.room_id, agentId, workerId, cached.recovery_credential);
        if (!existing) {
          try {
            store.addWorker(spec, deriveCliIdentity(parsed).agent_id, new Date().toISOString());
          } catch (error) {
            const concurrent = store.worker(workerId);
            if (!concurrent) { service.abortHeadlessAdoption(workerId); throw error; }
            assertSameWorker(JSON.parse(concurrent.spec_json) as WorkerSpec);
          }
        }
      } finally {
        store.close();
      }
    }
    const status = preview ? "preview" : source.process === "alive" ? "awaiting_exit" : "queued";
    printResult(parsed, { status, room_id: room.room_id, agent_id: agentId, cwd, harness, worker_id: workerId,
      permissions, old_process: source.process, supervisor_ready: Boolean(supported), uncertain_deliveries: source.uncertain_deliveries },
      () => [
        `${preview ? "Would move" : "Moving"} ${agentId} to headless as ${workerId} in ${cwd} (${unrestricted ? "bypass permissions" : "restricted"}).`,
        source.process === "alive" ? "Exit the interactive harness normally to continue. Leave the room membership in place." : "The old process is gone.",
        ...(!supported ? ["Start or restart the supervisor before adopting."] : []),
        ...(source.uncertain_deliveries ? [`${source.uncertain_deliveries} uncertain deliveries will be held for review.`] : [])
      ].join("\n"));
  } finally {
    if (db) db.close();
    else service.close();
  }
}
