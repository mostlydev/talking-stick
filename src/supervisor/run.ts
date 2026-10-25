import fs from "node:fs";
import path from "node:path";
import { TalkingStickService } from "../service.js";
import { createSystemWakeTransport } from "../wake.js";
import { createSystemNativeWakeTransport } from "../native-wake.js";
import { createSystemProcessInspector, getCurrentProcessStartedAt } from "../process-utils.js";
import type { Harness, HarnessAdapter } from "./adapter.js";
import { Supervisor, acquireOwnerLock, type ProcessLivenessReader } from "./daemon.js";
import { startIntakeServer, type ControlAnswer, type ControlMessage } from "./intake.js";
import { createRoomBridge } from "./room-bridge.js";
import { SupervisorStore, supervisorDatabasePath } from "./state.js";

// The supervisor daemon: one per data directory, in the foreground. launchd
// keeps it running when installed; tt supervisor run starts it by hand.

export const TICK_INTERVAL_MS = 30_000;
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

export function supervisorPaths(dataDir: string) {
  const dir = path.join(dataDir, "supervisor");
  return {
    dir,
    database: supervisorDatabasePath(dataDir),
    socket: path.join(dir, "control.sock"),
    lock: path.join(dir, "owner.lock"),
    log: path.join(dir, "logs", "daemon.log")
  };
}

/** Exact-process liveness: the pid runs and started when recorded. */
export function systemProcessLiveness(): ProcessLivenessReader {
  const inspector = createSystemProcessInspector();
  return (pid, startedAt) => {
    const inspection = inspector.inspect(pid);
    if (inspection === null) return "gone";
    if (!inspection?.startTime) return "unknown";
    return inspection.startTime.trim() === startedAt.trim() ? "alive" : "gone";
  };
}

/** Keeps the daemon log under LOG_ROTATE_BYTES, with LOG_KEEP older files. */
export function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size < LOG_ROTATE_BYTES) return;
  } catch {
    return;
  }
  for (let index = LOG_KEEP - 1; index >= 1; index--) {
    try { fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`); } catch { /* absent */ }
  }
  fs.renameSync(file, `${file}.1`);
  fs.writeFileSync(file, "", { mode: 0o600 });
}

export interface RunSupervisorOptions {
  dataDir: string;
  adapters: Partial<Record<Harness, HarnessAdapter>>;
  signal?: AbortSignal;
  tickIntervalMs?: number;
  log?: (line: string) => void;
  processLiveness?: ProcessLivenessReader;
  service?: TalkingStickService;
}

export async function runSupervisor(options: RunSupervisorOptions): Promise<void> {
  const paths = supervisorPaths(options.dataDir);
  fs.mkdirSync(path.dirname(paths.log), { recursive: true, mode: 0o700 });
  const log = options.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const liveness = options.processLiveness ?? systemProcessLiveness();
  const release = acquireOwnerLock(paths.lock, { pid: process.pid, process_started_at: getCurrentProcessStartedAt() ?? "" }, liveness);
  const store = new SupervisorStore(paths.database);
  const service = options.service ?? new TalkingStickService({ dataDir: options.dataDir,
    wakeTransport: createSystemWakeTransport(), nativeWakeTransport: createSystemNativeWakeTransport() });
  const supervisor = new Supervisor({ store, adapters: options.adapters, processLiveness: liveness,
    bridge: createRoomBridge(service, { dataDir: options.dataDir }), socketPath: paths.socket });
  const control = async (message: ControlMessage): Promise<ControlAnswer> => {
    if (message.action === "interrupt") {
      if (!message.worker_id) return { ok: false, error: "Name the worker." };
      return { ok: true, result: await supervisor.interrupt(message.worker_id, message.actor) };
    }
    // Approvals are a human's decision.
    if (!message.actor.startsWith("human:")) return { ok: false, error: "Only a human can decide an approval." };
    const approval = message.approval_id ? store.approval(message.approval_id) : null;
    if (!approval) return { ok: false, error: "No such approval request." };
    const delivered = await supervisor.decideApproval({ approval_id: approval.approval_id, worker_id: approval.worker_id,
      generation: approval.generation }, message.action === "approve" ? "allow" : "deny", message.actor, message.note);
    return { ok: true, result: { status: message.action === "approve" ? "allowed" : "denied", answer: delivered } };
  };
  const server = await startIntakeServer(paths.socket, (message) => supervisor.acceptIntake(message), control);
  supervisor.reconcileStartup();
  log(`supervisor running (pid ${process.pid}, ${paths.socket})`);
  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try {
      rotateLog(paths.log);
      await supervisor.tick();
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await tick();
  const timer = setInterval(() => { void tick(); }, options.tickIntervalMs ?? TICK_INTERVAL_MS);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    if (options.signal?.aborted) return stop();
    options.signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  stopping = true;
  clearInterval(timer);
  await supervisor.shutdown();
  await server.close();
  store.close();
  if (!options.service) service.close();
  release();
  log("supervisor stopped");
}
