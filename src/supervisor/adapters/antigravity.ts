import fs from "node:fs";
import path from "node:path";
import Hjson from "hjson";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import {
  AuthModeError, WorkerExecutableError,
  type Capabilities, type HarnessAdapter, type SpawnedProcess,
  type WorkerHandle, type WorkerSpec
} from "../adapter.js";
import { AcpError, acpObject, type AcpObject } from "./acp-rpc.js";
import { AcpWorkerHandle } from "./acp-worker.js";
import { spawnManagedProcess, workerEnvironment } from "./process.js";

export interface AntigravityAdapterOptions {
  command?: string;
  argsPrefix?: string[];
  startTimeoutMs?: number;
}

export function resolveAntigravityExecutable(env: NodeJS.ProcessEnv): string {
  const explicit = env.AGY_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) {
    throw new WorkerExecutableError("AGY_EXECUTABLE", "AGY_EXECUTABLE must be an absolute executable path.");
  }
  const candidates = explicit ? [explicit] : (env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, "agy"));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (["mise", "asdf"].includes(path.basename(real)) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new WorkerExecutableError("AGY_EXECUTABLE", "Cannot resolve the agy executable.");
}

function checkAccountSettings(home: string): void {
  // Inspect the selected auth modes only. The harness owns login and keychain
  // access. The worker environment separately excludes API and ADC overrides.
  for (const directory of ["antigravity-cli", "config"]) {
    const file = path.join(home, ".gemini", directory, "settings.json");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new AuthModeError("wrong_auth_mode", "Cannot read Antigravity authentication settings.");
    }
    let settings: AcpObject;
    try {
      settings = acpObject(Hjson.parse(raw));
    } catch {
      throw new AuthModeError("wrong_auth_mode", "Cannot verify Antigravity authentication settings.");
    }
    const type = acpObject(settings.auth).type;
    if ((type && type !== "oauth-personal" && type !== "oauth-business" && type !== "terminal-login") ||
        settings.modelProvider || acpObject(settings.gcp).project) {
      throw new AuthModeError("wrong_auth_mode", "Sign in to Antigravity with a Google account before starting the worker.");
    }
  }
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly harness = "antigravity" as const;
  constructor(private readonly options: AntigravityAdapterOptions = {}) {}
  capabilities(): Capabilities {
    const supported = process.platform !== "win32";
    return { prompt: supported, resume: supported, interrupt: supported, approvals: supported };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (child: SpawnedProcess) => void,
    signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "antigravity" || spec.permissions.harness !== "antigravity") {
      throw new Error("Antigravity needs explicit Antigravity permissions.");
    }
    const env = workerEnvironment(spec);
    checkAccountSettings(env.HOME!);
    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = spec.state_dir && token && endpoint && createProcessEvidence({
      stateDir: spec.state_dir, workerId: spec.worker_id, generation, harness: this.harness, endpoint, token
    });
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;
    const handle = new AcpWorkerHandle(generation, {
      name: "Antigravity", resumeEchoesSession: true, journalPermissions: true
    });
    try {
      const child = await spawnManagedProcess({
        command: this.options.command ?? resolveAntigravityExecutable(env),
        args: [...(this.options.argsPrefix ?? []), "acp", "--stdio",
          ...(spec.permissions.mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [])],
        cwd: spec.cwd,
        env,
        signal,
        onSpawn: child => {
          if (evidence) evidence.record(child);
          onSpawn(child);
        },
        onLine: line => handle.receive(line),
        onExit: (code, exitSignal) => {
          if (evidence) evidence.clear();
          handle.exit(code, exitSignal);
        },
        onOverflow: () => handle.fail({ type: "overflow" })
      });
      handle.attach(child);
      await handle.initialize(spec.cwd, spec.resume_session_id, this.options.startTimeoutMs ?? 15_000);
      if (signal?.aborted) throw new Error("Antigravity start aborted.");
      return handle;
    } catch (error) {
      await handle.stop(100).catch(() => {});
      if (evidence) evidence.clear();
      if (error instanceof AcpError && error.auth) {
        throw new AuthModeError("auth_required", "Sign in to Antigravity before starting this worker.");
      }
      throw error;
    }
  }
}
