import path from "node:path";
import type { Harness, WorkerExecutableError, WorkerSpec } from "./adapter.js";
import { resolveAntigravityExecutable } from "./adapters/antigravity.js";
import { resolveClaudeExecutable } from "./adapters/claude.js";
import { resolveCodexExecutable } from "./adapters/codex.js";
import { resolveGrokExecutable } from "./adapters/grok.js";
import { resolveOpenCodeV2Executable } from "./adapters/opencode-gate.js";
import { workerEnvironment } from "./adapters/process.js";

const executables: Record<Harness, {
  name: WorkerExecutableError["envName"];
  resolve: (env: NodeJS.ProcessEnv) => string;
}> = {
  antigravity: { name: "AGY_EXECUTABLE", resolve: resolveAntigravityExecutable },
  claude: { name: "CLAUDE_EXECUTABLE", resolve: resolveClaudeExecutable },
  codex: { name: "CODEX_EXECUTABLE", resolve: resolveCodexExecutable },
  grok: { name: "GROK_EXECUTABLE", resolve: resolveGrokExecutable },
  opencode: { name: "OPENCODE_EXECUTABLE", resolve: resolveOpenCodeV2Executable }
};

/** The CLI can check only paths the worker spec actually fixes. Inherited paths belong to the daemon. */
export function preflightWorkerExecutable(spec: WorkerSpec): void {
  const named = executables[spec.harness];
  const references = new Map(spec.env.map((ref) => [ref.name, ref]));
  const explicit = references.get(named.name);
  const search = references.get("PATH");
  if (explicit?.from === "inherit") return;
  if (!explicit?.value && (search?.from !== "literal" ||
      !search.value.split(path.delimiter).filter(Boolean).every(path.isAbsolute))) return;
  named.resolve(workerEnvironment(spec, {}));
}

export function checkWorkerExecutable(spec: WorkerSpec): void {
  executables[spec.harness].resolve(workerEnvironment(spec));
}

/** Match old Claude/Codex errors as well as the structured executable failures written now. */
export function executableFailure(harness: Harness, exit: string | null, pid: number | null):
  WorkerExecutableError["envName"] | undefined {
  if (!exit || pid !== null) return;
  let detail: { reason?: string; executable_env?: string; error?: string } | null;
  try { detail = JSON.parse(exit); } catch { return; }
  if (detail?.reason !== "start_failed") return;
  const expected = executables[harness]?.name;
  if (expected && detail.executable_env === expected) return expected;
  if (typeof detail.error !== "string") return;
  if (harness === "claude" && detail.error.startsWith("Error: Cannot find the Claude Code executable.")) return expected;
  if (harness === "codex" && detail.error.startsWith("Error: Cannot find a native Codex executable.")) return expected;
}
