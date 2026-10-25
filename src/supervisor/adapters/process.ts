import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { createSystemProcessInspector } from "../../process-utils.js";
import type { SpawnedProcess, WorkerSpec } from "../adapter.js";

// An empty environment, with just HOME and PATH as native runtimes require
// them for authentication storage and executable lookup. Everything else is
// an explicit reference; supervisor_env wins over those references.
export async function workerEnvironment(spec: WorkerSpec, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { HOME: source.HOME ?? os.homedir(), PATH: source.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const ref of spec.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name) || isIdentityMarker(ref.name)) {
      throw new Error(`Worker environment cannot set identity marker ${ref.name}.`);
    }
    if (ref.from === "inherit") {
      if (source[ref.name] !== undefined) env[ref.name] = source[ref.name];
    } else if (ref.from === "literal") env[ref.name] = ref.value;
    else {
      if (process.platform !== "darwin") throw new Error("Keychain environment references require macOS.");
      env[ref.name] = await new Promise<string>((resolve, reject) => {
        execFile("/usr/bin/security", ["find-generic-password", "-s", ref.service, "-w"],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
            // Neither the credential nor security's raw error enters logs.
            if (error) reject(new Error(`Cannot resolve Keychain environment reference ${ref.name}.`));
            else resolve(stdout.replace(/\r?\n$/, ""));
          });
      });
    }
  }
  return Object.assign(env, spec.supervisor_env ?? {});
}

function isIdentityMarker(name: string): boolean {
  return name === "TT_ROOM" || name.startsWith("TT_HARNESS_") || name.startsWith("TT_SUPERVISOR_") ||
    name === "CODEX_THREAD_ID" || name === "CODEX_MANAGED_BY_NPM" || name === "CLAUDECODE" ||
    name.startsWith("CLAUDE_CODE_") || name === "CLAUDE_SESSION_ID" || name.startsWith("CMUX_") ||
    name.startsWith("HERDR_") || name === "GROK_AGENT" || name === "GROK_SESSION_ID" ||
    name === "GEMINI_CLI" || name.startsWith("ANTIGRAVITY_") || name === "OPENCODE";
}

/** Only a check performed before calling write may prove an input unsent. */
export class UnsentInputError extends Error {}

export interface ManagedProcess extends SpawnedProcess {
  write(line: string): Promise<void>;
  stop(graceMs: number): Promise<void>;
  alive(): boolean;
}

export interface ManagedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onSpawn(process: SpawnedProcess): void;
  onLine(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onOverflow(): void;
  maxLineBytes?: number;
}

/** No shell, no inherited stdio, and a process group owned by this child. */
export async function spawnManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcess> {
  if (process.platform === "win32") throw new Error("Managed process groups are not supported on Windows yet.");
  if (options.signal?.aborted) throw new Error("Worker start aborted.");
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env,
    detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  let stopping: Promise<void> | null = null;
  let overflowed = false;
  let identity: SpawnedProcess | undefined;
  child.stdin.on("error", () => {});
  child.stderr.resume(); // Drain diagnostics; never copy raw provider/credential errors into logs.
  const overflow = () => {
    if (overflowed) return;
    overflowed = true;
    options.onOverflow();
    void stop(100).catch(() => {});
  };
  readBoundedLines(child, options.maxLineBytes ?? 256 * 1024, options.onLine, overflow);
  const abort = () => { void stop(100).catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  child.once("exit", (code, signal) => {
    exited = true;
    options.signal?.removeEventListener("abort", abort);
    options.onExit(code, signal);
  });

  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (groupAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    // The group can outlive its leader: check it, rather than just child.exitCode.
    return !groupAlive();
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid || !groupAlive()) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  function stop(graceMs: number): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      child.stdin.end();
      if (await wait(Math.min(200, Math.max(0, graceMs)))) return;
      signalGroup("SIGTERM");
      if (await wait(Math.max(0, graceMs))) return;
      signalGroup("SIGKILL");
      if (!await wait(1_000)) throw new Error("Owned worker process group did not exit.");
    })();
    return stopping;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Cannot spawn the configured harness executable.")));
      child.once("spawn", () => {
        try {
          if (!child.pid) throw new Error("Spawned worker has no process id.");
          const start = createSystemProcessInspector().inspect(child.pid)?.startTime?.trim();
          if (!start) throw new Error("Cannot establish the owned worker's process identity.");
          // Synchronous ownership callback; no initialize or model input precedes it.
          options.onSpawn({ pid: child.pid, processStartedAt: start, pgid: child.pid });
          identity = { pid: child.pid, processStartedAt: start, pgid: child.pid };
          resolve();
        } catch (error) { reject(error); }
      });
    });
    if (options.signal?.aborted) throw new Error("Worker start aborted.");
    return { ...identity!, alive: () => !exited,
      write: (line) => {
        if (exited || child.stdin.destroyed || child.stdin.writableEnded ||
            child.stdin.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) {
          return Promise.reject(new UnsentInputError("Worker input was refused before writing."));
        }
        return new Promise<void>((resolve, reject) => {
          child.stdin.write(`${line}\n`, (error) => error ? reject(new Error("Worker input write is unconfirmed.")) : resolve());
        });
      }, stop };
  } catch (error) {
    await stop(100).catch(() => {});
    throw error;
  }
}

/** UTF-8 decoding is stream-aware; an oversized or partial EOF frame is fatal. */
function readBoundedLines(child: ChildProcessWithoutNullStreams, maxBytes: number,
  onLine: (line: string) => void, onOverflow: () => void): void {
  let buffered = "";
  let failed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (failed) return;
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (Buffer.byteLength(line) > maxBytes) { failed = true; onOverflow(); return; }
      if (line.trim()) {
        try { onLine(line); } catch { failed = true; onOverflow(); return; }
      }
    }
    if (Buffer.byteLength(buffered) > maxBytes) { failed = true; buffered = ""; onOverflow(); }
  });
  child.stdout.on("end", () => { if (!failed && buffered.trim()) { failed = true; onOverflow(); } });
}
