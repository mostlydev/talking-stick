import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { AuthModeError, WorkerExecutableError, type Capabilities, type HarnessAdapter,
  type SpawnedProcess, type WorkerHandle, type WorkerSpec } from "../adapter.js";
import { spawnManagedProcess, workerEnvironment } from "./process.js";
import { AcpError } from "./acp-rpc.js";
import { AcpWorkerHandle } from "./acp-worker.js";

export interface GrokAdapterOptions {
  /** Injectable executable and prefix for deterministic protocol fixtures. */
  command?: string;
  argsPrefix?: string[];
  startTimeoutMs?: number;
  /** The GROK_HOME to run in; the user's own (GROK_HOME, else ~/.grok) by default. */
  home?: string;
}

/** The native `grok` executable: an explicit absolute path, or the first on PATH, resolved. */
export function resolveGrokExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.GROK_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) throw new WorkerExecutableError("GROK_EXECUTABLE", "GROK_EXECUTABLE must be an absolute executable path.");
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "grok"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      // A version-manager shim is not the process the supervisor can own.
      if (["mise", "asdf"].includes(path.basename(real)) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new WorkerExecutableError("GROK_EXECUTABLE", "Cannot find the Grok executable. Set GROK_EXECUTABLE to its absolute path.");
}

export class GrokAdapter implements HarnessAdapter {
  readonly harness = "grok" as const;
  constructor(private readonly options: GrokAdapterOptions = {}) {}
  capabilities(): Capabilities {
    const supported = process.platform !== "win32";
    return { prompt: supported, resume: supported, interrupt: supported, approvals: false };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "grok" || spec.permissions.harness !== "grok") throw new Error("Grok needs explicit Grok permissions.");
    const env = workerEnvironment(spec);
    if (signal?.aborted) throw new Error("Grok start aborted.");
    const stateDir = spec.state_dir;
    if (!stateDir) throw new Error("A managed Grok worker needs the supervisor's state directory.");
    // The user's own home, where their subscription login lives, unless the
    // spec names one; nothing is created or copied.
    env.GROK_HOME ??= this.options.home ?? process.env.GROK_HOME ?? path.join(env.HOME ?? os.homedir(), ".grok");
    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = token && endpoint ? createProcessEvidence({ stateDir, workerId: spec.worker_id,
      generation, harness: "grok", endpoint, token }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new AcpWorkerHandle(generation, {
      name: "Grok", resumeEchoesSession: false, journalPermissions: false
    });
    try {
      const child = await spawnManagedProcess({
        command: this.options.command ?? resolveGrokExecutable(env),
        args: [...(this.options.argsPrefix ?? []), "agent", "--no-leader", "stdio"],
        cwd: spec.cwd, env, signal,
        onSpawn: (process) => {
          evidence?.record(process);
          onSpawn(process);
        },
        onLine: (line) => handle.receive(line),
        onExit: (code, exitSignal) => {
          evidence?.clear();
          handle.exit(code, exitSignal);
        },
        onOverflow: () => handle.fail({ type: "overflow" }) });
      handle.attach(child);
      await handle.initialize(spec.cwd, spec.resume_session_id, this.options.startTimeoutMs ?? 15_000);
      if (signal?.aborted) throw new Error("Grok start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      evidence?.clear();
      if (error instanceof AcpError && error.auth) {
        throw new AuthModeError("auth_required", "Sign in to Grok before starting this worker.");
      }
      throw error;
    }
  }
}
