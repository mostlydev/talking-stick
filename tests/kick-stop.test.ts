import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { TalkingStickCommands, TalkingStickService } from "../src/index.js";
import { kickAndStop, previewKickStop } from "../src/cli/kick-stop.js";
import { createSystemProcessInspector } from "../src/process-utils.js";
import { deriveHumanCliIdentity } from "../src/identity.js";
import { SupervisorStore } from "../src/supervisor/state.js";
import { prepareSupervisorRoot } from "../src/supervisor/root.js";
import { supervisorPaths } from "../src/supervisor/run.js";
import { deliveryTokenHash } from "../src/supervisor/membership-gc.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tt-kick-stop-"));
  const state = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "tt-ks-"));
  cleanups.push(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true }); });
  const dataDir = path.join(base, "data");
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  vi.stubEnv("TALKING_STICK_DATA_DIR", dataDir);
  vi.stubEnv("TT_SUPERVISOR_STATE_DIR", state);
  const host = os.hostname();
  const service = new TalkingStickService({ dataDir, hostId: host, processLivenessChecker: () => "alive" });
  cleanups.push(() => service.close());
  const runtime = { commands: new TalkingStickCommands(service), close: () => service.close() };
  const operator = deriveHumanCliIdentity({ agentId: "human:operator" });
  const room = service.joinPath({ agent_id: operator.agent_id, context_path: project,
    process_metadata: operator.process_metadata }).room_id;

  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 100)"], { stdio: "ignore" });
  const exited = once(child, "exit");
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  await once(child, "spawn");
  const pid = child.pid!;
  const startedAt = createSystemProcessInspector({ cacheTtlMs: 0 }).inspect(pid)?.startTime?.trim();
  if (!startedAt) throw new Error("Missing identity for the test process.");
  const member = (agent: string, options: { session?: string; start?: string } = {}) => service.joinPath({
    agent_id: agent, context_path: project, process_metadata: {
      pid, host_id: host, process_started_at: startedAt, harness_name: "claude", session_kind: "harness_cli",
      harness_pid: pid, harness_host_id: host, harness_process_started_at: options.start ?? startedAt,
      harness_session_id: `harness:${options.session ?? agent}`
    }
  });
  const args = (agent: string) => ({ room_id: room, target_agent_id: agent });
  const preview = (agent: string) => previewKickStop(runtime, room, agent, operator.agent_id);
  const kick = (agent: string, confirmed?: string, sharedConfirmation?: string) =>
    kickAndStop(runtime, operator, { ...args(agent), confirmed, sharedConfirmation });
  return { service, room, dataDir, project, child, exited, pid, startedAt, host, member, preview, kick };
}

test.skipIf(process.platform === "win32")("verified standalone process exits and its room records the result", async () => {
  const t = await setup();
  t.member("claude:one");
  const preview = t.preview("claude:one");
  expect(preview).toMatchObject({ method: "process", description: `Send SIGTERM to verified PID ${t.pid}` });
  await expect(t.kick("claude:one", "stale")).rejects.toThrow("target changed");
  const result = await t.kick("claude:one", preview.confirmation);
  expect(result.stop.result).toContain("The selected process exited.");
  expect(await t.exited).toEqual([null, "SIGTERM"]);
  expect(t.service.db.prepare("SELECT event_type, reason FROM room_events WHERE event_type = 'kick_stop'").get())
    .toMatchObject({ event_type: "kick_stop", reason: expect.stringContaining(`PID ${t.pid}`) });
});

test.skipIf(process.platform === "win32")("shared process is preserved unless the preview's affected members are confirmed", async () => {
  const t = await setup();
  t.member("claude:one");
  t.member("claude:two");
  const first = t.preview("claude:one");
  expect(first).toMatchObject({ method: "none", affected_members: ["claude:two"], shared_pid: t.pid });
  expect((await t.kick("claude:one")).stop.result).toContain("no verified session stop");
  expect(t.child.signalCode).toBeNull();
  t.member("claude:three");
  const second = t.preview("claude:three");
  expect(second.affected_members).toEqual(["claude:two"]);
  await expect(t.kick("claude:three", undefined, first.shared_confirmation)).rejects.toThrow("confirmation is stale");
  const result = await t.kick("claude:three", undefined, second.shared_confirmation);
  expect(result.stop).toMatchObject({ method: "shared_process", affected_members: ["claude:two"] });
  expect(await t.exited).toEqual([null, "SIGTERM"]);
});

test.skipIf(process.platform === "win32")("managed stops queue through the supervisor and leave signals to that daemon", async () => {
  const t = await setup();
  t.member("claude:worker", { session: "native-1" });
  const paths = supervisorPaths(prepareSupervisorRoot(t.dataDir).dir);
  const store = new SupervisorStore(paths.database);
  cleanups.push(() => store.close());
  store.addWorker({ worker_id: "worker", harness: "claude", cwd: t.project, env: [],
    permissions: { harness: "claude", mode: "default" } }, "human:operator", "now");
  store.recordGeneration({ worker_id: "worker", generation: 1, pid: t.pid, process_started_at: t.startedAt,
    pgid: t.pid, state: "idle", session_id: "native-1", started_at: "now", delivery_token_hash: deliveryTokenHash("test") });
  expect(t.preview("claude:worker")).toMatchObject({ method: "none", description: expect.stringContaining("belongs to the supervisor") });
  t.service.registerNativeWakeEndpoint({ room_id: t.room, agent_id: "claude:worker", transport: "supervisor",
    address: `${paths.socket}#worker@1`, secret: "test", host_id: t.host, harness_session_id: "harness:native-1" });
  expect(t.preview("claude:worker")).toMatchObject({ method: "supervisor", description: expect.stringContaining("worker#1") });
  expect((await t.kick("claude:worker")).stop.result).toBe("Supervisor stop queued for worker#1.");
  expect(store.worker("worker")?.desired).toBe("stopped");
  expect(t.child.signalCode).toBeNull();
});
