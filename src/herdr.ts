import { execFileSync } from "node:child_process";

// Herdr calls are injected so tests can assert exact argv without a live server.
export type HerdrRunner = (args: readonly string[], options?: { timeoutMs?: number }) => string;

export const HERDR_TIMEOUT_MS = 10_000;

export interface HerdrContext {
  pane_id: string;
  tab_id: string | null;
  workspace_id: string | null;
}

export interface HerdrRect {
  width: number;
  height: number;
}

export interface HerdrPaneLayout {
  pane_id: string;
  rect: HerdrRect;
}

export interface HerdrAgent {
  pane_id: string;
  name: string | null;
  agent: string | null;
  session_id: string | null;
  status: string | null;
}

export interface HerdrProcess {
  pid: number;
  argv0: string;
}

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    // Herdr's own error code, or null when the call may not have completed
    // (timeouts and crashes), so callers can tell refusal from uncertainty.
    readonly code: string | null = null
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function createSystemHerdrRunner(
  env: NodeJS.ProcessEnv = process.env
): HerdrRunner {
  const binary = env.HERDR_BIN_PATH?.trim() || "herdr";
  return (args, options = {}) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? HERDR_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
}

// Only trust the pane identity Herdr placed in this process's environment.
export function readHerdrContext(
  env: NodeJS.ProcessEnv = process.env
): HerdrContext | null {
  if (env.HERDR_ENV !== "1") return null;
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) return null;
  return {
    pane_id: paneId,
    tab_id: env.HERDR_TAB_ID?.trim() || null,
    workspace_id: env.HERDR_WORKSPACE_ID?.trim() || null
  };
}

export function runHerdrJson(
  runner: HerdrRunner,
  args: readonly string[],
  options: { timeoutMs?: number } = {}
): Record<string, unknown> {
  let output: string;
  try {
    output = runner(args, options);
  } catch (error) {
    throw new HerdrError(
      `herdr ${args.join(" ")} failed: ${describeError(error)}`,
      args,
      herdrErrorCode(error)
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new HerdrError(`herdr ${args.join(" ")} returned non-JSON output.`, args);
  }
  const result = isRecord(parsed) ? parsed.result : undefined;
  if (!isRecord(result)) {
    throw new HerdrError(`herdr ${args.join(" ")} returned no result object.`, args);
  }
  return result;
}

export function readPaneLayout(
  runner: HerdrRunner,
  paneId: string
): HerdrPaneLayout {
  const args = ["pane", "layout", "--pane", paneId];
  const result = runHerdrJson(runner, args);
  const layout = isRecord(result.layout) ? result.layout : null;
  const panes = Array.isArray(layout?.panes) ? layout.panes : [];
  const pane = panes.find((candidate) =>
    isRecord(candidate) && candidate.pane_id === paneId
  );
  const rect = isRecord(pane) && isRecord(pane.rect) ? pane.rect : null;
  if (!rect || typeof rect.width !== "number" || typeof rect.height !== "number") {
    throw new HerdrError(`herdr layout did not describe pane ${paneId}.`, args);
  }
  return { pane_id: paneId, rect: { width: rect.width, height: rect.height } };
}

export function listHerdrAgents(runner: HerdrRunner): HerdrAgent[] {
  const result = runHerdrJson(runner, ["agent", "list"]);
  const agents = Array.isArray(result.agents) ? result.agents : [];
  return agents.filter(isRecord).flatMap((agent) => {
    if (typeof agent.pane_id !== "string") return [];
    const session = isRecord(agent.agent_session) ? agent.agent_session : null;
    return [{
      pane_id: agent.pane_id,
      name: typeof agent.name === "string" ? agent.name : null,
      agent: typeof agent.agent === "string" ? agent.agent : null,
      session_id: session && session.kind === "id" && typeof session.value === "string" ? session.value : null,
      status: typeof agent.agent_status === "string" ? agent.agent_status : null
    }];
  });
}

export function readPaneProcesses(runner: HerdrRunner, paneId: string): HerdrProcess[] {
  const result = runHerdrJson(runner, ["pane", "process-info", "--pane", paneId]);
  const info = isRecord(result.process_info) ? result.process_info : null;
  const processes = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  return processes.filter(isRecord).flatMap((entry) =>
    typeof entry.pid === "number" && typeof entry.argv0 === "string"
      ? [{ pid: entry.pid, argv0: entry.argv0 }]
      : []
  );
}

// Creation responses carry the new pane under different keys per command.
export function createdPaneId(result: Record<string, unknown>): string | null {
  for (const key of ["pane", "root_pane"]) {
    const pane = result[key];
    if (isRecord(pane) && typeof pane.pane_id === "string") return pane.pane_id;
  }
  return null;
}

// Terminal cells are roughly twice as tall as wide, so compare visual extents.
export function preferredSplitDirection(rect: HerdrRect): "right" | "down" {
  return rect.width >= rect.height * 2 ? "right" : "down";
}

function herdrErrorCode(error: unknown): string | null {
  const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
  try {
    const parsed: unknown = JSON.parse(stdout);
    const failure = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
    return failure && typeof failure.code === "string" ? failure.code : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.stdout === "string") {
    try {
      const parsed: unknown = JSON.parse(error.stdout);
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
        return parsed.error.message;
      }
    } catch {
      // Fall through to stderr or the process error.
    }
  }
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
