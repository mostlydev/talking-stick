import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSystemProcessInspector,
  deriveHumanCliIdentity,
  isProtocolError,
  terminateKnownProcess,
  type DerivedIdentity,
  type ExactProcessRef,
  type HeartbeatCommandInput,
  type ProcessMetadata,
  type ProcessInspector
} from "../index.js";
import {
  getStringOption,
  parseRequiredInteger,
  requireStringOption,
  type ParsedCommand
} from "./parser.js";
import { createRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";

const GUARD_READY = "READY";
const GUARD_READY_TIMEOUT_MS = 10_000;
const STALE_GUARD_ERRORS = new Set(["stale_lease", "turn_mismatch", "room_not_found"]);

export type GuardTickResult = "continue" | "exit_clean" | "exit_error";

export function runGuardTick(input: {
  runtime: Runtime;
  identity: DerivedIdentity;
  heartbeatInput: HeartbeatCommandInput;
  harnessRef: ExactProcessRef;
  inspector: ProcessInspector;
}): GuardTickResult {
  if (checkGuardianLiveness(input.harnessRef, input.inspector) === "gone") {
    try {
      const result = input.runtime.commands.relinquishOwnership(
        input.identity,
        input.heartbeatInput
      );
      if (result.status !== "retained") {
        return "exit_clean";
      }
    } catch {
      return "exit_clean";
    }
  }

  try {
    input.runtime.commands.heartbeat(input.identity, input.heartbeatInput);
    return "continue";
  } catch (error) {
    if (isProtocolError(error) && STALE_GUARD_ERRORS.has(error.code)) {
      return "exit_clean";
    }
    return "exit_error";
  }
}

export async function runGuardCommand(parsed: ParsedCommand): Promise<void> {
  const baseIdentity = deriveHumanCliIdentity({
    agentId: requireStringOption(parsed, "agent"),
    displayName: requireStringOption(parsed, "agent").replace(/^human:/, ""),
    sessionKind: "human_guardian"
  });
  const harnessMetadata = parseHarnessMetadataOptions(parsed);
  const identity = {
    ...baseIdentity,
    process_metadata: {
      ...baseIdentity.process_metadata,
      ...harnessMetadata
    }
  };
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

    const harnessRef = {
      pid: harnessMetadata.harness_pid,
      process_started_at: harnessMetadata.harness_process_started_at
    };
    const inspector = createSystemProcessInspector();

    process.stdout.write(`${GUARD_READY}\n`);
    const timer = setInterval(() => {
      const result = runGuardTick({
        runtime,
        identity,
        heartbeatInput,
        harnessRef,
        inspector
      });
      if (result === "exit_clean") {
        process.exit(0);
      }
      if (result === "exit_error") {
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
  processMetadata?: ProcessMetadata;
}): Promise<{ pid: number; process_started_at: string | null }> {
  const self = resolveSelfSpawn(input.cliEntryUrl);
  const harnessArgs = serializeHarnessMetadataOptions(input.processMetadata);
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
      String(input.turnId),
      ...harnessArgs
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
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners("exit");
        child.removeAllListeners("error");
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const killChild = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Best effort cleanup for a child that failed readiness.
        }
      };
      const rejectOnce = (error: Error, kill = false) => {
        if (settled) {
          return;
        }
        settled = true;
        if (kill) {
          killChild();
        }
        cleanup();
        reject(error);
      };
      const resolveOnce = (value: { pid: number; process_started_at: string | null }) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        child.unref();
        resolve(value);
      };
      const timeout = setTimeout(() => {
        rejectOnce(new Error("Guardian did not signal readiness in time."), true);
      }, GUARD_READY_TIMEOUT_MS);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (!stdout.includes(GUARD_READY)) {
          return;
        }

        if (!child.pid) {
          rejectOnce(new Error("Guardian started without a PID."), true);
          return;
        }
        resolveOnce({
          pid: child.pid,
          process_started_at: inspector.inspect(child.pid)?.startTime ?? null
        });
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("exit", (code) => {
        rejectOnce(
          new Error(
            `Guardian exited before readiness (code ${code ?? "unknown"}): ${stderr.trim()}`
          )
        );
      });
      child.on("error", (error) => {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      });
    }
  );
}

function parseHarnessMetadataOptions(parsed: ParsedCommand): ProcessMetadata {
  const harnessPid = getStringOption(parsed, "harness-pid");
  return {
    harness_name: getStringOption(parsed, "harness-name") ?? null,
    harness_session_id: getStringOption(parsed, "harness-session-id") ?? null,
    harness_host_id: getStringOption(parsed, "harness-host-id") ?? null,
    harness_pid: harnessPid ? Number.parseInt(harnessPid, 10) : null,
    harness_process_started_at:
      getStringOption(parsed, "harness-process-started-at") ?? null
  };
}

function serializeHarnessMetadataOptions(
  metadata: ProcessMetadata | undefined
): string[] {
  const args: string[] = [];
  appendOption(args, "harness-name", metadata?.harness_name);
  appendOption(args, "harness-session-id", metadata?.harness_session_id);
  appendOption(args, "harness-host-id", metadata?.harness_host_id);
  appendOption(
    args,
    "harness-pid",
    metadata?.harness_pid === null || metadata?.harness_pid === undefined
      ? null
      : String(metadata.harness_pid)
  );
  appendOption(
    args,
    "harness-process-started-at",
    metadata?.harness_process_started_at
  );
  return args;
}

function appendOption(
  args: string[],
  key: string,
  value: string | null | undefined
): void {
  if (!value) {
    return;
  }
  args.push(`--${key}`, value);
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
