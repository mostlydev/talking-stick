import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../config.js";
import type { EnvReference, Harness, WorkerPermissions, WorkerSpec } from "../supervisor/adapter.js";
import { builtinAdapters } from "../supervisor/adapters/index.js";
import { installLaunchAgent, launchAgentPath, supervisorProgram, uninstallLaunchAgent } from "../supervisor/launchd.js";
import { isStandalone, isInstalledRelease, standaloneRoot } from "../standalone-mode.js";
import { CONTROL_LOCKED, createFileLog, runSupervisor, supervisorPaths, systemProcessLiveness } from "../supervisor/run.js";
import { acquireOwnerLock } from "../supervisor/daemon.js";
import { getCurrentProcessStartedAt } from "../process-utils.js";
import { SupervisorStore } from "../supervisor/state.js";
import { runningInsideHarness } from "../identity.js";
import { deriveCliIdentity } from "./identity.js";
import { printResult } from "./output.js";
import { getStringOption, getStringOptions, hasOption, type ParsedCommand } from "./parser.js";
import { displayText, safeDetail } from "../supervisor/approval-detail.js";
import { inspectSupervisorState, migrateSupervisorState, prepareSupervisorRoot } from "../supervisor/root.js";

// tt supervisor: the optional managed headless supervisor (docs/supervisor.md).

export const SUPERVISOR_USAGE = [
  "tt supervisor status",
  "tt supervisor add <worker> --harness claude|codex|grok --cwd PATH [--model M] [--permission-mode default|plan]",
  "  [--sandbox read-only|workspace-write --approval on-request|untrusted] [--env NAME[=keychain:SERVICE|=literal:VALUE]]",
  "tt supervisor pause|resume|stop|remove <worker>",
  "tt supervisor restart <worker> [--fresh]",
  "tt supervisor interrupt <worker>",
  "tt supervisor approvals [show <approval-id>] | approve <approval-id> [--note TEXT] | deny <approval-id> [--note TEXT]",
  "tt supervisor reconcile <batch-token> --resend|--drop",
  "tt supervisor run | install | uninstall | migrate | logs [--lines N]"
].join("\n");

export class SupervisorCommandError extends Error {}

const WORKER_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const KNOWN_ACTIONS = new Set(["status", "approvals", "logs", "add", "pause", "resume", "stop", "restart", "remove", "interrupt",
  "approve", "deny", "reconcile", "run", "install", "uninstall", "migrate"]);

function fail(message: string): never {
  throw new SupervisorCommandError(message);
}

function openStore(stateDir: string): SupervisorStore {
  return new SupervisorStore(supervisorPaths(stateDir).database);
}

function workerArg(parsed: ParsedCommand): string {
  const worker = parsed.positionals[1];
  if (!worker) fail("Name the worker.");
  return worker;
}

function parsePermissions(parsed: ParsedCommand, harness: Harness): WorkerPermissions {
  const mode = getStringOption(parsed, "permission-mode");
  const sandbox = getStringOption(parsed, "sandbox");
  const approval = getStringOption(parsed, "approval");
  if (harness === "claude") {
    if (sandbox || approval) fail("--sandbox and --approval are Codex settings.");
    if (mode && mode !== "default" && mode !== "plan") fail("--permission-mode must be default or plan; the supervisor never bypasses approvals.");
    return { harness, mode: (mode ?? "default") as "default" | "plan" };
  }
  if (harness === "codex") {
    if (mode) fail("--permission-mode is a Claude setting.");
    if (sandbox !== "read-only" && sandbox !== "workspace-write") fail("A Codex worker needs --sandbox read-only or workspace-write.");
    if (approval !== "on-request" && approval !== "untrusted") fail("A Codex worker needs --approval on-request or untrusted.");
    return { harness, sandbox, approval };
  }
  if (mode || sandbox || approval) fail("A Grok worker takes no permission settings.");
  return { harness };
}

/** NAME passes the supervisor's own value through; keychain and literal values are named explicitly. */
export function parseEnvReference(raw: string): EnvReference {
  const [name, source] = raw.split(/=(.*)/s, 2);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${name} is not an environment variable name.`);
  if (name.startsWith("TT_SUPERVISOR_")) fail(`${name} is set by the supervisor.`);
  if (source === undefined) return { name, from: "inherit" };
  if (source.startsWith("keychain:") && source.length > "keychain:".length) return { name, from: "keychain", service: source.slice(9) };
  if (source.startsWith("literal:")) return { name, from: "literal", value: source.slice(8) };
  fail(`--env ${name} takes keychain:SERVICE or literal:VALUE (only for values that are not secret).`);
}

function describeStatus(store: SupervisorStore) {
  return {
    workers: store.workers().map((worker) => {
      const spec = JSON.parse(worker.spec_json) as WorkerSpec;
      const generation = store.latestGeneration(worker.worker_id);
      return {
        worker_id: worker.worker_id, harness: spec.harness, cwd: spec.cwd, desired: worker.desired,
        desired_version: worker.desired_version, hold_reason: worker.hold_reason, next_start_at: worker.next_start_at,
        generation: generation ? { generation: generation.generation, state: generation.state, pid: generation.pid,
          session_id: generation.session_id, started_at: generation.started_at, ended_at: generation.ended_at } : null,
        uncertain_inputs: (store.db.prepare("SELECT COUNT(*) AS count FROM inputs WHERE worker_id = ? AND state = 'uncertain'")
          .get(worker.worker_id) as { count: number }).count
      };
    }),
    pending_approvals: store.pendingApprovals().map((approval) => ({ approval_id: approval.approval_id, worker_id: approval.worker_id,
      generation: approval.generation, tool: approval.tool, summary: approval.summary, detail_sha256: approval.detail_sha256,
      requested_at: approval.requested_at }))
  };
}

function cliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export interface SupervisorCommandOptions {
  /** Which harness, if any, this command runs inside; the system check by default. */
  insideHarness?: () => string | null;
}

export async function handleSupervisorCommand(parsed: ParsedCommand, options: SupervisorCommandOptions = {}): Promise<void> {
  const dataDir = resolveDataDir();
  const action = parsed.positionals[0] ?? "status";
  const actor = deriveCliIdentity(parsed).agent_id;
  // Approvals and reconciling are the operator's own: never through an
  // identity override, and never from inside a harness session.
  const requireHuman = (what: string) => {
    if (getStringOption(parsed, "agent")) fail(`${what} does not accept --agent.`);
    const harness = (options.insideHarness ?? runningInsideHarness)();
    if (harness || !actor.startsWith("human:")) fail(`Only a human can ${what.toLowerCase()}${harness ? `, not a ${harness} session` : ""}.`);
  };
  const now = () => new Date().toISOString();
  // Unknown and locked actions refuse before anything is resolved or created.
  if (!KNOWN_ACTIONS.has(action)) fail(`Unknown supervisor action ${action}.\n${SUPERVISOR_USAGE}`);
  if (!["status", "approvals", "logs"].includes(action)) requireHuman(`Change the supervisor (${action})`);
  // Fail closed until a verified human-control boundary exists (docs/supervisor.md).
  if (action === "interrupt" || action === "approve" || action === "deny" || action === "reconcile") fail(CONTROL_LOCKED);
  // Reading never creates state; writing prepares the protected root, and both
  // refuse while older state in the data directory still waits to move.
  const readOnly = ["status", "approvals", "logs"].includes(action);
  const state = inspectSupervisorState(dataDir);
  if (readOnly && (state.kind === "legacy" || state.kind === "migrating")) {
    fail(`Supervisor state in ${state.root.dataDir} must move to ${state.root.dir} first: run \`tt supervisor migrate\`.`);
  }
  const root = readOnly || action === "migrate" || action === "uninstall" ? state.root : prepareSupervisorRoot(dataDir);
  const paths = supervisorPaths(root.dir);

  // Until a scoped operator policy exists, only a human changes the
  // supervisor, including starting its daemon by hand; agents may read its
  // status, approvals and logs. launchd runs it with no harness around it.
  if (action === "run") {
    await runSupervisor({ dataDir, adapters: builtinAdapters(), log: createFileLog(paths.log) });
    return;
  }
  if (action === "install") {
    const program = supervisorProgram({ standalone: isStandalone(), execPath: process.execPath, cliEntry: cliEntry(),
      releaseRoot: isStandalone() && isInstalledRelease() ? standaloneRoot() : null });
    const file = installLaunchAgent({ program, dataDir, logPath: paths.launchdLog });
    printResult(parsed, { status: "installed", plist: file, log: paths.log }, () => `Installed ${file}; the supervisor now runs as a user agent.`);
    return;
  }
  if (action === "migrate") {
    // launchd would restart a daemon on the old paths, so its agent goes first.
    if (fs.existsSync(launchAgentPath())) fail("Run `tt supervisor uninstall` first; install again after migrating.");
    const startedAt = getCurrentProcessStartedAt();
    if (!startedAt?.trim()) fail("Can't read this process's start time, so it can't hold the supervisor's locks.");
    const liveness = systemProcessLiveness();
    const result = migrateSupervisorState(dataDir, (lock) => acquireOwnerLock(lock, { pid: process.pid, process_started_at: startedAt }, liveness));
    printResult(parsed, result, () => result.status === "migrated"
      ? `Moved the supervisor's state to ${result.root}; the old files are kept in ${result.retired}.`
      : `Nothing to migrate; the supervisor's state is in ${result.root}.`);
    return;
  }
  if (action === "uninstall") {
    const removed = uninstallLaunchAgent();
    printResult(parsed, { status: removed ? "uninstalled" : "not_installed", plist: launchAgentPath() },
      () => removed ? "Uninstalled the supervisor's user agent." : "The supervisor's user agent was not installed.");
    return;
  }
  if (action === "logs") {
    const lines = Number(getStringOption(parsed, "lines") ?? "50");
    const text = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, "utf8").trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n") : "";
    printResult(parsed, { log: paths.log, lines: text ? text.split("\n") : [] }, () => text || `No log yet at ${paths.log}.`);
    return;
  }
  if (state.kind === "none" && readOnly) {
    // No supervisor state yet: an empty answer, without creating any.
    if (action === "approvals" && parsed.positionals[1] === "show") fail("No such approval request.");
    const empty = { workers: [], pending_approvals: [] };
    printResult(parsed, action === "approvals" ? { pending_approvals: [] } : empty,
      () => action === "approvals" ? "No pending approvals." : "No workers.");
    return;
  }
  const store = openStore(root.dir);
  try {
    if (action === "approvals" && parsed.positionals[1] === "show") {
      // The whole request, read-only: what a human would be deciding.
      const approval = store.approval(parsed.positionals[2] ?? "");
      if (!approval) fail("No such approval request. Run `tt supervisor approvals` for the pending ones.");
      printResult(parsed, { approval_id: approval.approval_id, worker_id: approval.worker_id, generation: approval.generation,
        tool: approval.tool, summary: approval.summary, status: approval.status, requested_at: approval.requested_at,
        detail_sha256: approval.detail_sha256, detail: approval.detail },
      () => [`${approval.approval_id}  ${approval.worker_id}#${approval.generation}  ${displayText(approval.tool, 80)}  ${approval.status}`,
        `sha256 ${approval.detail_sha256}`, safeDetail(approval.detail) || "(recorded before full detail was kept)"].join("\n"));
      return;
    }
    if (action === "status" || action === "approvals") {
      const status = describeStatus(store);
      const result = action === "approvals" ? { pending_approvals: status.pending_approvals } : status;
      printResult(parsed, result, () => action === "approvals"
        ? (status.pending_approvals.map((a) => `${a.approval_id}  ${a.worker_id}#${a.generation}  ${displayText(a.tool, 80)}: ${displayText(a.summary, 500)}`)
          .join("\n") || "No pending approvals.")
        : (status.workers.map((w) => `${w.worker_id}  ${w.harness}  ${w.desired}${w.hold_reason ? ` (held: ${w.hold_reason})` : ""}  ` +
            `${w.generation ? `#${w.generation.generation} ${w.generation.state}` : "never started"}` +
            `${w.uncertain_inputs ? `  ${w.uncertain_inputs} uncertain` : ""}`).join("\n") || "No workers.") +
          (status.pending_approvals.length ? `\n${status.pending_approvals.length} approval(s) pending.` : ""));
      return;
    }
    if (action === "add") {
      const workerId = workerArg(parsed);
      if (!WORKER_ID.test(workerId)) fail("A worker name is lowercase letters, digits, '.', '_' or '-', up to 48 characters.");
      if (store.worker(workerId)) fail(`Worker ${workerId} already exists.`);
      const harness = getStringOption(parsed, "harness") as Harness | undefined;
      if (harness !== "claude" && harness !== "codex" && harness !== "grok") fail("--harness must be claude, codex or grok.");
      const cwd = getStringOption(parsed, "cwd");
      if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) fail("--cwd must be an existing absolute directory.");
      // An existing native session is never imported: nothing here can prove
      // it isn't running elsewhere. A worker resumes only sessions it started.
      if (getStringOption(parsed, "resume")) fail("--resume is not supported: a worker resumes only sessions it started itself.");
      const spec: WorkerSpec = { worker_id: workerId, harness, cwd, permissions: parsePermissions(parsed, harness),
        ...(getStringOption(parsed, "model") ? { model: getStringOption(parsed, "model") } : {}),
        env: getStringOptions(parsed, "env").map(parseEnvReference) };
      const row = store.addWorker(spec, actor, now());
      printResult(parsed, { status: "added", worker: row.worker_id, desired: row.desired },
        () => `Added ${row.worker_id}; the supervisor starts it on its next tick.`);
      return;
    }
    if (action === "pause" || action === "resume" || action === "stop") {
      const row = store.setDesired(workerArg(parsed), action === "pause" ? "paused" : action === "stop" ? "stopped" : "running",
        actor, now(), action === "resume");
      printResult(parsed, { worker: row.worker_id, desired: row.desired, desired_version: row.desired_version },
        () => `${row.worker_id} is now ${row.desired}.`);
      return;
    }
    if (action === "restart") {
      const row = store.requestRestart(workerArg(parsed), hasOption(parsed, "fresh"), actor, now());
      printResult(parsed, { worker: row.worker_id, desired_version: row.desired_version, fresh: hasOption(parsed, "fresh") },
        () => `${row.worker_id} restarts on the next tick${hasOption(parsed, "fresh") ? " in a new conversation" : ""}.`);
      return;
    }
    if (action === "remove") {
      const workerId = workerArg(parsed);
      const worker = store.worker(workerId);
      if (!worker) fail(`No worker named ${workerId}.`);
      if (worker.desired !== "stopped" || store.liveGenerations().some((row) => row.worker_id === workerId)) {
        fail(`Stop ${workerId} first; a worker is removed only when nothing of it runs.`);
      }
      store.transaction(() => {
        store.db.prepare("DELETE FROM workers WHERE worker_id = ?").run(workerId);
        store.audit(now(), actor, "remove", workerId);
      });
      printResult(parsed, { status: "removed", worker: workerId }, () => `Removed ${workerId}.`);
      return;
    }
    fail(`Unknown supervisor action ${action}.\n${SUPERVISOR_USAGE}`);
  } finally {
    store.close();
  }
}
