import { spawn } from "node:child_process";
import { displayText } from "./approval-detail.js";

// The human-control boundary (docs/supervisor.md, "Human control"). The
// control token admits a request; only a gate confirmation, asked for that
// exact request, lets it take effect. The built-in gate is locked.

export type GateAction = "approve" | "deny" | "interrupt";

/** Exactly what a human is asked to confirm, built by the daemon from its own records. */
export interface GateRequest {
  action: GateAction;
  worker_id: string;
  generation: number;
  /** For an interrupt: the native turn it would end, so a confirmation never ends a later one. */
  native_turn_id?: string;
  approval_id?: string;
  tool?: string;
  summary?: string;
  detail_sha256?: string;
  /** A note sent to the worker with the decision; the human reads it before it goes. */
  note?: string;
}

export type GateResult = "confirmed" | "refused" | "unavailable";

export interface HumanGate {
  readonly kind: string;
  /** What the gate itself runs, such as its helper; no worker may be able to write it. */
  readonly protectedPaths?: string[];
  /**
   * Asks the human at the console to confirm this one request. A confirmation
   * never carries over: each call asks afresh, and an abort is a refusal.
   */
  confirm(request: GateRequest, signal: AbortSignal): Promise<GateResult>;
}

/** No verified human gate: every control request is refused. */
export const LOCKED_GATE: HumanGate = { kind: "locked", confirm: async () => "unavailable" };

/** The text a human reads before confirming, with every control and invisible character escaped. */
export function gateReason(request: GateRequest): string {
  const who = `${displayText(request.worker_id, 48)} (generation ${request.generation})`;
  if (request.action === "interrupt") return `Interrupt turn ${displayText(request.native_turn_id ?? "", 64)} of ${who}.`;
  const verb = request.action === "approve" ? "Allow" : "Deny";
  return [`${verb} ${displayText(request.tool ?? "tool", 80)} for ${who}:`, displayText(request.summary ?? "", 200),
    `Request ${displayText(request.approval_id ?? "", 64)}, detail sha256 ${displayText(request.detail_sha256 ?? "", 64).slice(0, 16)}.`,
    ...(request.note ? [`Note to the worker: ${displayText(request.note, 300)}`] : [])].join("\n");
}

export interface LocalAuthenticationGateOptions {
  /** An executable the workers cannot modify; it reads the reason on stdin. */
  helper: string;
  timeoutMs?: number;
}

/**
 * macOS LocalAuthentication through a helper the daemon runs itself: exit 0
 * is confirmed, 3 refused, anything else unavailable. The helper evaluates a
 * fresh context with no reuse, so no earlier confirmation answers this one.
 * Unproven until an attended acceptance; nothing enables it by default.
 */
export function localAuthenticationGate(options: LocalAuthenticationGateOptions): HumanGate {
  return {
    kind: "local-authentication",
    protectedPaths: [options.helper],
    confirm: (request, signal) => new Promise<GateResult>((resolve) => {
      if (signal.aborted) return resolve("refused");
      let settled = false;
      const settle = (result: GateResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const child = spawn(options.helper, [], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin" } });
      // An abort is a refusal, settled only once the helper and its dialog are gone.
      let refused = false;
      const onAbort = () => {
        if (refused) return;
        refused = true;
        try { child.kill("SIGTERM"); } catch { /* gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2_000).unref();
      };
      const timer = setTimeout(onAbort, options.timeoutMs ?? 120_000);
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => settle("unavailable"));
      child.on("exit", (code) => settle(refused ? "refused" : code === 0 ? "confirmed" : code === 3 ? "refused" : "unavailable"));
      child.stdin.on("error", () => {});
      child.stdin.end(gateReason(request));
    })
  };
}
