import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthModeError, type WorkerEvent } from "../src/supervisor/adapter.js";
import { OpencodeWorkerHandle, parseAnnouncedUrl, SseParser, startOpencodeWorker,
  type OpencodeServerAccess, type OpencodeStartOptions } from "../src/supervisor/adapters/opencode-worker.js";

const fixture = path.resolve("tests/fixtures/fake-opencode-serve.mjs");
const sonnet = { providerID: "anthropic", id: "claude-sonnet" };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function workspace() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-opencode-worker-")));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(env: Record<string, string> = {}, options: Partial<OpencodeStartOptions> = {}) {
  const dir = workspace();
  const log = path.join(dir, "requests.jsonl");
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
  const turns = () => events.filter((event) => event.type === "turn_started" || event.type === "turn_completed");
  return { handle, events, requests, until, spawned, dir, turns };
}

describe("OpenCode worker transport", () => {
  test("starts a private loopback server in its own group and opens a conversation on the pinned model", async () => {
    const { handle, events, requests, spawned, dir } = await start({}, { model: sonnet });
    expect(spawned).toEqual([handle.pgid]);
    expect(handle.pgid).toBe(handle.pid);
    expect(handle.sessionId()).toBe("ses_fake1");
    expect(events).toContainEqual({ type: "session", session_id: "ses_fake1" });
    const log = requests();
    expect(log[0].argv).toEqual(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
    const calls = log.filter((entry) => entry.method);
    expect(calls.every((entry) => entry.authorized)).toBe(true);
    expect(calls.find((entry) => entry.path === "/api/session")?.body).toEqual({ location: { directory: dir }, model: sonnet });
    // The event stream opened before the conversation, so none of its events are missed.
    const order = calls.map((entry) => `${entry.method} ${entry.path}`);
    expect(order.indexOf("GET /api/event")).toBeLessThan(order.indexOf("POST /api/session"));
    expect(handle.password).toMatch(/^[0-9a-f]{48}$/);
  });

  test("a gate sees the authenticated server before any conversation, and its model is pinned", async () => {
    const seen: OpencodeServerAccess[] = [];
    const { handle, requests } = await start({}, { beforeSession: async (server) => { seen.push(server); return { model: sonnet }; } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(handle.url);
    expect(seen[0].authorization).toBe(handle.authorizationHeader);
    expect(seen[0].signal.aborted).toBe(false);
    expect(requests().find((entry) => entry.path === "/api/session")?.body.model).toEqual(sonnet);
  });

  test("a gate that refuses stops the server before any conversation exists", async () => {
    const dir = workspace();
    const log = path.join(dir, "requests.jsonl");
    let pgid = 0;
    await expect(startOpencodeWorker({ command: process.execPath, argsPrefix: [fixture], cwd: dir, generation: 1,
      env: { PATH: process.env.PATH, FAKE_OPENCODE_LOG: log }, onSpawn: (child) => { pgid = child.pgid; },
      beforeSession: async () => { throw new AuthModeError("wrong_auth_mode", "API key route"); } }))
      .rejects.toBeInstanceOf(AuthModeError);
    expect(() => process.kill(-pgid, 0)).toThrow();
    expect(fs.readFileSync(log, "utf8")).not.toContain('"/api/session"');
  });

  test("one prompt is written, starts a turn on its exact inbox item and completes; a second is refused meanwhile", async () => {
    const { handle, until, requests, turns } = await start();
    expect(await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" })).toBe("written");
    expect(await handle.submit({ input_id: "in2", text: "again", mode: "start_turn" })).toBe("rejected");
    expect(await handle.submit({ input_id: "in3", text: "steer", mode: "steer" })).toBe("rejected");
    await until(() => turns().length === 2);
    expect(turns()).toEqual([
      { type: "turn_started", native_turn_id: "inbox_1", input_id: "in1" },
      { type: "turn_completed", native_turn_id: "inbox_1", outcome: "success" }
    ]);
    expect(requests().find((entry) => entry.path === "/api/session/ses_fake1/prompt")?.body).toEqual({ text: "hello", delivery: "queue" });
    expect(await handle.submit({ input_id: "in4", text: "next", mode: "start_turn" })).toBe("written");
  });

  test("delivery and completion that arrive before the prompt's response are attributed to that prompt", async () => {
    const { handle, until, turns } = await start({ FAKE_OPENCODE_EARLY: "1" });
    expect(await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" })).toBe("written");
    await until(() => turns().length === 2);
    expect(turns()).toEqual([
      { type: "turn_started", native_turn_id: "inbox_1", input_id: "in1" },
      { type: "turn_completed", native_turn_id: "inbox_1", outcome: "success" }
    ]);
  });

  test("work in the conversation that no prompt started is never attributed, and its permission request is refused", async () => {
    const { handle, events, until, requests, turns } = await start();
    expect(await handle.submit({ input_id: "in1", text: "stray then hello", mode: "start_turn" })).toBe("written");
    await until(() => turns().length === 2);
    expect(turns()).toEqual([
      { type: "turn_started", native_turn_id: "inbox_1", input_id: "in1" },
      { type: "turn_completed", native_turn_id: "inbox_1", outcome: "success" }
    ]);
    expect(events).toContainEqual({ type: "request_refused", method: "permission.asked" });
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    await until(() => requests().some((entry) => entry.path?.endsWith("/permission/per_stray/reply")));
    expect(requests().find((entry) => entry.path?.endsWith("/permission/per_stray/reply"))?.body.decision).toBe("reject");
  });

  test("an admission that may have happened is journalled uncertain and ends the generation", async () => {
    const { handle, events, until } = await start({}, { requestTimeoutMs: 300 });
    expect(await handle.submit({ input_id: "in1", text: "hang-post", mode: "start_turn" })).toBe("uncertain");
    expect(events).toContainEqual({ type: "input", input_id: "in1", outcome: "uncertain" });
    expect(events).toContainEqual({ type: "protocol_error" });
    await until(() => events.some((event) => event.type === "exited"));
    expect(await handle.submit({ input_id: "in2", text: "hello", mode: "start_turn" })).toBe("rejected");
  });

  test("an admitted prompt that is cancelled before delivery is journalled uncertain and ends the generation", async () => {
    const { handle, events, until } = await start();
    expect(await handle.submit({ input_id: "in1", text: "cancel", mode: "start_turn" })).toBe("written");
    await until(() => events.some((event) => event.type === "exited"));
    expect(events).toContainEqual({ type: "input", input_id: "in1", outcome: "uncertain" });
    expect(events).toContainEqual({ type: "protocol_error" });
    expect(events.some((event) => event.type === "turn_started")).toBe(false);
  });

  test("an admitted prompt that is never delivered times out of busy, separately from a running turn", async () => {
    const { handle, events, until } = await start({}, { ackTimeoutMs: 300 });
    expect(await handle.submit({ input_id: "in1", text: "nodeliver", mode: "start_turn" })).toBe("written");
    await until(() => events.some((event) => event.type === "exited"));
    expect(events).toContainEqual({ type: "input", input_id: "in1", outcome: "uncertain" });
    // A delivered turn may run past the acknowledgement period.
    const running = await start({}, { ackTimeoutMs: 300 });
    await running.handle.submit({ input_id: "in1", text: "hang", mode: "start_turn" });
    await running.until(() => running.events.some((event) => event.type === "turn_started"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(running.events.some((event) => event.type === "protocol_error")).toBe(false);
  });

  test("a subagent's permission request is verified by ancestry, journalled once and denied in its own conversation", async () => {
    const { handle, events, until, requests } = await start({ FAKE_OPENCODE_SLOW_CHILD: "1" });
    await handle.submit({ input_id: "in1", text: "child-ask", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "approval_requested"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Two frames of one request during a slow lookup, and a reply from another conversation: one request, unsettled.
    expect(events.filter((event) => event.type === "approval_requested")).toEqual([
      expect.objectContaining({ native_request_id: "per_child", summary: "Subagent runs ls" })]);
    expect(events.some((event) => event.type === "approval_resolved")).toBe(false);
    await handle.answerApproval("per_child", "deny", "Nobody can approve prompts here.");
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(requests().filter((entry) => entry.path === "/api/session/ses_grandchild/permission/per_child/reply")).toHaveLength(1);
    expect(events.filter((event) => event.type === "approval_resolved")).toHaveLength(1);
  });

  test("a request whose lookup outlives its turn is refused, not handed to a later turn", async () => {
    const { handle, events, until, requests } = await start({ FAKE_OPENCODE_SLOW_CHILD: "1" });
    await handle.submit({ input_id: "in1", text: "child-ask late", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(await handle.submit({ input_id: "in2", text: "hang", mode: "start_turn" })).toBe("written");
    await until(() => requests().some((entry) => entry.path === "/api/session/ses_grandchild/permission/per_child/reply"));
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(events).toContainEqual({ type: "request_refused", method: "permission.asked" });
  });

  test("a permission request from an unrelated conversation is refused in that conversation", async () => {
    const { handle, events, until, requests } = await start();
    await handle.submit({ input_id: "in1", text: "foreign-ask", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "turn_completed"));
    expect(events).toContainEqual({ type: "request_refused", method: "permission.asked" });
    expect(events.some((event) => event.type === "approval_requested")).toBe(false);
    expect(requests().find((entry) => entry.path === "/api/session/ses_foreign/permission/per_foreign/reply")?.body.decision).toBe("reject");
    // The same request repeated after it was refused is not answered again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests().filter((entry) => entry.path === "/api/session/ses_foreign/permission/per_foreign/reply")).toHaveLength(1);
    expect(events.filter((event) => event.type === "request_refused")).toHaveLength(1);
  });

  test("the event stream outlives the start timeout", async () => {
    const { handle, events, until, turns } = await start({}, { startTimeoutMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.some((event) => event.type === "protocol_error")).toBe(false);
    expect(await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" })).toBe("written");
    await until(() => turns().length === 2);
  });

  test("a permission request of the running turn is journalled, denied once with the note, and resolved", async () => {
    const { handle, events, until, requests } = await start();
    await handle.submit({ input_id: "in1", text: "ask", mode: "start_turn" });
    await until(() => events.some((event) => event.type === "approval_requested"));
    expect(events.find((event) => event.type === "approval_requested")).toMatchObject({ native_request_id: "per_1", tool: "OpenCode bash", summary: "Run ls" });
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

  test("resumes only the server's conversation in this folder on the exact model and variant", async () => {
    const existing = { FAKE_OPENCODE_EXISTING: "ses_old", FAKE_OPENCODE_WRAP: "1",
      FAKE_OPENCODE_EXISTING_MODEL: JSON.stringify({ ...sonnet, variant: "high" }) };
    const { handle, until, turns } = await start(existing, { resumeSessionId: "ses_old", model: { ...sonnet, variant: "high" } });
    expect(handle.sessionId()).toBe("ses_old");
    await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" });
    await until(() => turns().length === 2);
    await expect(start(existing, { resumeSessionId: "ses_old", model: sonnet })).rejects.toBeInstanceOf(AuthModeError);
    await expect(start({}, { resumeSessionId: "ses_missing" })).rejects.toThrow("could not find the conversation");
    await expect(start({ ...existing, FAKE_OPENCODE_EXISTING_DIR: "/somewhere/else" }, { resumeSessionId: "ses_old" }))
      .rejects.toThrow("belongs to another folder");
    await expect(start({ FAKE_OPENCODE_IGNORE_MODEL: "1" }, { model: sonnet })).rejects.toBeInstanceOf(AuthModeError);
  });

  test("a model required without a variant matches OpenCode's stored default variant, and only that", async () => {
    const stored = (variant: string) => ({ FAKE_OPENCODE_EXISTING: "ses_old", FAKE_OPENCODE_EXISTING_MODEL: JSON.stringify({ ...sonnet, variant }) });
    const { handle } = await start(stored("default"), { resumeSessionId: "ses_old", model: sonnet });
    expect(handle.sessionId()).toBe("ses_old");
    await expect(start(stored("high"), { resumeSessionId: "ses_old", model: sonnet })).rejects.toBeInstanceOf(AuthModeError);
  });

  test("a model switched after start is caught before the next prompt", async () => {
    const { handle, events } = await start({}, { model: sonnet });
    const switched = await fetch(`${handle.url}/api/session/ses_fake1/model`, { method: "POST",
      headers: { Authorization: handle.authorizationHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "openrouter", id: "cheap" }) });
    expect(switched.status).toBe(200);
    expect(await handle.submit({ input_id: "in1", text: "hello", mode: "start_turn" })).toBe("rejected");
    expect(events).toContainEqual({ type: "state", state: "wrong_auth_mode" });
  });

  test("never follows a redirect", async () => {
    await expect(start({ FAKE_OPENCODE_REDIRECT: "1" })).rejects.toThrow();
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

  test("the event parser takes data lines, ignores the rest, and refuses an oversized line, complete or not", () => {
    const frames: unknown[] = [];
    let overflows = 0;
    const parser = new SseParser((frame) => frames.push(frame), () => { overflows++; });
    parser.push(": comment\nevent: x\ndata: {\"type\":\"a\"}\n\ndata: {\"event\":{\"type\":\"b\"}}\r\ndata: not json\n");
    expect(frames).toEqual([{ type: "a" }, { type: "b" }]);
    parser.push("data: {\"type\":\"" + "x".repeat(300 * 1024) + "\"}\n");
    expect(overflows).toBe(1);
    expect(frames).toHaveLength(2);
    parser.push("data: " + "x".repeat(300 * 1024));
    expect(overflows).toBe(2);
  });

  test("a handle refuses work before it has a conversation", async () => {
    const handle = new OpencodeWorkerHandle(1, "secret");
    expect(await handle.submit({ input_id: "in1", text: "hi", mode: "start_turn" })).toBe("rejected");
    expect(await handle.interrupt()).toBe("not_busy");
  });
});


test("refuses an oversized permission request without recording it", async () => {
  const { handle, events, until, requests } = await start();
  await handle.submit({ input_id: "in1", text: "oversized-ask", mode: "start_turn" });
  await until(() => events.some((event) => event.type === "turn_completed"));
  expect(events).toContainEqual({ type: "request_refused", method: "permission.asked" });
  expect(events.some((event) => event.type === "approval_requested")).toBe(false);
  expect(requests().find((entry) => entry.path?.endsWith("/permission/per_1/reply"))?.body)
    .toMatchObject({ decision: "reject" });
});

test("escapes invisible characters in permission detail", async () => {
  const { handle, events, until } = await start();
  await handle.submit({ input_id: "in1", text: "invisible-ask", mode: "start_turn" });
  await until(() => events.some((event) => event.type === "approval_requested"));
  const event = events.find((event) => event.type === "approval_requested");
  expect(event?.detail).toContain(String.raw`\u202e`);
  expect(JSON.parse(event!.detail).message).toBe("Run\u202Els");
});
