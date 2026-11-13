import fs from "node:fs";
import path from "node:path";
import { TalkingStickService } from "../service.js";
import { createSystemWakeTransport } from "../wake.js";
import { createSystemNativeWakeTransport } from "../native-wake.js";
import { createSystemProcessInspector, getCurrentProcessStartedAt } from "../process-utils.js";
import type { Harness, HarnessAdapter } from "./adapter.js";
import { Supervisor, acquireOwnerLock, type ProcessLivenessReader } from "./daemon.js";
import { startIntakeServer } from "./intake.js";
import { createRoomBridge } from "./room-bridge.js";
import { SupervisorStore, supervisorDatabasePath } from "./state.js";
import { prepareSupervisorRoot } from "./root.js";

// The supervisor daemon: one per data directory, in the foreground. launchd
// keeps it running when installed; tt supervisor run starts it by hand.

export const TICK_INTERVAL_MS = 30_000;

export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 3;

/** Every supervisor-owned path, all under its state root (see root.ts). */
export function supervisorPaths(stateDir: string) {
  const dir = stateDir;
  return {
    dir,
    database: supervisorDatabasePath(stateDir),
    /** Workers are given this one only, for tt deliveries. */
    socket: path.join(dir, "intake.sock"),
    lock: path.join(dir, "owner.lock"),
    log: path.join(dir, "logs", "daemon.log"),
    /** Only what escapes the daemon's own log, such as a crash; launchd holds it open. */
    launchdLog: path.join(dir, "logs", "launchd.log")
  };
}

/** Exact-process liveness: the pid runs and started when recorded. */
export function systemProcessLiveness(): ProcessLivenessReader {
  const inspector = createSystemProcessInspector();
  return (pid, startedAt) => {
    const inspection = inspector.inspect(pid);
    if (inspection === null) return "gone";
    // Without both start times nothing proves the recorded process is gone.
    if (!inspection?.startTime || !startedAt.trim()) return "unknown";
    return inspection.startTime.trim() === startedAt.trim() ? "alive" : "gone";
  };
}

/**
 * The daemon's own log: each line is appended by path, never through a file
 * descriptor held open, so rotation takes effect at once.
 */
export function createFileLog(file: string, maxBytes = LOG_ROTATE_BYTES): (line: string) => void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return (line) => {
    rotateLog(file, maxBytes);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  };
}

/** Keeps a log under maxBytes, with LOG_KEEP older files. */
export function rotateLog(file: string, maxBytes = LOG_ROTATE_BYTES): void {
  try {
    if (fs.statSync(file).size < maxBytes) return;
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
  // Refuses while older state in the data directory still waits to move.
  const root = prepareSupervisorRoot(options.dataDir);
  const paths = supervisorPaths(root.dir);
  fs.mkdirSync(path.dirname(paths.log), { recursive: true, mode: 0o700 });
  const log = options.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
  const liveness = options.processLiveness ?? systemProcessLiveness();
  // Ownership names this exact process; without its start time it can't be proven later.
  const selfStartedAt = getCurrentProcessStartedAt();
  if (!selfStartedAt?.trim()) throw new Error("The supervisor can't read its own process start time, so it won't take ownership.");
  const release = acquireOwnerLock(paths.lock, { pid: process.pid, process_started_at: selfStartedAt }, liveness);
  // Everything opened after the lock registers its cleanup, so any failure,
  // at startup or later, closes it all and releases ownership, newest first.
  const cleanups: Array<() => unknown> = [release];
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  try {
    const store = new SupervisorStore(paths.database);
    cleanups.push(() => store.close());
    const service = options.service ?? new TalkingStickService({ dataDir: options.dataDir,
      wakeTransport: createSystemWakeTransport(), nativeWakeTransport: createSystemNativeWakeTransport() });
    if (!options.service) cleanups.push(() => service.close());
    // An earlier version's control token is never left behind.
    fs.rmSync(path.join(root.dir, "control.token"), { force: true });
    let stopRequested: () => void = () => {};
    const stopped = new Promise<void>((resolve) => { stopRequested = resolve; });
    const onSignal = () => stopRequested();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    options.signal?.addEventListener("abort", onSignal, { once: true });
    cleanups.push(() => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      options.signal?.removeEventListener("abort", onSignal);
    });
    if (options.signal?.aborted) stopRequested();
    const supervisor = new Supervisor({ store, adapters: options.adapters, processLiveness: liveness,
      bridge: createRoomBridge(service, { dataDir: options.dataDir }), socketPath: paths.socket, dataDir: options.dataDir, bootstrap: true,
      stateDir: root.dir });
    cleanups.push(() => supervisor.shutdown());
    const server = await startIntakeServer(paths.socket, (message) => supervisor.acceptIntake(message));
    cleanups.push(() => server.close());
    supervisor.reconcileStartup();
    log(`supervisor running (pid ${process.pid}, ${paths.socket})`);
    // launchd reopens its file at each spawn, so rotating it here applies from the next one.
    rotateLog(paths.launchdLog);
    const tick = async () => {
      if (stopping) return;
      try {
        await supervisor.tick();
      } catch (error) {
        log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    void tick();
    timer = setInterval(() => { void tick(); }, options.tickIntervalMs ?? TICK_INTERVAL_MS);
    await stopped;
  } finally {
    stopping = true;
    if (timer) clearInterval(timer);
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  log("supervisor stopped");
}
