import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkerEvent, WorkerSpec } from "../src/supervisor/adapter.js";
import { builtinAdapters } from "../src/supervisor/adapters/index.js";
import { AgyAdapter, resolveAgyExecutable } from "../src/supervisor/adapters/agy.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Protocol fixture did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(resume?: string, conversation?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-agy-adapter-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "trace.jsonl");
  const spec: WorkerSpec = {
    worker_id: "w1", harness: "agy", cwd: root, permissions: { harness: "agy" },
    resume_session_id: resume,
    env: [{ name: "FIXTURE_TRACE", from: "literal", value: trace },
      ...(conversation ? [{ name: "FIXTURE_CONVERSATION", from: "literal" as const, value: conversation }] : [])],
    supervisor_env: { TALKING_STICK_DATA_DIR: path.join(root, "data") },
    state_dir: path.join(root, "state")
  };
  const adapter = new AgyAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/agy-stdio.cjs", import.meta.url))], startTimeoutMs: 500 });
  const events: WorkerEvent[] = [];
  return { trace, spec, adapter, events, lines() {
    return fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
  } };
}

describe("agy capabilities", () => {
  test("prompt and resume are proven, and approvals stay false", () => {
    const adapter = new AgyAdapter();
    expect(adapter.capabilities()).toEqual({ prompt: true, resume: true, interrupt: false, approvals: false });
    expect(builtinAdapters().agy?.harness).toBe("agy");
  });

  test("an executable is resolved to an absolute real path", () => {
    expect(() => resolveAgyExecutable({ AGY_EXECUTABLE: "agy" })).toThrow("absolute");
    expect(resolveAgyExecutable({ AGY_EXECUTABLE: process.execPath })).toBe(fs.realpathSync(process.execPath));
    expect(() => resolveAgyExecutable({ PATH: "" })).toThrow("AGY_EXECUTABLE");
  });
});

describe("an agy worker", () => {
  test("starts without --print and delivers two turns without a control response", async () => {
    const { trace, spec, adapter, events, lines } = fixture();
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    handle.onEvent((event) => events.push(event));
    expect(handle.sessionId()).toBe("conv-1");
    expect(await handle.submit({ input_id: "in-1", text: "one", mode: "start_turn" })).toBe("accepted");
    await until(() => events.some((event) => event.type === "state" && event.state === "idle" && events.some((item) => item.type === "turn_completed")));
    expect(await handle.submit({ input_id: "in-2", text: "two", mode: "start_turn" })).toBe("accepted");
    await until(() => events.filter((event) => event.type === "turn_completed").length === 2);
    const argv = lines()[0]?.argv as string[];
    expect(argv).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
    expect(argv).not.toContain("--print");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(lines().some((line) => line.event === "control_response")).toBe(false);
    expect(events.filter((event) => event.type === "turn_completed").map((event) => event.type === "turn_completed" ? event.outcome : "")).toEqual(["success", "success"]);
    expect(fs.existsSync(trace)).toBe(true);
  });

  test("resume passes --conversation and rejects a different id", async () => {
    const { spec, adapter } = fixture("conv-1");
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    expect(handle.sessionId()).toBe("conv-1");
    const other = fixture("other", "conv-1");
    await expect(other.adapter.start(other.spec, 1, () => {})).rejects.toThrow("another conversation");
  });
});
