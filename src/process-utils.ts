import { execFileSync } from "node:child_process";

export interface ProcessSignaler {
  kill(pid: number, signal: NodeJS.Signals): void;
}

export interface ProcessInspection {
  pid: number;
  ppid: number | null;
  startTime: string | null;
  command: string | null;
}

export interface ProcessInspector {
  inspect(pid: number): ProcessInspection | null | undefined;
}

export interface ExactProcessRef {
  pid: number | null | undefined;
  process_started_at: string | null | undefined;
}

export interface ProcessInspectorOptions {
  platform?: NodeJS.Platform;
  cacheTtlMs?: number;
  execFile?: (
    file: string,
    args: readonly string[],
    options: {
      encoding: "utf8";
      stdio: ["ignore", "pipe", "ignore"];
    }
  ) => string;
  processExists?: (pid: number) => boolean;
}

export function terminateKnownProcess(
  processRef: ExactProcessRef,
  options: {
    inspector: ProcessInspector;
    signaler?: ProcessSignaler;
    signal?: NodeJS.Signals;
  }
): boolean {
  if (
    processRef.pid === null ||
    processRef.pid === undefined ||
    processRef.process_started_at === null ||
    processRef.process_started_at === undefined ||
    processRef.process_started_at.trim() === ""
  ) {
    return false;
  }

  const inspection = options.inspector.inspect(processRef.pid);
  if (!inspection?.startTime) {
    return false;
  }

  if (inspection.startTime !== processRef.process_started_at) {
    return false;
  }

  try {
    (options.signaler ?? process).kill(
      processRef.pid,
      options.signal ?? "SIGTERM"
    );
    return true;
  } catch {
    return false;
  }
}

export function createSystemProcessInspector(
  options: ProcessInspectorOptions = {}
): ProcessInspector {
  const cache = new Map<
    number,
    {
      checked_at_ms: number;
      inspection: ProcessInspection | null | undefined;
    }
  >();
  const cacheTtlMs = options.cacheTtlMs ?? 0;

  return {
    inspect(pid: number): ProcessInspection | null | undefined {
      if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
      }

      const nowMs = Date.now();
      const cached = cache.get(pid);
      if (cached && nowMs - cached.checked_at_ms < cacheTtlMs) {
        return cached.inspection;
      }

      const inspection = inspectSystemProcess(pid, options);
      cache.set(pid, {
        checked_at_ms: nowMs,
        inspection
      });
      return inspection;
    }
  };
}

function inspectSystemProcess(
  pid: number,
  options: ProcessInspectorOptions
): ProcessInspection | null | undefined {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return undefined;
  }

  const exists = options.processExists ?? processExistsViaSignal;
  if (!exists(pid)) {
    return null;
  }

  try {
    const output = (options.execFile ?? defaultExecFile)(
      "ps",
      ["-o", "ppid=", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trimEnd();

    if (!output.trim()) {
      return null;
    }

    const match = output.trimStart().match(/^(\d+)\s+(.{24})\s+(.*)$/);
    if (!match) {
      // Fallback for cases where output might differ
      return null;
    }

    const ppid = parseInt(match[1], 10);
    const startTime = match[2].trim();
    const command = match[3].trim();

    return {
      pid,
      ppid: isNaN(ppid) ? null : ppid,
      startTime: startTime || null,
      command: command || null
    };
  } catch {
    return undefined;
  }
}

function processExistsViaSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
  }
): string {
  return execFileSync(file, args, options) as string;
}
