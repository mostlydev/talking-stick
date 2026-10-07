import { execFileSync } from "node:child_process";

// Herdr calls are injected so tests can assert exact argv without a live server.
export type HerdrRunner = (args: readonly string[]) => string;

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

export class HerdrError extends Error {
  constructor(message: string, readonly args: readonly string[]) {
    super(message);
    this.name = "HerdrError";
  }
}

export function createSystemHerdrRunner(
  env: NodeJS.ProcessEnv = process.env
): HerdrRunner {
  const binary = env.HERDR_BIN_PATH?.trim() || "herdr";
  return (args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      timeout: HERDR_TIMEOUT_MS,
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
  args: readonly string[]
): Record<string, unknown> {
  let output: string;
  try {
    output = runner(args);
  } catch (error) {
    throw new HerdrError(
      `herdr ${args.join(" ")} failed: ${describeError(error)}`,
      args
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

// Terminal cells are roughly twice as tall as wide, so compare visual extents.
export function preferredSplitDirection(rect: HerdrRect): "right" | "down" {
  return rect.width >= rect.height * 2 ? "right" : "down";
}

function describeError(error: unknown): string {
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
