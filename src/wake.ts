import { execFileSync } from "node:child_process";

export const STANDBY_WAKE_TEXT =
  "Talking Stick has an actionable update. Run tt wait --json to resume coordination.";
export const CMUX_WAKE_TIMEOUT_MS = 5_000;

export interface WakeRequest {
  room_id: string;
  agent_id: string;
  transport: "cmux";
  workspace_id: string;
  surface_id: string;
  generation: number;
  reason: string;
}

export interface WakeDeliveryResult {
  delivered: boolean;
  error?: string;
}

export interface WakeTransport {
  deliver(request: WakeRequest): WakeDeliveryResult;
}

export type WakeExecFile = (
  file: string,
  args: readonly string[],
  options: { stdio: "ignore"; timeout: number }
) => void;

export function createSystemWakeTransport(
  execFile: WakeExecFile = (file, args, options) =>
    execFileSync(file, args, options)
): WakeTransport {
  return {
    deliver(request) {
      try {
        execFile(
          "cmux",
          [
            "send",
            "--workspace",
            request.workspace_id,
            "--surface",
            request.surface_id,
            STANDBY_WAKE_TEXT
          ],
          { stdio: "ignore", timeout: CMUX_WAKE_TIMEOUT_MS }
        );
        // TUI composers insert a raw newline instead of submitting, so the
        // prompt only fires with a discrete Enter key event after the text.
        execFile(
          "cmux",
          [
            "send-key",
            "--workspace",
            request.workspace_id,
            "--surface",
            request.surface_id,
            "enter"
          ],
          { stdio: "ignore", timeout: CMUX_WAKE_TIMEOUT_MS }
        );
        return { delivered: true };
      } catch (error) {
        return {
          delivered: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
}

export interface CmuxStandbyEndpoint {
  workspace_id: string;
  surface_id: string;
}

export type CmuxIdentify = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    timeout: number;
    stdio: ["ignore", "pipe", "pipe"];
  }
) => string;

export function hasCmuxCallerContext(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(env.CMUX_TAB_ID?.trim() || env.CMUX_AGENT_LAUNCH_KIND?.trim());
}

export function resolveCmuxStandbyEndpoint(
  identify: CmuxIdentify = (file, args, options) =>
    execFileSync(file, args, {
      ...options,
      timeout: CMUX_WAKE_TIMEOUT_MS
    })
): CmuxStandbyEndpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      identify("cmux", ["identify", "--json"], {
        encoding: "utf8",
        timeout: CMUX_WAKE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
  } catch (error) {
    throw new Error(
      `Unable to verify the caller's cmux surface: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const caller = (parsed as { caller?: unknown }).caller;
  const workspaceId =
    caller && typeof caller === "object"
      ? (caller as { workspace_ref?: unknown }).workspace_ref
      : undefined;
  const surfaceId =
    caller && typeof caller === "object"
      ? (caller as { surface_ref?: unknown }).surface_ref
      : undefined;
  if (typeof workspaceId !== "string" || typeof surfaceId !== "string") {
    throw new Error("cmux identify did not return a caller workspace and surface.");
  }

  return { workspace_id: workspaceId, surface_id: surfaceId };
}
