import fs from "node:fs";
import path from "node:path";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import type { Capabilities, HarnessAdapter, SpawnedProcess, WorkerHandle, WorkerSpec } from "../adapter.js";
import { openCodePermissionEnv, readOpenCodeServerGateSurface, resolveOpenCodeV2Executable,
  verifyOpenCodeSubscriptionRoute } from "./opencode-gate.js";
import { startOpencodeWorker } from "./opencode-worker.js";
import { workerEnvironment } from "./process.js";

export class OpencodeAdapter implements HarnessAdapter {
  readonly harness = "opencode" as const;

  capabilities(): Capabilities {
    const supported = process.platform === "darwin" || process.platform === "linux";
    return { prompt: supported, resume: supported, interrupt: supported, approvals: supported };
  }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (spec.harness !== "opencode" || spec.permissions.harness !== "opencode") {
      throw new Error("OpenCode needs explicit OpenCode permissions.");
    }
    signal?.throwIfAborted();
    if (!spec.state_dir) throw new Error("A managed OpenCode worker needs the supervisor's state directory.");
    const env = workerEnvironment(spec);
    const command = resolveOpenCodeV2Executable(env);
    const cwd = fs.realpathSync(spec.cwd);
    // The native PTY daemon is scoped by XDG_STATE_HOME. Each worker must
    // own its PTY lifecycle separately from interactive OpenCode and peers.
    const stateHome = path.join(spec.state_dir, "workers", spec.worker_id, "opencode-state");
    fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
    env.XDG_STATE_HOME = stateHome;

    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = token && endpoint ? createProcessEvidence({
      stateDir: spec.state_dir, workerId: spec.worker_id, generation, harness: this.harness, endpoint, token
    }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;

    try {
      return await startOpencodeWorker({
        command, cwd, generation, env: { ...env, ...openCodePermissionEnv(spec.permissions) },
        resumeSessionId: spec.resume_session_id, signal,
        onSpawn: (spawned) => {
          evidence?.record(spawned);
          onSpawn(spawned);
        },
        onExit: () => evidence?.clear(),
        beforeSession: async ({ url, authorization, cwd, signal }) => {
          const surface = await readOpenCodeServerGateSurface({
            baseUrl: url, authHeader: authorization, directory: cwd, signal
          });
          const { providerID, id } = verifyOpenCodeSubscriptionRoute(surface, spec.model);
          return { model: { providerID, id } };
        }
      });
    } catch (error) {
      evidence?.clear();
      throw error;
    }
  }
}
