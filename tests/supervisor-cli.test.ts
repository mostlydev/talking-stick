import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { handleSupervisorCommand, parseEnvReference } from "../src/cli/supervisor-commands.js";
import type { ParsedCommand } from "../src/cli/parser.js";
import { TalkingStickService } from "../src/index.js";
import { SupervisorStore } from "../src/supervisor/state.js";
import { launchAgentPlist, installLaunchAgent, uninstallLaunchAgent } from "../src/supervisor/launchd.js";
import { rotateLog, runSupervisor, supervisorPaths, LOG_ROTATE_BYTES } from "../src/supervisor/run.js";
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
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  cleanup.push(() => write.mockRestore());
  const run = async (args: string[], options: Record<string, string | true> = {}, inside: string | null = null) => {
    const parsed: ParsedCommand = { name: "supervisor", positionals: args,
      options: new Map<string, string | true>([["json", true], ["agent", "human:op"], ...Object.entries(options)]) };
    if (options.agent === "none") parsed.options.delete("agent");
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

  test("never adopts a session another worker owns or one running outside the supervisor", async () => {
    const { dataDir, cwd, run } = setup();
    await run(["add", "w1"], { harness: "claude", cwd, resume: "native-1" });
    await expect(run(["add", "w2"], { harness: "claude", cwd, resume: "native-1" })).rejects.toThrow("already owns");
    const service = new TalkingStickService({ dataDir });
    cleanup.push(() => service.close());
    service.joinPath({ agent_id: "claude:live", context_path: cwd, process_metadata: { host_id: os.hostname(), pid: process.pid,
      process_started_at: "x", session_kind: "harness_cli", harness_name: "claude", harness_session_id: "harness:live-1",
      harness_host_id: os.hostname(), harness_pid: process.pid, harness_process_started_at: (await import("../src/process-utils.js")).getCurrentProcessStartedAt() ?? "" } });
    await expect(run(["add", "w3"], { harness: "claude", cwd, resume: "live-1" })).rejects.toThrow("never adopts a live session");
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
    expect(await run(["resume", "w1"], { agent: "claude:operator" })).toMatchObject({ desired: "running" });
    expect(await run(["restart", "w1"], { fresh: true })).toMatchObject({ fresh: true });
    expect(await run(["stop", "w1"])).toMatchObject({ desired: "stopped" });
    expect(store().auditRows("w1").map((row) => `${row.actor} ${row.action}`))
      .toEqual(["human:op add", "human:op pause", "claude:operator resume", "human:op restart_fresh", "human:op stop"]);
    expect(await run(["remove", "w1"])).toMatchObject({ status: "removed" });
    expect((await run(["status"])).workers).toEqual([]);
  });

  test("a running worker can't be removed", async () => {
    const { cwd, run } = setup();
    await run(["add", "w1"], { harness: "claude", cwd });
    await expect(run(["remove", "w1"])).rejects.toThrow("Stop w1 first");
  });

  test("approvals and reconcile are a human's, never an --agent override or a harness session", async () => {
    const { run } = setup();
    // The actor comes from this process's environment; run it as a plain shell would.
    for (const key of ["CLAUDECODE", "CODEX_THREAD_ID", "CODEX_MANAGED_BY_NPM", "GEMINI_CLI", "OPENCODE", "TT_HARNESS_AGENT_ID"]) vi.stubEnv(key, "");
    cleanup.push(() => { vi.unstubAllEnvs(); });
    await expect(run(["approve", "a1"])).rejects.toThrow("does not accept --agent");
    await expect(run(["approve", "a1"], { agent: "none" }, "claude")).rejects.toThrow("not a claude session");
    await expect(run(["reconcile", "batch"], { agent: "none", drop: true }, "codex")).rejects.toThrow("not a codex session");
    await expect(run(["reconcile", "batch"], { agent: "none" }, null)).rejects.toThrow("Choose --resend or --drop");
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
    const socket = supervisorPaths(dataDir).socket;
    expect(await sendControl(socket, { type: "control", action: "approve", actor: "claude:x", approval_id: approval.approval_id }))
      .toEqual({ ok: false, error: "Only a human can decide an approval." });
    expect(await sendControl(socket, { type: "control", action: "approve", actor: "human:op", approval_id: approval.approval_id }))
      .toEqual({ ok: true, result: { status: "allowed", answer: "delivered" } });
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "allow" }]);
    controller.abort();
    await running;
    expect(adapter.last.stopped).toBe(true);
    expect(opened.crashesSince("w1", "2000-01-01")).toBe(0);
    expect(fs.existsSync(supervisorPaths(dataDir).lock)).toBe(false);
    expect(lines.at(-1)).toBe("supervisor stopped");
  });

  test("rotates its log past the size limit", () => {
    const { root } = setup();
    const file = path.join(root, "daemon.log");
    fs.writeFileSync(file, "x".repeat(LOG_ROTATE_BYTES));
    rotateLog(file);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.statSync(`${file}.1`).size).toBe(LOG_ROTATE_BYTES);
  });
});

describe("launchd", () => {
  test("installs an owner-only user agent for one data directory, and uninstalls it", () => {
    const { root, dataDir } = setup();
    const plist = launchAgentPlist({ program: ["/usr/bin/node", "/opt/tt/cli.js", "supervisor", "run"], dataDir, logPath: "/tmp/d<1>.log" });
    expect(plist).toContain("<string>supervisor</string>");
    expect(plist).toContain(`<string>${dataDir}</string>`);
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("/tmp/d&lt;1&gt;.log");
    const calls: string[][] = [];
    const file = installLaunchAgent({ program: ["node", "cli.js", "supervisor", "run"], dataDir, logPath: path.join(root, "log", "d.log"),
      homeDir: root, launchctl: (args) => { calls.push(args); } });
    expect(fs.existsSync(file)).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["bootout", "bootstrap"]);
    expect(uninstallLaunchAgent({ homeDir: root, launchctl: (args) => { calls.push(args); } })).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});
