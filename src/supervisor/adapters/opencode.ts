import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createProcessEvidence } from "../../supervisor-process-evidence.js";
import { AuthModeError, type Capabilities, type HarnessAdapter, type SpawnedProcess, type WorkerHandle, type WorkerSpec } from "../adapter.js";
import { OPENCODE_STOCK_OAUTH_PROVIDERS, openCodePermissionEnv, parseOpenCodeModelRef,
  readOpenCodeServerGateSurface, resolveOpenCodeV2Executable, verifyOpenCodeSubscriptionRoute } from "./opencode-gate.js";
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
    const candidateProvider = spec.model === undefined ? null : parseOpenCodeModelRef(spec.model).providerID;
    const allowedProviders = Object.keys(OPENCODE_STOCK_OAUTH_PROVIDERS)
      .filter((provider) => candidateProvider === null || candidateProvider === provider);
    if (allowedProviders.length === 0) {
      throw new AuthModeError("wrong_auth_mode", "Use a stock Anthropic or OpenAI OAuth model for this OpenCode worker.");
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
    // A config file outranks a project provider policy. The env-content
    // overlay is lower priority and is used only for tool permissions.
    const policy = path.join(stateHome, `provider-policy-${generation}.json`);
    fs.writeFileSync(policy, JSON.stringify({ policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      ...allowedProviders.map((resource) => ({ action: "provider.use", resource, effect: "allow" }))
    ] }), { flag: "wx", mode: 0o600 });
    env.OPENCODE_CONFIG = policy;

    const token = spec.supervisor_env?.TT_SUPERVISOR_TOKEN;
    const endpoint = spec.supervisor_env?.TT_SUPERVISOR_ENDPOINT;
    const evidence = token && endpoint ? createProcessEvidence({
      stateDir: spec.state_dir, workerId: spec.worker_id, generation, harness: this.harness, endpoint, token
    }) : null;
    if (evidence) env.TT_SUPERVISOR_PROCESS_FILE = evidence.file;

    const cleanup = () => {
      evidence?.clear();
      try { fs.rmSync(policy, { force: true }); } catch { /* The old generation's file is no longer used. */ }
    };
    try {
      return await startOpencodeWorker({
        command, cwd, generation, env: { ...env, ...openCodePermissionEnv(spec.permissions) },
        resumeSessionId: spec.resume_session_id, signal,
        onSpawn: (spawned) => {
          evidence?.record(spawned);
          onSpawn(spawned);
        },
        onExit: cleanup,
        beforeSession: async ({ url, authorization, cwd, signal }) => {
          const deadline = Date.now() + 8_000;
          for (;;) {
            const surface = await readOpenCodeServerGateSurface({
              baseUrl: url, authHeader: authorization, directory: cwd, signal,
              timeoutMs: Math.max(1, deadline - Date.now())
            });
            if (surface.allowedPolicyResources?.some((resource) => !allowedProviders.includes(resource))) {
              throw new AuthModeError("wrong_auth_mode", "An OpenCode configuration allows another model provider. Use a subscription-only provider policy for this worker.");
            }
            // The server announces its socket before it has loaded the
            // directory's integrations and applied native provider policy.
            if (surface.integrations.length && surface.models.every((model) => allowedProviders.includes(model.providerID))) {
              const { providerID, id } = verifyOpenCodeSubscriptionRoute(surface, spec.model);
              // OpenCode can select another model for a native subagent.
              for (const model of surface.models) {
                if (model.providerID !== providerID || model.id !== id) {
                  verifyOpenCodeSubscriptionRoute(surface, `${model.providerID}/${model.id}`);
                }
              }
              return { model: { providerID, id } };
            }
            if (Date.now() >= deadline) {
              throw new AuthModeError("wrong_auth_mode", "OpenCode did not publish a catalog limited to the worker's subscription policy.");
            }
            await delay(100, undefined, { signal });
          }
        }
      });
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
