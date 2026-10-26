import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { ClaudeAdapter, resolveClaudeExecutable } from "../src/supervisor/adapters/claude.js";
import type { WorkerEvent, WorkerHandle, WorkerSpec } from "../src/supervisor/adapter.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Protocol fixture did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(mode = "", overrides: Partial<WorkerSpec> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-adapter-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "trace.jsonl");
  const spec: WorkerSpec = { worker_id: "w1", harness: "claude", cwd: root, permissions: { harness: "claude", mode: "default" },
    env: [{ name: "FIXTURE_MODE", from: "literal", value: mode }, { name: "FIXTURE_TRACE", from: "literal", value: trace }],
    supervisor_env: { TALKING_STICK_DATA_DIR: path.join(root, "data"), TT_SUPERVISOR_ENDPOINT: "/tmp/test.sock#w1@1", TT_SUPERVISOR_TOKEN: "delivery" },
    ...overrides };
  const adapter = new ClaudeAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/claude-stream.cjs", import.meta.url))], requestTimeoutMs: 300, startTimeoutMs: 500 });
  const events: WorkerEvent[] = [];
  const start = async (): Promise<WorkerHandle> => {
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    handle.onEvent((event) => events.push(event));
    return handle;
  };
  const lines = () => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { root, spec, adapter, events, start, lines };
}

describe("starting a Claude worker", () => {
  test("runs stream-json with the stdio permission tool and its own session id, never a bypass", async () => {
    const f = fixture();
    const handle = await f.start();
    const argv = f.lines()[0].argv as string[];
    expect(argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--setting-sources", "project,local", "--strict-mcp-config", "--permission-prompt-tool", "stdio"]));
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
    const session = argv[argv.indexOf("--session-id") + 1];
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(handle.sessionId()).toBe(session);
    expect(f.events).toContainEqual({ type: "session", session_id: session });
    expect(argv.join(" ")).not.toMatch(/bypassPermissions|dangerously/);
  });

  test("resumes the recorded session instead of choosing a new one", async () => {
    const f = fixture("", { resume_session_id: "11111111-2222-3333-4444-555555555555" });
    const handle = await f.start();
    const argv = f.lines()[0].argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(argv).not.toContain("--session-id");
    expect(handle.sessionId()).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("the child's environment has the supervisor's values and no inherited identity", async () => {
    process.env.TT_ROOM = "/somewhere/else";
    cleanup.push(() => { delete process.env.TT_ROOM; });
    const f = fixture();
    await f.start();
    expect(f.lines()[0].env).toMatchObject({ TT_ROOM: null, TALKING_STICK_DATA_DIR: f.spec.supervisor_env!.TALKING_STICK_DATA_DIR,
      TT_SUPERVISOR_ENDPOINT: "/tmp/test.sock#w1@1" });
  });

  test("a handshake that never answers fails the start", async () => {
    await expect(fixture("hang-init").start()).rejects.toThrow("unconfirmed");
  });

  test("an executable is resolved to an absolute real path", () => {
    expect(() => resolveClaudeExecutable({ CLAUDE_EXECUTABLE: "claude" })).toThrow("absolute");
    expect(resolveClaudeExecutable({ CLAUDE_EXECUTABLE: process.execPath })).toBe(fs.realpathSync(process.execPath));
  });
});

describe("turns", () => {
  test("a prompt is written, starts a turn, and completes it; a steer or a second turn is refused", async () => {
    const f = fixture("slow");
    const handle = await f.start();
    expect(await handle.submit({ input_id: "i1", text: "hello", mode: "start_turn" })).toBe("written");
    await until(() => f.events.some((event) => event.type === "turn_started"));
    expect(f.events).toContainEqual({ type: "turn_started", native_turn_id: "i1", input_id: "i1" });
    expect(await handle.submit({ input_id: "i2", text: "again", mode: "start_turn" })).toBe("rejected");
    expect(await handle.submit({ input_id: "i3", text: "steer", mode: "steer" })).toBe("rejected");
    expect(f.lines().filter((line) => line.type === "user")).toHaveLength(1);
  });

  test("a completed turn reports success", async () => {
    const f = fixture();
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "hello", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "turn_completed"));
    expect(f.events).toContainEqual({ type: "turn_completed", native_turn_id: "i1", outcome: "success" });
  });

  test("an interrupt ends the running turn as interrupted", async () => {
    const f = fixture("slow");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "long", mode: "start_turn" });
    expect(await handle.interrupt()).toBe("interrupted");
    expect(f.events).toContainEqual({ type: "turn_completed", native_turn_id: "i1", outcome: "interrupted" });
    expect(await handle.interrupt()).toBe("not_busy");
  });

  test("a login failure is shown as auth_required", async () => {
    const f = fixture("auth");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "hello", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "state"));
    expect(f.events).toContainEqual({ type: "state", state: "auth_required" });
  });
});

describe("approvals", () => {
  test.each(["allow", "deny"] as const)("a tool prompt is a pending approval, and %s answers that request once", async (decision) => {
    const f = fixture("approval");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "make x", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "approval_requested"));
    expect(f.events).toContainEqual({ type: "approval_requested", native_request_id: "perm-1", tool: "Bash", summary: "touch x",
      detail: JSON.stringify({ tool_name: "Bash", input: { command: "touch x", description: "Create x" } }, null, 2) });
    await handle.answerApproval("perm-1", decision);
    await until(() => f.lines().some((line) => line.type === "control_response"));
    const answer = f.lines().find((line) => line.type === "control_response");
    expect(answer.response).toMatchObject({ subtype: "success", request_id: "perm-1",
      response: decision === "allow" ? { behavior: "allow", updatedInput: { command: "touch x", description: "Create x" } } : { behavior: "deny" } });
    await expect(handle.answerApproval("perm-1", decision)).rejects.toThrow("no longer pending");
  });

  test("the approval keeps the whole request, invisible characters escaped, beyond its short summary", async () => {
    const f = fixture("long-approval");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "make x", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "approval_requested"));
    const request = f.events.find((event) => event.type === "approval_requested") as Extract<WorkerEvent, { type: "approval_requested" }>;
    expect(request.summary.length).toBeLessThanOrEqual(350);
    expect(request.summary).not.toContain("rm -rf");
    expect(request.detail).toContain("\\u202e; rm -rf ./build");
    expect(request.detail).not.toContain("\u202e");
    const command = `echo ${"x".repeat(2000)} \u202e; rm -rf ./build`;
    expect(JSON.parse(request.detail)).toEqual({ tool_name: "Bash", input: { command, description: "Create x" } });
    // What a human reads is what an allow sends back.
    await handle.answerApproval("perm-1", "allow");
    await until(() => f.lines().some((line) => line.type === "control_response"));
    expect(f.lines().find((line) => line.type === "control_response").response.response.updatedInput.command).toBe(command);
  });

  test("a request too large to review is denied natively and never pending", async () => {
    const f = fixture("huge-approval");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "make x", mode: "start_turn" });
    await until(() => f.lines().some((line) => line.type === "control_response"));
    expect(f.lines().find((line) => line.type === "control_response").response).toMatchObject({ subtype: "success",
      request_id: "perm-1", response: { behavior: "deny" } });
    expect(f.events).toContainEqual({ type: "request_refused", method: "can_use_tool" });
    expect(f.events.some((event) => event.type === "approval_requested")).toBe(false);
    await expect(handle.answerApproval("perm-1", "allow")).rejects.toThrow("no longer pending");
  });

  test("a prompt the harness cancels is resolved, and can't be answered", async () => {
    const f = fixture("cancel");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "make x", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "approval_resolved"));
    expect(f.events).toContainEqual({ type: "approval_resolved", native_request_id: "perm-1" });
    await expect(handle.answerApproval("perm-1", "allow")).rejects.toThrow("no longer pending");
  });

  test("any other control request is refused at once", async () => {
    const f = fixture("unsupported");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "x", mode: "start_turn" });
    await until(() => f.lines().some((line) => line.type === "control_response" && line.response.request_id === "hook-1"));
    expect(f.events).toContainEqual({ type: "request_refused", method: "hook_callback" });
    expect(f.lines().find((line) => line.response?.request_id === "hook-1").response.subtype).toBe("error");
  });
});

// Codex's review of #212 (#32748).
describe("review regressions", () => {
  test("an uncertain user write fences the turn instead of accepting a second input", async () => {
    const f = fixture("slow");
    const handle = await f.start();
    const child = (handle as unknown as { child: { write(line: string): Promise<void> } }).child;
    const write = child.write.bind(child);
    child.write = async (line) => { await write(line); throw new Error("write may have reached Claude"); };
    expect(await handle.submit({ input_id: "unknown-first", text: "first", mode: "start_turn" })).toBe("uncertain");
    child.write = write;
    expect(await handle.submit({ input_id: "second", text: "second", mode: "start_turn" })).toBe("rejected");
  });

  test("a refused interrupt does not relabel an unrelated failure as interrupted", async () => {
    const f = fixture("interrupt-rejected");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "long", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "turn_started"));
    expect(await handle.interrupt()).toBe("unsupported");
    (handle as unknown as { receive(line: string): void }).receive(JSON.stringify({ type: "result", subtype: "error_during_execution",
      is_error: true, terminal_reason: "aborted_streaming", session_id: handle.sessionId(), errors: ["provider unavailable"] }));
    expect(f.events).toContainEqual({ type: "turn_completed", native_turn_id: "i1", outcome: "error" });
  });

  test("a failed turn is not called interrupted without Claude's aborted-stream result", async () => {
    const f = fixture("slow");
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "long", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "turn_started"));
    const interrupted = handle.interrupt();
    (handle as unknown as { receive(line: string): void }).receive(JSON.stringify({ type: "result", subtype: "error_during_execution",
      is_error: true, session_id: handle.sessionId(), errors: ["provider unavailable"] }));
    expect(await interrupted).toBe("unsupported");
    expect(f.events).toContainEqual({ type: "turn_completed", native_turn_id: "i1", outcome: "error" });
  });

  test.each(["foreign-session", "foreign-result"])("a %s holds the worker and never completes its input", async (mode) => {
    const f = fixture(mode);
    const handle = await f.start();
    await handle.submit({ input_id: "i1", text: "x", mode: "start_turn" });
    await until(() => f.events.some((event) => event.type === "protocol_error"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.events.some((event) => event.type === "turn_completed")).toBe(false);
  });
});

test("the supervisor enrols a fresh Claude worker with one bootstrap turn", async () => {
  const f = fixture();
  const store = new SupervisorStore(supervisorDatabasePath(f.root));
  cleanup.push(() => store.close());
  store.addWorker(f.spec, "human:test", "t");
  const bridge = { fence() {}, recover: () => ({ recovered: [], refused: [] }), sessionStarted() {}, lostSessions: () => [] };
  const supervisor = new Supervisor({ store, adapters: { claude: f.adapter }, processLiveness: () => "alive", bridge,
    socketPath: path.join(f.root, "intake.sock"), dataDir: path.join(f.root, "data"), bootstrap: true });
  cleanup.push(() => supervisor.shutdown());
  supervisor.reconcileStartup();
  await supervisor.tick();
  await until(() => !!store.db.prepare("SELECT 1 FROM inputs WHERE source = 'bootstrap' AND state = 'completed'").get());
  await supervisor.tick();
  const prompts = fs.readFileSync(path.join(f.root, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((line) => line.type === "user");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].message.content).toContain("tt join --json");
});
