import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleSupervisorCommand, parseEnvReference } from "../src/cli/supervisor-commands.js";
import type { ParsedCommand } from "../src/cli/parser.js";
import { TalkingStickService } from "../src/index.js";
import { SupervisorStore } from "../src/supervisor/state.js";
import { launchAgentPlist, installLaunchAgent, supervisorProgram, uninstallLaunchAgent } from "../src/supervisor/launchd.js";
import { createFileLog, rotateLog, runSupervisor, supervisorPaths, LOG_ROTATE_BYTES } from "../src/supervisor/run.js";
import { sendControl } from "../src/supervisor/intake.js";
import { FakeAdapter } from "./fixtures/supervisor-fake.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-svcli-"));
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const previous = process.env.TALKING_STICK_DATA_DIR;
  process.env.TALKING_STICK_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.TALKING_STICK_DATA_DIR;
    else process.env.TALKING_STICK_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  // Run as a plain shell would: no harness in the environment, so the actor is human:<user>.
  for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM", "GEMINI_CLI", "OPENCODE", "TT_HARNESS_AGENT_ID"]) vi.stubEnv(key, "");
  cleanup.push(() => { vi.unstubAllEnvs(); });
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  cleanup.push(() => write.mockRestore());
  const run = async (args: string[], options: Record<string, string | true> = {}, inside: string | null = null) => {
    const parsed: ParsedCommand = { name: "supervisor", positionals: args,
      options: new Map<string, string | true>([["json", true], ...Object.entries(options)]) };
    output.length = 0;
    await handleSupervisorCommand(parsed, { insideHarness: () => inside });
    return output.length ? JSON.parse(output.join("")) : null;
  };
  const store = () => {
    const opened = new SupervisorStore(supervisorPaths(dataDir).database);
    cleanup.push(() => opened.close());
    return opened;
  };
  return { root, dataDir, cwd, run, store };
}

describe("tt supervisor add", () => {
  test("records explicit permissions and environment references, never values it wasn't given", async () => {
    const { cwd, run, store } = setup();
    expect(await run(["add", "w1"], { harness: "codex", cwd, sandbox: "workspace-write", approval: "on-request",
      env: "PATH\0API_KEY=keychain:tt-worker\0MODE=literal:fast" })).toMatchObject({ status: "added", worker: "w1", desired: "running" });
    const spec = JSON.parse(store().worker("w1")!.spec_json);
    expect(spec.permissions).toEqual({ harness: "codex", sandbox: "workspace-write", approval: "on-request" });
    expect(spec.env).toEqual([{ name: "PATH", from: "inherit" }, { name: "API_KEY", from: "keychain", service: "tt-worker" },
      { name: "MODE", from: "literal", value: "fast" }]);
  });

  test.each([
    [{ harness: "gemini" }, "--harness must be"],
    [{ harness: "claude", cwd: "relative" }, "--cwd must be"],
    [{ harness: "claude", "permission-mode": "bypassPermissions" }, "never bypasses"],
    [{ harness: "codex" }, "needs --sandbox"],
    [{ harness: "codex", sandbox: "danger-full-access", approval: "never" }, "needs --sandbox"],
    [{ harness: "grok", "permission-mode": "plan" }, "takes no permission settings"],
    [{ harness: "claude", env: "TT_SUPERVISOR_TOKEN" }, "set by the supervisor"],
    [{ harness: "claude", env: "SECRET=hunter2" }, "keychain:SERVICE or literal:VALUE"]
  ] as Array<[Record<string, string>, string]>)("refuses %o", async (options, message) => {
    const { cwd, run } = setup();
    await expect(run(["add", "w1"], { cwd, ...options })).rejects.toThrow(message);
  });

  test("never imports an existing native session", async () => {
    const { cwd, run } = setup();
    await expect(run(["add", "w1"], { harness: "grok", cwd, resume: "live-grok-session" })).rejects.toThrow("--resume is not supported");
  });

  test("parses environment references strictly", () => {
    expect(parseEnvReference("HOME")).toEqual({ name: "HOME", from: "inherit" });
    expect(() => parseEnvReference("1BAD")).toThrow("not an environment variable name");
  });
});

describe("controls", () => {
  test("pause, resume, restart and stop change the desired state and are audited by actor", async () => {
    const { cwd, run, store } = setup();
    await run(["add", "w1"], { harness: "claude", cwd });
    expect(await run(["pause", "w1"])).toMatchObject({ desired: "paused" });
    expect(await run(["resume", "w1"])).toMatchObject({ desired: "running" });
    expect(await run(["restart", "w1"], { fresh: true })).toMatchObject({ fresh: true });
    expect(await run(["stop", "w1"])).toMatchObject({ desired: "stopped" });
    const audit = store().auditRows("w1");
    expect(audit.map((row) => row.action)).toEqual(["add", "pause", "resume", "restart_fresh", "stop"]);
    expect(audit.every((row) => row.actor.startsWith("human:"))).toBe(true);
    expect(await run(["remove", "w1"])).toMatchObject({ status: "removed" });
    expect((await run(["status"])).workers).toEqual([]);
  });

  test("an agent may read the supervisor but change nothing until a scoped operator policy exists", async () => {
    const { cwd, run } = setup();
    await run(["add", "w1"], { harness: "claude", cwd });
    expect((await run(["status"], {}, "codex")).workers).toHaveLength(1);
    expect(await run(["approvals"], {}, "codex")).toEqual({ pending_approvals: [] });
    for (const args of [["pause", "w1"], ["stop", "w1"], ["restart", "w1"], ["add", "w2"], ["install"], ["interrupt", "w1"]]) {
      await expect(run(args, { harness: "claude", cwd }, "codex")).rejects.toThrow("not a codex session");
    }
  });

  test("a running worker can't be removed", async () => {
    const { cwd, run } = setup();
    await run(["add", "w1"], { harness: "claude", cwd });
    await expect(run(["remove", "w1"])).rejects.toThrow("Stop w1 first");
  });

  test("approvals and reconcile are a human's, never an --agent override or a harness session", async () => {
    const { run } = setup();
    await expect(run(["approve", "a1"], { agent: "human:op" })).rejects.toThrow("does not accept --agent");
    await expect(run(["approve", "a1"], {}, "claude")).rejects.toThrow("not a claude session");
    await expect(run(["reconcile", "batch"], { drop: true }, "codex")).rejects.toThrow("not a codex session");
    await expect(run(["reconcile", "batch"], {}, null)).rejects.toThrow("Choose --resend or --drop");
    await expect(run(["approve", "a1"], {}, null)).rejects.toThrow("No supervisor is running");
  });
});

describe("the daemon", () => {
  test("runs one owner, answers control requests, and stops its workers when it stops", async () => {
    const { dataDir, cwd, store } = setup();
    const adapter = new FakeAdapter("claude");
    const controller = new AbortController();
    const lines: string[] = [];
    const opened = store();
    opened.addWorker({ worker_id: "w1", harness: "claude", cwd, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    const running = runSupervisor({ dataDir, adapters: { claude: adapter }, signal: controller.signal, tickIntervalMs: 20,
      log: (line) => lines.push(line), processLiveness: () => "alive" });
    const deadline = Date.now() + 3_000;
    while (!adapter.handles.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(adapter.handles).toHaveLength(1);
    await expect(runSupervisor({ dataDir, adapters: {}, processLiveness: () => "alive" })).rejects.toThrow("Another supervisor");
    adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "Bash", summary: "touch x" });
    const approval = opened.pendingApproval("w1", 1, "0")!;
    const paths = supervisorPaths(dataDir);
    const token = fs.readFileSync(paths.controlToken, "utf8");
    if (process.platform !== "win32") expect(fs.statSync(paths.controlToken).mode & 0o777).toBe(0o600);
    // The intake socket a worker is given takes no control at all.
    expect(await sendControl(paths.socket, { type: "control", action: "approve", actor: "human:op", token, approval_id: approval.approval_id }))
      .toEqual({ ok: false, error: "This socket takes no control requests." });
    // A forged human, or a worker's delivery token, is not control authority.
    const delivery = adapter.last.spec.supervisor_env?.TT_SUPERVISOR_TOKEN ?? "none";
    for (const forged of ["", delivery, "x".repeat(token.length)]) {
      expect(await sendControl(paths.control, { type: "control", action: "approve", actor: "human:op", token: forged, approval_id: approval.approval_id }))
        .toEqual({ ok: false, error: "This control request is not authorized." });
    }
    expect(await sendControl(paths.control, { type: "control", action: "approve", actor: "claude:x", token, approval_id: approval.approval_id }))
      .toEqual({ ok: false, error: "Only a human can decide an approval." });
    expect(await sendControl(paths.control, { type: "control", action: "approve", actor: "human:op", token, approval_id: approval.approval_id }))
      .toEqual({ ok: true, result: { status: "allowed", answer: "delivered" } });
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "allow" }]);
    controller.abort();
    await running;
    expect(adapter.last.stopped).toBe(true);
    expect(opened.crashesSince("w1", "2000-01-01")).toBe(0);
    expect(fs.existsSync(supervisorPaths(dataDir).lock)).toBe(false);
    expect(fs.existsSync(supervisorPaths(dataDir).controlToken)).toBe(false);
    expect(lines.at(-1)).toBe("supervisor stopped");
  });

  test("its own log rotates while it keeps writing, and stays private and bounded", () => {
    const { root } = setup();
    const file = path.join(root, "logs", "daemon.log");
    const log = createFileLog(file, 200);
    for (let i = 0; i < 40; i++) log(`line ${i} ${"x".repeat(20)}`);
    const sizes = [file, `${file}.1`, `${file}.2`, `${file}.3`].map((name) => fs.existsSync(name) ? fs.statSync(name).size : 0);
    expect(Math.max(...sizes)).toBeLessThan(200 + 60);
    expect(fs.existsSync(`${file}.4`)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toContain("line 39");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    rotateLog(path.join(root, "absent.log"));
    expect(LOG_ROTATE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("launchd", () => {
  test("runs node with cli.js, a compiled binary on its own, and an installed release through current", () => {
    expect(supervisorProgram({ standalone: false, execPath: "/usr/bin/node", cliEntry: "/pkg/dist/cli.js", releaseRoot: null }))
      .toEqual(["/usr/bin/node", "/pkg/dist/cli.js", "supervisor", "run"]);
    expect(supervisorProgram({ standalone: true, execPath: "/tmp/x/tt", cliEntry: "/$bunfs/root/cli.js", releaseRoot: null }))
      .toEqual(["/tmp/x/tt", "supervisor", "run"]);
    expect(supervisorProgram({ standalone: true, execPath: "/home/u/.local/share/tt/releases/tt-0.33.0-a/tt",
      cliEntry: "/$bunfs/root/cli.js", releaseRoot: "/home/u/.local/share/tt/releases/tt-0.33.0-a" }))
      .toEqual(["/home/u/.local/share/tt/current/tt", "supervisor", "run"]);
  });

  test("installs an owner-only user agent for one data directory, and uninstalls it", () => {
    const { root, dataDir } = setup();
    const plist = launchAgentPlist({ program: ["/usr/bin/node", "/opt/tt/cli.js", "supervisor", "run"], dataDir, logPath: "/tmp/d<1>.log" });
    expect(plist).toContain("<string>supervisor</string>");
    expect(plist).toContain(`<string>${dataDir}</string>`);
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("/tmp/d&lt;1&gt;.log");
    const calls: string[][] = [];
    expect(() => installLaunchAgent({ program: [path.join(root, "missing-tt"), "supervisor", "run"], dataDir,
      logPath: path.join(root, "log", "d.log"), homeDir: root, launchctl: () => {} })).toThrow("does not exist");
    expect(() => installLaunchAgent({ program: [process.execPath, "/$bunfs/root/cli.js", "supervisor", "run"], dataDir,
      logPath: path.join(root, "log", "d.log"), homeDir: root, launchctl: () => {} })).toThrow("does not exist");
    const entry = path.join(root, "cli.js");
    fs.writeFileSync(entry, "");
    const file = installLaunchAgent({ program: [process.execPath, entry, "supervisor", "run"], dataDir, logPath: path.join(root, "log", "d.log"),
      homeDir: root, launchctl: (args) => { calls.push(args); } });
    expect(fs.existsSync(file)).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
    expect(uninstallLaunchAgent({ homeDir: root, launchctl: (args) => { calls.push(args); } })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});

// Codex's review of #207 (#32543, #32544).
describe("control authority", () => {
  test("an ordinary harness cannot mutate supervisor workers", async () => {
    const { cwd, run, store } = setup();
    store().addWorker({ worker_id: "w1", harness: "claude", cwd, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    await expect(run(["stop", "w1"], { agent: "codex:ordinary" }, "codex")).rejects.toThrow();
    expect(store().worker("w1")!.desired).toBe("running");
  });

  test("a forged human actor with only a delivery token cannot approve, on either socket", async () => {
    const { dataDir, cwd, store } = setup();
    const opened = store();
    const adapter = new FakeAdapter("claude");
    const controller = new AbortController();
    opened.addWorker({ worker_id: "w1", harness: "claude", cwd, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
    const running = runSupervisor({ dataDir, adapters: { claude: adapter }, signal: controller.signal, tickIntervalMs: 20,
      log: () => {}, processLiveness: () => "alive" });
    try {
      const deadline = Date.now() + 3_000;
      while (!adapter.handles.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      adapter.last.emit({ type: "approval_requested", native_request_id: "0", tool: "shell", summary: "human decision required" });
      const approval = opened.pendingApproval("w1", 1, "0")!;
      const paths = supervisorPaths(dataDir);
      for (const socket of [paths.socket, paths.control]) {
        const answer = await sendControl(socket, { type: "control", action: "approve", actor: "human:forged",
          approval_id: approval.approval_id, token: adapter.last.spec.supervisor_env?.TT_SUPERVISOR_TOKEN ?? "" });
        expect(answer.ok).toBe(false);
      }
      expect(adapter.last.answers).toHaveLength(0);
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("a startup failure after taking ownership releases it and closes everything", async () => {
  const { dataDir } = setup();
  const paths = supervisorPaths(dataDir);
  fs.mkdirSync(paths.socket, { recursive: true });
  await expect(runSupervisor({ dataDir, adapters: {}, processLiveness: () => "alive", log: () => {} })).rejects.toThrow();
  expect(fs.existsSync(paths.lock)).toBe(false);
  expect(fs.existsSync(paths.controlToken)).toBe(false);
  expect(process.listenerCount("SIGTERM")).toBe(0);
});

test("every worker gets the supervisor's data directory; only prompt-capable ones get an endpoint", async () => {
  const { dataDir, cwd, store } = setup();
  const opened = store();
  const prompt = new FakeAdapter("claude");
  const silent = new FakeAdapter("grok");
  silent.caps = { prompt: false, resume: false, interrupt: false, approvals: false };
  opened.addWorker({ worker_id: "w1", harness: "claude", cwd, permissions: { harness: "claude", mode: "default" }, env: [] }, "human:op", "t");
  opened.addWorker({ worker_id: "g1", harness: "grok", cwd, permissions: { harness: "grok" }, env: [] }, "human:op", "t");
  const controller = new AbortController();
  const running = runSupervisor({ dataDir, adapters: { claude: prompt, grok: silent }, signal: controller.signal, tickIntervalMs: 20,
    log: () => {}, processLiveness: () => "alive" });
  try {
    const deadline = Date.now() + 3_000;
    while ((!prompt.handles.length || !silent.handles.length) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prompt.last.spec.supervisor_env).toMatchObject({ TALKING_STICK_DATA_DIR: dataDir });
    expect(prompt.last.spec.supervisor_env?.TT_SUPERVISOR_TOKEN).toBeTruthy();
    expect(silent.last.spec.supervisor_env).toEqual({ TALKING_STICK_DATA_DIR: dataDir });
  } finally {
    controller.abort();
    await running;
  }
});
