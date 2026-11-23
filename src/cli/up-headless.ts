import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../config.js";
import { DEFAULT_AGENT_PAIR, readLaunchDefaults, resolveAgentChoice } from "../launch-defaults.js";
import { acquireLaunchLock } from "../launch-record.js";
import { resolveContextPath } from "../path-resolution.js";
import type { Harness, WorkerSpec } from "../supervisor/adapter.js";
import type { ProcessLivenessReader } from "../supervisor/daemon.js";
import { LAUNCHD_LABEL, launchAgentPath, systemLaunchctl, type LaunchctlRunner } from "../supervisor/launchd.js";
import { inspectSupervisorState, prepareSupervisorRoot, type SupervisorRoot } from "../supervisor/root.js";
import { supervisorPaths } from "../supervisor/run.js";
import {
  readSupervisorDaemonStatus,
  readSupervisorSnapshot,
  readSupervisorWorkers,
  type SupervisorDaemonStatus,
  type SupervisorWorkerStatus
} from "../supervisor/snapshot.js";
import { SupervisorStore } from "../supervisor/state.js";
import {
  findOnPath,
  installedLaunchAgents,
  launchUnavailableReason,
  parseLaunchAgents,
  type LaunchAgent
} from "../workspace-launch.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, hasOption, type ParsedCommand } from "./parser.js";
import type { Runtime } from "./runtime.js";
import { roomShortName } from "./room-selector.js";
import { pickDeepestRoom } from "./session.js";
import { defaultWorkerPermissions, installSupervisorService } from "./supervisor-commands.js";

// tt up --headless: one supervised worker per agent in a directory, plus the
// supervisor itself when none runs. Workers join the room their directory
// resolves to, exactly as tt supervisor add workers do.

/** Flags that only mean something for panes; a headless launch refuses them rather than ignoring them. */
const PANE_ONLY_FLAGS = ["in", "new-tab", "new-workspace", "forget", "save", "choose", "room", "timeout"];
const PREFIX = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface HeadlessUpOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  launchctl?: LaunchctlRunner;
  liveness?: ProcessLivenessReader;
  /** Replaces installing the macOS user agent (tests); returns the plist path. */
  installService?: (dataDir: string, root: SupervisorRoot, options: { searchPath?: string; replace: false }) => string;
}

export interface HeadlessWorker {
  agent: LaunchAgent;
  worker: string;
  action: "add" | "added" | "exists";
  /** The worker's own stored permissions; an existing worker keeps whatever it was added with. */
  unrestricted: boolean;
  /** For an existing worker: what the supervisor last recorded. */
  desired?: string;
  hold_reason?: string | null;
}

export type HeadlessService =
  | { state: "running" }
  | { state: "starting"; plist: string }
  | { state: "unknown"; remedy: string }
  | { state: "installed"; plist: string }
  | { state: "would_install"; plist: string }
  | { state: "not_started"; detail: string; remedy: string };

export interface HeadlessUpResult {
  status: "started" | "nothing_to_add" | "preview";
  canonical_path: string;
  room: string;
  room_path: string;
  /** The permissions newly added workers get. */
  new_workers: "unrestricted" | "restricted";
  workers: HeadlessWorker[];
  skipped: string[];
  service: HeadlessService;
  next_steps: string[];
}

function harnessFor(agent: LaunchAgent): Harness {
  if (agent === "opencode") throw new Error("OpenCode has no headless worker. Choose from claude, codex, grok and agy.");
  return agent;
}

function agentLabel(agent: LaunchAgent): string {
  return agent === "antigravity" ? "agy" : agent;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A worker-name prefix from the room's short name: lowercase, worker-id safe, never empty. */
export function headlessPrefix(roomName: string): string {
  const slug = roomName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40).replace(/-+$/, "");
  return slug || "room";
}

function realDirectory(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

type InstalledService = { kind: "absent" } | { kind: "unreadable" } | { kind: "serves"; dataDir: string; stateBase: string | null };

function plistValue(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match ? unescapeXml(match[1]) : null;
}

/** Which data directory and supervisor state folder the installed user agent serves, read from its plist. */
function installedService(homeDir?: string): InstalledService {
  let plist: string;
  try {
    plist = fs.readFileSync(launchAgentPath(homeDir), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
  }
  const dataDir = plistValue(plist, "TALKING_STICK_DATA_DIR");
  return dataDir === null ? { kind: "unreadable" } : { kind: "serves", dataDir, stateBase: plistValue(plist, "TT_SUPERVISOR_STATE_DIR") };
}

/**
 * The PATH workers and the user agent run with. A desktop app's shell often
 * lacks the terminal's PATH, so when tt itself isn't on it, the folder of the
 * standard install (or of this executable) goes first; workers need tt.
 */
export function workerSearchPath(env: NodeJS.ProcessEnv, homeDir: string | undefined, platform: NodeJS.Platform): string | undefined {
  if (findOnPath("tt", env, platform)) return env.PATH;
  const candidates = [path.join(homeDir ?? os.homedir(), ".local", "bin"), path.dirname(process.execPath)];
  const dir = candidates.find((candidate) => findOnPath("tt", { PATH: candidate }, platform));
  return dir ? [dir, env.PATH].filter(Boolean).join(path.delimiter) : env.PATH;
}

function serviceLoaded(launchctl: LaunchctlRunner): boolean {
  try {
    launchctl(["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What to do about the supervisor process. A live owner, or one whose state
 * can't be read, is left alone. On macOS a stopped supervisor is installed as
 * the user agent only when nothing else holds that per-user label: an agent
 * for another data directory, one whose plist can't be read, or one that is
 * loaded and still starting (another launch may have just installed it) is
 * never booted out.
 */
function planService(daemon: SupervisorDaemonStatus, dataDir: string, root: SupervisorRoot, platform: NodeJS.Platform,
  homeDir: string | undefined, launchctl: LaunchctlRunner): HeadlessService {
  const checkStatus = "Could not tell whether the supervisor is running; check tt supervisor status.";
  if (daemon === "running") return { state: "running" };
  if (daemon === "unknown") return { state: "unknown", remedy: checkStatus };
  if (platform !== "darwin") {
    return { state: "not_started", detail: "No supervisor is running.",
      remedy: "Run tt supervisor run in a terminal and leave it open; the workers start then." };
  }
  const plist = launchAgentPath(homeDir);
  const installed = installedService(homeDir);
  const stateBase = path.dirname(root.dir);
  if (installed.kind === "serves" && (path.resolve(installed.dataDir) !== path.resolve(dataDir) ||
      (installed.stateBase !== null && path.resolve(installed.stateBase) !== path.resolve(stateBase)))) {
    return { state: "not_started",
      detail: `The installed supervisor user agent serves ${installed.dataDir}` +
        `${installed.stateBase ? ` with state in ${installed.stateBase}` : ""}, not ${dataDir} with state in ${stateBase}.`,
      remedy: "Run tt supervisor run for this data directory, or tt supervisor install to point the user agent here." };
  }
  const loaded = serviceLoaded(launchctl);
  // An agent from before the state folder was recorded can't be matched to these workers.
  if (installed.kind === "unreadable" || (installed.kind === "serves" && installed.stateBase === null) ||
      (installed.kind === "absent" && loaded)) {
    return { state: "unknown", remedy: `Something else holds the supervisor's user agent (${plist}). ${checkStatus}` };
  }
  if (loaded) return { state: "starting", plist };
  return { state: "would_install", plist };
}

/** One lock per user, since the user agent's label is per user whatever the data directory. */
function serviceLockDir(homeDir: string | undefined): string {
  return path.join(homeDir ?? os.homedir(), "Library", "Application Support", "talking-stick");
}

export async function handleHeadlessUp(runtime: Runtime, parsed: ParsedCommand, options: HeadlessUpOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const launchctl = options.launchctl ?? systemLaunchctl;
  for (const flag of PANE_ONLY_FLAGS) {
    if (hasOption(parsed, flag)) throw new Error(`--${flag} is for panes; tt up --headless takes --path, --agents, --prefix, --restricted and --print.`);
  }
  // A bare --path must never launch in the caller's own directory, nor a bare --agents start the default roster.
  for (const flag of ["path", "agents", "prefix"]) {
    if (hasOption(parsed, flag) && getStringOption(parsed, flag) === undefined) throw new Error(`--${flag} needs a value.`);
  }
  if (platform === "win32") throw new Error("Headless workers run on macOS and Linux; the supervisor has no Windows process control yet.");
  const preview = hasOption(parsed, "print");
  const restricted = hasOption(parsed, "restricted");
  const requestedAgents = getStringOption(parsed, "agents");
  const requested = requestedAgents === undefined ? undefined : parseLaunchAgents(requestedAgents);
  requested?.forEach(harnessFor);
  const prefixOption = getStringOption(parsed, "prefix");
  if (prefixOption !== undefined && !PREFIX.test(prefixOption)) {
    throw new Error("--prefix is lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, up to 40 characters.");
  }

  const contextPath = getStringOption(parsed, "path") ?? process.cwd();
  if (!fs.statSync(contextPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${contextPath} is not a directory. Create it first, then run tt up --headless again.`);
  }
  const resolved = resolveContextPath(contextPath);
  const cwd = resolved.canonical_context_path;
  // Workers join the room their directory resolves to; name them after it.
  const room = pickDeepestRoom(runtime.commands.listRooms({ context_path: cwd }).rooms);
  const roomPath = room?.canonical_path ?? resolved.room_path;
  const roomName = roomShortName({ canonical_path: roomPath });
  const prefix = prefixOption ?? headlessPrefix(roomName);

  const dataDir = resolveDataDir({ env });
  const searchPath = workerSearchPath(env, options.homeDir, platform);
  // Agents are looked up on the PATH the workers will run with, which may add tt's folder.
  const workerEnv = { ...env, PATH: searchPath };
  const launchable = installedLaunchAgents(workerEnv, options.homeDir, true, platform).filter((agent) => agent !== "opencode");
  const choice = resolveAgentChoice({ requested, defaults: requested ? {} : readLaunchDefaults(dataDir), roomKey: roomPath, launchable });
  if (requested) {
    const missing = requested.flatMap((agent) => {
      const reason = launchUnavailableReason(agent, workerEnv, options.homeDir, platform);
      return reason ? [`${agentLabel(agent)} (${reason})`] : [];
    });
    if (missing.length > 0) throw new Error(`Cannot start ${missing.join(", ")} here.`);
  }
  const agents = choice.agents.filter((agent) => agent !== "opencode");
  const skipped = [
    ...choice.unavailable.map((agent) => `${agentLabel(agent)}: saved for tt up but cannot run headless here`),
    ...(choice.agents.includes("opencode") ? ["opencode: no headless worker"] : [])
  ];
  if (agents.length === 0) {
    throw new Error(choice.source === "pair"
      ? `Neither ${DEFAULT_AGENT_PAIR.join(" nor ")} is installed with its rooms skill. Install one, or name agents with --agents.`
      : "None of the saved agents can run headless here. Name agents with --agents.");
  }

  const state = inspectSupervisorState(dataDir, env);
  if (state.kind === "legacy" || state.kind === "migrating") {
    throw new Error(`Supervisor state in ${state.root.dataDir} must move to ${state.root.dir} first: run tt supervisor migrate.`);
  }

  const plan = (existing: readonly SupervisorWorkerStatus[]): HeadlessWorker[] => {
    const conflicts: string[] = [];
    const planned = agents.map((agent): HeadlessWorker => {
      const harness = harnessFor(agent);
      const same = existing.find((worker) => worker.harness === harness && realDirectory(worker.cwd) === cwd);
      if (same) {
        return { agent, worker: same.worker_id, action: "exists", unrestricted: same.unrestricted === true,
          desired: same.desired, hold_reason: same.hold_reason };
      }
      const name = `${prefix}-${agentLabel(agent)}`;
      const taken = existing.find((worker) => worker.worker_id === name);
      if (taken) conflicts.push(`${name} already runs ${taken.harness} in ${taken.cwd}`);
      return { agent, worker: name, action: "add", unrestricted: !restricted };
    });
    if (conflicts.length > 0) {
      throw new Error(`${conflicts.join("; ")}. Nothing was added. Pick another name with --prefix, e.g. tt up --headless --prefix ${prefix}-2.`);
    }
    return planned;
  };

  const buildResult = (status: HeadlessUpResult["status"], workers: HeadlessWorker[], service: HeadlessService): HeadlessUpResult => {
    const next: string[] = [];
    if (service.state === "not_started" || service.state === "unknown") next.push(service.remedy);
    for (const worker of workers) {
      if (worker.action === "exists" && worker.desired && worker.desired !== "running") {
        next.push(`${worker.worker} is ${worker.desired}; tt supervisor resume ${worker.worker} starts it again.`);
      } else if (worker.action === "exists" && worker.hold_reason) {
        next.push(`${worker.worker} is held (${worker.hold_reason}); see tt supervisor status.`);
      }
    }
    next.push(`Watch and direct the room: tt chat ${shellQuote(cwd)}`);
    next.push(`From another session: tt room brief ${shellQuote(roomPath)}`);
    next.push("Workers join within a minute; tt supervisor status shows their startup.");
    return { status, canonical_path: cwd, room: roomName, room_path: roomPath,
      new_workers: restricted ? "restricted" : "unrestricted", workers, skipped, service, next_steps: next };
  };

  const snapshotOptions = { env, liveness: options.liveness };
  if (preview) {
    const snapshot = readSupervisorSnapshot(dataDir, snapshotOptions);
    const workers = plan(snapshot.kind === "ready" ? snapshot.workers : []);
    const daemon = snapshot.kind === "ready" ? snapshot.daemon : snapshot.kind === "none" ? "stopped" : "unknown";
    const service = planService(daemon, dataDir, state.root, platform, options.homeDir, launchctl);
    const result = buildResult("preview", workers, service);
    printResult(parsed, result, () => renderHeadless(result));
    return;
  }

  const root = prepareSupervisorRoot(dataDir, env);
  const store = new SupervisorStore(supervisorPaths(root.dir).database);
  let workers: HeadlessWorker[];
  try {
    const actor = deriveCliIdentity(parsed).agent_id;
    const at = new Date().toISOString();
    // One transaction, so a conflict found late adds nothing at all.
    workers = store.transaction(() => {
      const planned = plan(readSupervisorWorkers(store.db));
      for (const worker of planned) {
        if (worker.action !== "add") continue;
        const harness = harnessFor(worker.agent);
        const spec: WorkerSpec = { worker_id: worker.worker, harness, cwd,
          permissions: defaultWorkerPermissions(harness, { restricted }),
          env: searchPath ? [{ name: "PATH", from: "literal", value: searchPath }] : [] };
        store.addWorker(spec, actor, at);
        worker.action = "added";
      }
      return planned;
    });
  } finally {
    store.close();
  }

  const service = ensureService(dataDir, root, platform, options, launchctl, searchPath);
  const result = buildResult(workers.some((worker) => worker.action === "added") ? "started" : "nothing_to_add", workers, service);
  printResult(parsed, result, () => renderHeadless(result));
  if (service.state === "not_started") process.exitCode = 1;
}

/**
 * Starts the supervisor when none runs. On macOS this is serialized per user
 * and rechecked under the lock, so two launches at once, even for different
 * data directories, never restart a service the other one just installed.
 */
function ensureService(dataDir: string, root: SupervisorRoot, platform: NodeJS.Platform, options: HeadlessUpOptions,
  launchctl: LaunchctlRunner, searchPath: string | undefined): HeadlessService {
  if (platform !== "darwin") return planService(readSupervisorDaemonStatus(supervisorPaths(root.dir).lock, options.liveness),
    dataDir, root, platform, options.homeDir, launchctl);
  const release = acquireLaunchLock(serviceLockDir(options.homeDir), "supervisor-user-agent");
  try {
    const daemon = readSupervisorDaemonStatus(supervisorPaths(root.dir).lock, options.liveness);
    const planned = planService(daemon, dataDir, root, platform, options.homeDir, launchctl);
    if (planned.state !== "would_install") return planned;
    try {
      // Never boot out a loaded agent here: one started since the check makes bootstrap fail instead.
      const plist = options.installService
        ? options.installService(dataDir, root, { searchPath, replace: false })
        : installSupervisorService(dataDir, root, { launchctl, homeDir: options.homeDir, searchPath, replace: false });
      return { state: "installed", plist };
    } catch (error) {
      if (serviceLoaded(launchctl)) return { state: "starting", plist: planned.plist };
      return { state: "not_started", detail: `Installing the supervisor's user agent failed: ${(error as Error).message}`,
        remedy: "Run tt supervisor install from a terminal, or tt supervisor run and leave it open." };
    }
  } finally {
    release();
  }
}

function describeService(service: HeadlessService): string {
  switch (service.state) {
    case "running": return "Supervisor: already running.";
    case "starting": return `Supervisor: its macOS user agent is loaded and starting (${service.plist}).`;
    case "unknown": return "Supervisor: state unknown.";
    case "installed": return `Supervisor: installed and started the macOS user agent (${service.plist}). tt supervisor uninstall removes it.`;
    case "would_install": return `Supervisor: not running; would install and start the macOS user agent (${service.plist}).`;
    case "not_started": return `Supervisor: not started. ${service.detail}`;
  }
}

export function renderHeadless(result: HeadlessUpResult): string {
  const heading = result.status === "preview" ? "Headless preview" : "Headless team";
  const lines = [`${heading} for ${result.room} (${result.canonical_path})`, ""];
  for (const worker of result.workers) {
    const outcome = worker.action === "added" ? `added as ${worker.worker}`
      : worker.action === "add" ? `would add as ${worker.worker}`
      : `already set up as ${worker.worker}${worker.desired && worker.desired !== "running" ? ` (${worker.desired})` : ""}`;
    lines.push(`  ${agentLabel(worker.agent)}: ${outcome} · ${worker.unrestricted ? "unrestricted" : "restricted"}`);
  }
  for (const skip of result.skipped) lines.push(`  skipped ${skip}`);
  lines.push("", describeService(result.service));
  if (result.workers.some((worker) => worker.action !== "exists" && worker.unrestricted)) {
    lines.push("New workers approve their own tool use and run with your account's access; --restricted keeps each harness's own rules.");
  }
  lines.push("", "Next:", ...result.next_steps.map((step) => `  - ${step}`));
  return lines.join("\n");
}
