import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TalkingStickService, type ProcessMetadata } from "../src/index.js";
import { resolveCliIdentity } from "../src/cli/identity.js";
import { parseCommand } from "../src/cli/parser.js";
import { createProcessEvidence } from "../src/supervisor-process-evidence.js";

const HOST = "host-w";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-supervised-conversation-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Codex runs internal threads (memory consolidation, summaries, sub-agents)
// in the worker's own app-server, with the worker's environment (#271).
describe("a supervised Codex worker's process", () => {
  function worker(harness = "codex") {
    const root = tempDir();
    const evidence = createProcessEvidence({ stateDir: root, workerId: "w1", generation: 1,
      harness, endpoint: "/tmp/sv.sock#w1@1", token: "gen-token" });
    const env = (thread: string) => ({ CODEX_THREAD_ID: thread, TT_SUPERVISOR_PROCESS_FILE: evidence.file,
      TT_SUPERVISOR_ENDPOINT: "/tmp/sv.sock#w1@1", TT_SUPERVISOR_TOKEN: "gen-token", TALKING_STICK_DATA_DIR: root });
    return { evidence, env };
  }
  const resolve = (env: NodeJS.ProcessEnv) => resolveCliIdentity(parseCommand(["join"]), env);

  test("lets only the conversation the supervisor bound use rooms", () => {
    const { evidence, env } = worker();
    evidence.record({ pid: 4242, processStartedAt: "start" }, null);
    expect(() => resolve(env("worker-thread"))).toThrow(expect.objectContaining({ code: "not_worker_session",
      message: expect.stringContaining("not set up yet") }));
    evidence.bindSession("worker-thread");
    expect(resolve(env("worker-thread")).identity.process_metadata.harness_session_id).toBe("harness:worker-thread");
    expect(() => resolve(env("memory-thread"))).toThrow(expect.objectContaining({ code: "not_worker_session",
      message: expect.stringContaining("needs no stick to edit its own files") }));
  });

  test("keeps working with older evidence, another harness's binding, or no supervisor", () => {
    const { evidence, env } = worker();
    evidence.record({ pid: 4242, processStartedAt: "start" });
    expect(resolve(env("memory-thread")).identity.process_metadata.harness_session_id).toBe("harness:memory-thread");
    const claude = worker("claude");
    claude.evidence.record({ pid: 4242, processStartedAt: "start" }, null);
    expect(resolve(claude.env("memory-thread")).identity.agent_id).toMatch(/^codex:/);
    const { TT_SUPERVISOR_TOKEN: _token, ...unsupervised } = env("memory-thread");
    expect(resolve(unsupervised).identity.agent_id).toMatch(/^codex:/);
    // A forged or stale token does not authenticate the binding.
    evidence.record({ pid: 4242, processStartedAt: "start" }, "worker-thread");
    expect(resolve({ ...env("memory-thread"), TT_SUPERVISOR_TOKEN: "other" }).identity.agent_id).toMatch(/^codex:/);
  });
});

describe("the service", () => {
  function setup() {
    const root = tempDir();
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), "{}\n");
    const service = new TalkingStickService({ dataDir: path.join(root, "data"), hostId: HOST,
      processLivenessChecker: () => "alive", receiverLivenessChecker: () => "gone",
      nativeWakeTransport: { deliver() { return { outcome: "queued" }; } },
      wakeTransport: { deliver() { return { delivered: false, definite_failure: true }; } } });
    cleanup.push(() => service.close());
    const meta = (session: string, pid = 600): ProcessMetadata => ({ host_id: HOST, pid: 700, process_started_at: "p",
      session_kind: "harness_cli", display_name: "codex", harness_name: "codex", harness_session_id: `harness:${session}`,
      harness_host_id: HOST, harness_pid: pid, harness_process_started_at: "s" });
    const join = (agent: string, session: string, pid?: number) =>
      service.joinPath({ agent_id: agent, context_path: project, process_metadata: meta(session, pid) });
    return { service, join, project };
  }

  test("refuses a second conversation in a supervised worker's process", () => {
    const { service, join } = setup();
    const roomId = join("codex:worker", "worker").room_id;
    service.registerNativeWakeEndpoint({ agent_id: "codex:worker", room_id: roomId, transport: "supervisor",
      address: "/tmp/sv.sock#w1@1", secret: "gen-token", harness_session_id: "harness:worker", host_id: HOST });
    expect(() => join("codex:memory", "memory")).toThrow(expect.objectContaining({ code: "not_worker_session",
      message: expect.stringContaining("codex:worker") }));
    expect(service.db.prepare("SELECT 1 FROM room_members WHERE agent_id = ?").get("codex:memory")).toBeUndefined();
    // The worker itself rejoins, and other processes are unaffected.
    expect(join("codex:worker", "worker").room_id).toBe(roomId);
    expect(join("codex:other", "other", 601).room_id).toBe(roomId);
  });

  test("still admits several conversations of an unsupervised shared host", () => {
    const { join } = setup();
    const roomId = join("codex:desktop-a", "a").room_id;
    expect(join("codex:desktop-b", "b").room_id).toBe(roomId);
  });
});
