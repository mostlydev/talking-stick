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
      env?: NodeJS.ProcessEnv;
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
  if ((options.platform ?? process.platform) === "win32") {
    return createWindowsProcessInspector(options);
  }
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
        checked_at_ms: Date.now(),
        inspection
      });
      return inspection;
    }
  };
}

export function getCurrentProcessStartedAt(
  inspector: ProcessInspector = createSystemProcessInspector()
): string {
  return (
    inspector.inspect(process.pid)?.startTime ??
    new Date(Date.now() - process.uptime() * 1_000).toISOString()
  );
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
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          LC_ALL: "C"
        }
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

// A single snapshot supplies the whole ancestry walk without one shell per PID.
const windowsSnapshot: { processes?: Map<number, ProcessInspection>; checkedAt: number } = { checkedAt: -Infinity };

function createWindowsProcessInspector(options: ProcessInspectorOptions): ProcessInspector {
  // Identity and service liveness create separate inspectors in the same CLI.
  // Share their native probe, but keep injected test probes entirely isolated.
  const snapshot = options.execFile || options.processExists
    ? { processes: undefined as Map<number, ProcessInspection> | undefined, checkedAt: -Infinity }
    : windowsSnapshot;
  const ttl = options.cacheTtlMs ?? 5_000;
  return {
    inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
      if (!(options.processExists ?? processExistsViaSignal)(pid)) return null;
      if (Date.now() - snapshot.checkedAt >= ttl) {
        snapshot.processes = undefined;
        try {
          const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
            "@(Get-CimInstance Win32_Process | ForEach-Object { " +
            "@{pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; " +
            "startTime=if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}; " +
            "command=$_.CommandLine} }) | ConvertTo-Json -Compress";
          const output = (options.execFile ?? defaultExecFile)("powershell.exe",
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
          if (!Array.isArray(rows)) throw new Error("Invalid process snapshot");
          const parsed = new Map<number, ProcessInspection>();
          for (const row of rows) {
            if (!row || typeof row !== "object" || !Number.isSafeInteger(row.pid) ||
                !Number.isSafeInteger(row.ppid) || typeof row.startTime !== "string" ||
                !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(row.startTime)) continue;
            parsed.set(row.pid, { pid: row.pid, ppid: row.ppid, startTime: row.startTime,
              command: typeof row.command === "string" ? row.command : null });
          }
          snapshot.processes = parsed;
        } catch {
          // Access denied, timeout and malformed output are unknown, not gone.
        }
        snapshot.checkedAt = Date.now();
      }
      // A live PID absent from a cached snapshot may have just started.
      return snapshot.processes?.get(pid);
    }
  };
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
    env?: NodeJS.ProcessEnv;
  }
): string {
  // A stalled process probe must not hold a caller (possibly a writer) forever.
  return execFileSync(file, args, { ...options, windowsHide: true,
    timeout: file === "powershell.exe" ? 5_000 : 1_000 }) as string;
}
