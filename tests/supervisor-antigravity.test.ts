import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type { WorkerEvent, WorkerSpec } from "../src/supervisor/adapter.js";
import { AntigravityAdapter } from "../src/supervisor/adapters/antigravity.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const posix = test.skipIf(process.platform === "win32");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-agy-acp-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace = path.join(root, "trace.jsonl");
  const spec: WorkerSpec = {
    worker_id: "agy1", harness: "antigravity", cwd: root,
    permissions: { harness: "antigravity", mode: "default" },
    env: [{ name: "HOME", from: "literal", value: root }, { name: "FIXTURE_TRACE", from: "literal", value: trace }]
  };
  const adapter = new AntigravityAdapter({ command: process.execPath,
    argsPrefix: [fileURLToPath(new URL("./fixtures/antigravity-acp.cjs", import.meta.url))], startTimeoutMs: 2_000 });
  const events: WorkerEvent[] = [];
  const start = async () => {
    const handle = await adapter.start(spec, 1, () => {});
    cleanup.push(() => handle.stop(100));
    handle.onEvent(event => events.push(event));
    return handle;
  };
  const method = (name: string) => fs.readFileSync(trace, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).find(entry => entry.method === name);
  return { root, trace, spec, adapter, events, start, method };
}

posix("runs through native ACP, accepts a prompt and resumes the exact conversation", async () => {
  const f = fixture();
  const handle = await f.start();
  expect(handle.sessionId()).toBe("fixture-conversation");
  expect(await handle.probe()).toBe("alive");
  expect(await handle.submit({ input_id: "a", text: "first", mode: "start_turn" })).toBe("written");
  await expect.poll(() => f.events).toContainEqual({ type: "turn_completed", native_turn_id: "a", outcome: "success" });
  expect(f.method("session/prompt").params.sessionId).toBe("fixture-conversation");
  await handle.stop(100);
  f.spec.resume_session_id = "fixture-conversation";
  expect((await f.start()).sessionId()).toBe("fixture-conversation");
  f.spec.resume_session_id = "unrelated";
  await expect(f.start()).rejects.toThrow(/did not confirm/);
});

posix("cancels the exact active turn and declines an ACP permission request", async () => {
  const f = fixture();
  const handle = await f.start();
  expect(await handle.submit({ input_id: "a", text: "wait", mode: "start_turn" })).toBe("written");
  expect(await handle.submit({ input_id: "extra", text: "invalid", mode: "steer" })).toBe("rejected");
  expect(await handle.interrupt("other")).toBe("not_busy");
  expect(await handle.interrupt("a")).toBe("interrupted");
  await expect.poll(() => f.events).toContainEqual({ type: "turn_completed", native_turn_id: "a", outcome: "interrupted" });

  expect(await handle.submit({ input_id: "b", text: "permission", mode: "start_turn" })).toBe("written");
  await expect.poll(() => f.events).toContainEqual(expect.objectContaining({
    type: "approval_requested", native_request_id: JSON.stringify("perm"), summary: "echo hello"
  }));
  await expect(handle.answerApproval(JSON.stringify("perm"), "allow")).rejects.toThrow(/no matching denial/);
  await handle.answerApproval(JSON.stringify("perm"), "deny");
  await expect.poll(() => f.events).toContainEqual({ type: "turn_completed", native_turn_id: "b", outcome: "success" });
});

posix("refuses an oversized permission request without journalling the raw details", async () => {
  const f = fixture();
  const handle = await f.start();
  expect(await handle.submit({ input_id: "large", text: "oversized permission", mode: "start_turn" })).toBe("written");
  await expect.poll(() => f.events).toContainEqual({ type: "request_refused", method: "session/request_permission" });
  await expect.poll(() => f.events).toContainEqual({ type: "turn_completed", native_turn_id: "large", outcome: "success" });
  expect(f.events.some(event => event.type === "approval_requested")).toBe(false);
});

posix("requires an account login and passes bypass only when chosen", async () => {
  const f = fixture();
  const settings = path.join(f.root, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{ auth: { type: "agent-platform" } }');
  await expect(f.start()).rejects.toMatchObject({ reason: "wrong_auth_mode" });
  expect(fs.existsSync(f.trace)).toBe(false);
  fs.writeFileSync(settings, '{ auth: { type: "oauth-personal" } }');
  f.spec.permissions = { harness: "antigravity", mode: "bypassPermissions" };
  await f.start();
  expect(JSON.parse(fs.readFileSync(f.trace, "utf8").split("\n")[0]).argv)
    .toEqual(["acp", "--stdio", "--dangerously-skip-permissions"]);
});
