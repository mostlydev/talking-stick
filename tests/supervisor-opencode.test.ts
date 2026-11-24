import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkerEvent } from "../src/supervisor/adapter.js";
import { OpencodeWorkerHandle, parseAnnouncedUrl, SseParser, startOpencodeWorker,
  type OpencodeStartOptions } from "../src/supervisor/adapters/opencode-worker.js";

const fixture = path.resolve("tests/fixtures/fake-opencode-serve.mjs");
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function start(env: Record<string, string> = {}, options: Partial<OpencodeStartOptions> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-opencode-worker-")));
  const log = path.join(dir, "requests.jsonl");
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned: number[] = [];
  const events: WorkerEvent[] = [];
  const handle = await startOpencodeWorker({
    command: process.execPath, argsPrefix: [fixture], cwd: dir, generation: 1,
    env: { PATH: process.env.PATH, FAKE_OPENCODE_LOG: log, ...env },
    onSpawn: (child) => { spawned.push(child.pgid); },
    startTimeoutMs: 5_000, ...options
  });
  cleanup.push(() => handle.stop(500));
  handle.onEvent((event) => events.push(event));
  const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out; events: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { handle, events, requests, until, spawned, dir };
}

describe("OpenCode worker transport", () => {
  test("starts a private loopback server in its own group and opens a conversation with the given settings", async () => {
    const { handle, events, requests, spawned, dir } = await start({}, {
      session: { permissions: [{ action: "*", resource: "*", effect: "allow" }], model: { providerID: "anthropic", id: "claude-sonnet" } }
    });
    expect(spawned).toEqual([handle.pgid]);
    expect(handle.pgid).toBe(handle.pid);
    expect(handle.sessionId()).toBe("ses_fake1");
    expect(events).toContainEqual({ type: "session", session_id: "ses_fake1" });
    const log = requests();
    expect(log[0].argv).toEqual(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(log.filter((entry) => entry.method)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/api/event", authorized: true }),
      expect.objectContaining({ method: "POST", path: "/api/session", authorized: true, body: {
        location: { directory: dir },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        model: { providerID: "anthropic", id: "claude-sonnet" }
      } })
    ]));
    // The event stream opened before the conversation, so none of its events are missed.
    const order = log.filter((entry) => entry.method).map((entry) => `${entry.method} ${entry.path}`);
    expect(order.indexOf("GET /api/event")).toBeLessThan(order.indexOf("POST /api/session"));
    expect(handle.password).toMatch(/^[0-9a-f]{48}$/);
  });

  test("one prompt is written, starts a turn on its exact inbox item and completes; a second is refused meanwhile", async () => {
    const { handle, events, until, requests } = await start();
    expect(await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" })).toBe("written");
    expect(await handle.submit({ input_id: "in2", text: "again", mode: "start_turn" })).toBe("rejected");
    expect(await handle.submit({ input_id: "in3", text: "steer", mode: "steer" })).toBe("rejected");
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(events.filter((event) => event.type.startsWith("turn_"))).toEqual([
      { type: "turn_started", native_turn_id: "inbox_1", input_id: "in1" },
      { type: "turn_completed", native_turn_id: "inbox_1", outcome: "success" }
    ]);
    expect(requests().find((entry) => entry.path === "/api/session/ses_fake1/prompt")?.body).toEqual({ text: "hello", delivery: "queue" });
    expect(await handle.submit({ input_id: "in4", text: "next", mode: "start_turn" })).toBe("written");
  });

  test("a permission request is journalled, denied once with the note, and resolved", async () => {
    const { handle, events, until, requests } = await start();
    await handle.submit({ input_id: "in1", text: "ask", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "approval_requested"));
    const asked = events.find((event) => event.type === "approval_requested")!;
    expect(asked).toMatchObject({ native_request_id: "per_1", tool: "OpenCode bash", summary: "Run ls" });
    await expect(handle.answerApproval("per_1", "allow")).rejects.toThrow("no matching denial");
    await handle.answerApproval("per_1", "deny", "Nobody can approve prompts here.");
    await expect(handle.answerApproval("per_1", "deny")).rejects.toThrow("no matching denial");
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(requests().find((entry) => entry.path?.endsWith("/permission/per_1/reply"))?.body)
      .toEqual({ decision: "reject", message: "Nobody can approve prompts here." });
    expect(events.filter((event) => event.type === "approval_resolved")).toEqual([{ type: "approval_resolved", native_request_id: "per_1" }]);
  });

  test("interrupts only the running turn it names", async () => {
    const { handle, events, until } = await start();
    expect(await handle.interrupt()).toBe("not_busy");
    await handle.submit({ input_id: "in1", text: "hang", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "turn_started"));
    expect(await handle.interrupt("inbox_9")).toBe("not_busy");
    expect(await handle.interrupt("inbox_1")).toBe("interrupted");
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(events.at(-1)).toEqual({ type: "turn_completed", native_turn_id: "inbox_1", outcome: "interrupted" });
  });

  test("resumes only a conversation the server has, and wrapped event frames work too", async () => {
    const { handle, events, until } = await start({ FAKE_OPENCODE_EXISTING: "ses_old", FAKE_OPENCODE_WRAP: "1" }, { resumeSessionId: "ses_old" });
    expect(handle.sessionId()).toBe("ses_old");
    await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "turn_completed"));
    await expect(start({}, { resumeSessionId: "ses_missing" })).rejects.toThrow("could not find the conversation");
    await expect(start({ FAKE_OPENCODE_EXISTING: "ses_old", FAKE_OPENCODE_EXISTING_DIR: "/somewhere/else" }, { resumeSessionId: "ses_old" }))
      .rejects.toThrow("belongs to another folder");
  });

  test("refuses a conversation that did not take the requested model", async () => {
    await expect(start({ FAKE_OPENCODE_IGNORE_MODEL: "1" }, { session: { model: { providerID: "anthropic", id: "claude-sonnet" } } }))
      .rejects.toThrow("did not set the requested model");
  });

  test("probe checks the exact process and conversation; stop ends the whole group on stdin EOF", async () => {
    const { handle, events, until } = await start();
    expect(await handle.probe()).toBe("alive");
    const pgid = handle.pgid;
    await handle.stop(2_000);
    await until(() => events.some((event) => event.type === "exited"));
    expect(() => process.kill(-pgid, 0)).toThrow();
    expect(await handle.probe()).toBe("gone");
  });

  test("refuses a server that announces anything but a loopback URL, and stops it", async () => {
    await expect(start({ FAKE_OPENCODE_URL: "http://0.0.0.0:4096" })).rejects.toThrow("no loopback server");
    expect(parseAnnouncedUrl('{"url":"http://127.0.0.1:4096"}')).toBe("http://127.0.0.1:4096");
    for (const line of ['{"url":"http://localhost:4096"}', '{"url":"http://127.0.0.1:4096/x"}', '{"url":"https://127.0.0.1:1"}',
      '{"url":"http://127.0.0.1:0"}', "not json", "{}"]) {
      expect(parseAnnouncedUrl(line)).toBeNull();
    }
  });

  test("the event parser takes data lines, ignores the rest, and bounds a runaway line", () => {
    const frames: unknown[] = [];
    let overflowed = false;
    const parser = new SseParser((frame) => frames.push(frame), () => { overflowed = true; });
    parser.push(": comment\nevent: x\ndata: {\"type\":\"a\"}\n\ndata: {\"event\":{\"type\":\"b\"}}\r\ndata: not json\n");
    expect(frames).toEqual([{ type: "a" }, { type: "b" }]);
    parser.push("data: " + "x".repeat(300 * 1024));
    expect(overflowed).toBe(true);
  });

  test("a handle refuses work before it has a conversation", async () => {
    const handle = new OpencodeWorkerHandle(1, "secret");
    expect(await handle.submit({ input_id: "in1", text: "hi", mode: "start_turn" })).toBe("rejected");
    expect(await handle.interrupt()).toBe("not_busy");
  });
});
