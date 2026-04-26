import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSystemProcessInspector,
  deriveHumanCliIdentity,
  isProtocolError,
  terminateKnownProcess
} from "../index.js";
import {
  parseRequiredInteger,
  requireStringOption,
  type ParsedCommand
} from "./parser.js";
import { createRuntime } from "./runtime.js";

const GUARD_READY = "READY";
const GUARD_READY_TIMEOUT_MS = 10_000;
const STALE_GUARD_ERRORS = new Set(["stale_lease", "turn_mismatch", "room_not_found"]);

export async function runGuardCommand(parsed: ParsedCommand): Promise<void> {
  const identity = deriveHumanCliIdentity({
    agentId: requireStringOption(parsed, "agent"),
    displayName: requireStringOption(parsed, "agent").replace(/^human:/, ""),
    sessionKind: "human_guardian"
  });
  const runtime = createRuntime();

  try {
    const joined = runtime.commands.joinPath(identity, {
      context_path: requireStringOption(parsed, "context-path")
    });

    const heartbeatInput = {
      room_id: requireStringOption(parsed, "room-id"),
      lease_id: requireStringOption(parsed, "lease-id"),
      expected_turn_id: parseRequiredInteger(parsed, "turn-id")
    };

    const intervalMs = joined.policy.heartbeatIntervalMs;

    process.stdout.write(`${GUARD_READY}\n`);
    const timer = setInterval(() => {
      try {
        runtime.commands.heartbeat(identity, heartbeatInput);
      } catch (error) {
        if (isProtocolError(error) && STALE_GUARD_ERRORS.has(error.code)) {
          process.exit(0);
        }
        process.exit(1);
      }
    }, intervalMs);

    const exit = () => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on("SIGINT", exit);
    process.on("SIGTERM", exit);

    await new Promise<void>(() => undefined);
  } finally {
    runtime.close();
  }
}

export async function spawnGuardian(input: {
  agentId: string;
  canonicalPath: string;
  roomId: string;
  leaseId: string;
  turnId: number;
  cliEntryUrl: string;
}): Promise<{ pid: number; process_started_at: string | null }> {
  const self = resolveSelfSpawn(input.cliEntryUrl);
  const child = spawn(
    self.command,
    [
      ...self.args,
      "guard",
      "--agent",
      input.agentId,
      "--context-path",
      input.canonicalPath,
      "--room-id",
      input.roomId,
      "--lease-id",
      input.leaseId,
      "--turn-id",
      String(input.turnId)
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  return await new Promise<{ pid: number; process_started_at: string | null }>(
    (resolve, reject) => {
      const inspector = createSystemProcessInspector();
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new Error("Guardian did not signal readiness in time."));
      }, GUARD_READY_TIMEOUT_MS);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (!stdout.includes(GUARD_READY)) {
          return;
        }

        clearTimeout(timeout);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        if (!child.pid) {
          reject(new Error("Guardian started without a PID."));
          return;
        }
        resolve({
          pid: child.pid,
          process_started_at: inspector.inspect(child.pid)?.startTime ?? null
        });
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Guardian exited before readiness (code ${code ?? "unknown"}): ${stderr.trim()}`
          )
        );
      });
    }
  );
}

function resolveSelfSpawn(cliEntryUrl: string): { command: string; args: string[] } {
  const scriptPath = fileURLToPath(cliEntryUrl);
  if (scriptPath.endsWith(".ts")) {
    const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    if (fs.existsSync(tsxBin)) {
      return { command: tsxBin, args: [scriptPath] };
    }
  }

  return { command: process.execPath, args: [scriptPath] };
}

export function stopGuardian(
  guardianPid?: number | null,
  guardianProcessStartedAt?: string | null
): void {
  if (!guardianPid) {
    return;
  }

  terminateKnownProcess(
    {
      pid: guardianPid,
      process_started_at: guardianProcessStartedAt ?? null
    },
    {
      inspector: createSystemProcessInspector()
    }
  );
}

export function checkGuardianLiveness(
  ref: { pid?: number | null; process_started_at?: string | null },
  inspector: { inspect: (pid: number) => { startTime: string | null } | null | undefined },
  platform: NodeJS.Platform = process.platform
): "alive" | "gone" | "unknown" {
  if (
    ref.pid === null ||
    ref.pid === undefined ||
    !ref.process_started_at ||
    ref.process_started_at.trim() === ""
  ) {
    return "unknown";
  }

  if (platform === "win32") {
    return "unknown";
  }

  const inspection = inspector.inspect(ref.pid);
  if (inspection === undefined) {
    return "unknown";
  }
  if (inspection === null || !inspection.startTime) {
    return "gone";
  }

  // Trim-normalized match mirrors the service-layer liveness checker: a live
  // pid with startTime drift is more likely the original process than a reuse.
  return inspection.startTime.trim() === ref.process_started_at.trim()
    ? "alive"
    : "unknown";
}
