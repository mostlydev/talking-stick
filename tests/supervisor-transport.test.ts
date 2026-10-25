import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  TalkingStickService,
  deliverSupervisor,
  detectNativeWakeEndpoints,
  parseSupervisorAddress,
  type NativeWakeRequest,
  type NativeWakeResult,
  type ProcessMetadata
} from "../src/index.js";

const HOST = "host-s";
const OP = "human:op:chat:1";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sv-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("the supervisor endpoint", () => {
  test("is the only one a supervised worker registers", () => {
    expect(detectNativeWakeEndpoints({ CLAUDECODE: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/c.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t", TT_SUPERVISOR_ENDPOINT: "/tmp/s.sock#w1@3", TT_SUPERVISOR_TOKEN: "gen-token" },
      { agent_id: "claude:aa", harness_session_id: "harness:x" }))
      .toEqual([{ transport: "supervisor", address: "/tmp/s.sock#w1@3", secret: "gen-token" }]);
    expect(parseSupervisorAddress("/tmp/s.sock#w1@3")).toEqual({ socket: "/tmp/s.sock", worker_id: "w1", generation: 3 });
    expect(parseSupervisorAddress("/tmp/s.sock")).toBeNull();
  });

  test("reports queued only on the supervisor's answer, and ambiguous once written", async () => {
    const dir = tempDir();
    const socketPath = path.join(dir, "c.sock");
    const received: unknown[] = [];
    let answer: string | null = '{"outcome":"queued"}\n';
    const server = net.createServer((connection) => {
      connection.on("data", (chunk) => {
        received.push(JSON.parse(chunk.toString().trim()));
        if (answer) connection.end(answer);
        else connection.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(() => server.close());
    const request = (overrides: Partial<NativeWakeRequest> = {}): NativeWakeRequest => ({ transport: "supervisor",
      address: `${socketPath}#w1@2`, secret: "gen-token", delivery_token: "batch-1", text: "envelope", ...overrides });
    expect(await deliverSupervisor(request())).toEqual({ outcome: "queued" });
    expect(received[0]).toEqual({ type: "deliver", worker_id: "w1", generation: 2, token: "gen-token", batch_token: "batch-1", text: "envelope" });
    answer = '{"outcome":"failed","error":"stale_generation"}\n';
    expect(await deliverSupervisor(request())).toMatchObject({ outcome: "failed", error: "supervisor_stale_generation" });
    answer = null;
    expect((await deliverSupervisor(request())).outcome).toBe("ambiguous");
    expect(await deliverSupervisor(request({ address: `${path.join(dir, "none.sock")}#w1@2` })))
      .toMatchObject({ outcome: "failed", error: "supervisor_unreachable" });
    expect(await deliverSupervisor(request({ delivery_token: undefined })))
      .toMatchObject({ outcome: "failed", error: "supervisor_endpoint_invalid" });
  });
});

function setup(harness: "claude" | "codex" | "grok" = "claude") {
  const root = tempDir();
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const requests: NativeWakeRequest[] = [];
  const service = new TalkingStickService({ dataDir: path.join(root, "data"), hostId: HOST,
    processLivenessChecker: () => "alive", receiverLivenessChecker: () => "gone",
    nativeWakeTransport: { deliver(request): NativeWakeResult { requests.push(request); return { outcome: "queued" }; } },
    wakeTransport: { deliver() { return { delivered: false, definite_failure: true }; } } });
  cleanup.push(() => service.close());
  const roomId = service.joinPath({ agent_id: OP, context_path: project,
    process_metadata: { host_id: HOST, pid: 10, process_started_at: "t", session_kind: "human_chat", display_name: "op" } }).room_id;
  const meta: ProcessMetadata = { host_id: HOST, pid: 700, process_started_at: "p", session_kind: "harness_cli",
    display_name: harness, harness_name: harness, harness_session_id: "harness:w", harness_host_id: HOST,
    harness_pid: 600, harness_process_started_at: "s" };
  const agent = `${harness}:w`;
  service.joinPath({ agent_id: agent, context_path: project, process_metadata: meta });
  const register = (generation: number, transport: "supervisor" | "claude_inbox" = "supervisor") =>
    service.registerNativeWakeEndpoint({ agent_id: agent, room_id: roomId, transport,
      address: transport === "supervisor" ? `/tmp/sv.sock#w1@${generation}` : "/tmp/inbox.sock",
      secret: `token-${generation}`, harness_session_id: "harness:w", host_id: HOST });
  const send = async (body: string) => {
    const sent = await service.sendMessageAndWake({ agent_id: OP, room_id: roomId, to_agent_id: agent, body });
    await service.flushWakes();
    return sent.event_seq;
  };
  const fence = (generation: number, batch: string, transition: "writing" | "written" | "unsent", secret = `token-${generation}`) =>
    service.fenceManagedDelivery({ room_id: roomId, agent_id: agent, endpoint_address: `/tmp/sv.sock#w1@${generation}`,
      delivery_secret: secret, batch_token: batch, transition });
  const offered = () => requests.map((request) => [...request.text.matchAll(/#(\d+) /g)].map((match) => Number(match[1])));
  return { service, roomId, project, requests, register, send, fence, offered };
}

describe("a supervised member", () => {
  test("has only its supervisor endpoint", () => {
    const { service, roomId, register } = setup();
    register(1, "claude_inbox");
    register(1);
    expect(service.db.prepare("SELECT transport FROM member_wake_endpoints WHERE room_id = ?").all(roomId))
      .toEqual([{ transport: "supervisor" }]);
    expect(() => register(1, "claude_inbox")).toThrow("only its supervisor endpoint");
  });

  test("gets the batch token, and a fenced batch is never offered again, across generations, until acknowledged", async () => {
    const { service, requests, register, send, fence, offered } = setup();
    register(1);
    const first = await send("first");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ transport: "supervisor", address: "/tmp/sv.sock#w1@1" });
    const batch = requests[0].delivery_token!;
    expect(batch).toBeTruthy();
    expect(() => fence(1, batch, "writing", "wrong")).toThrow("not the current supervisor endpoint");
    expect(fence(1, batch, "writing").status).toBe("managed_writing");
    expect(() => fence(1, batch, "writing")).toThrow("is managed_writing");
    expect(fence(1, batch, "written").status).toBe("managed_written");
    // The worker crashes and a new generation registers: the old batch stays fenced.
    register(2);
    expect(() => fence(1, batch, "unsent")).toThrow("not the current supervisor endpoint");
    const second = await send("second");
    expect(offered().slice(1).flat()).toEqual([second]);
    expect(offered().flat().filter((seq) => seq === first)).toHaveLength(1);
    // The model acknowledges the original token: the fence is released for good.
    expect(service.acknowledgeNativeDelivery({ agent_id: "claude:w", token: batch, harness_session_id: "harness:w", host_id: HOST }).status)
      .toBe("acknowledged");
  });

  test("an unsent batch is offered again once", async () => {
    const { service, requests, register, send, fence, offered } = setup();
    register(1);
    const first = await send("first");
    const batch = requests[0].delivery_token!;
    fence(1, batch, "writing");
    expect(fence(1, batch, "unsent").status).toBe("unsent");
    await service.flushWakes();
    expect(offered()).toEqual([[first], [first]]);
    expect(requests[1].delivery_token).not.toBe(batch);
  });

  test("when only fenced work is pending, nothing wakes it", async () => {
    const { service, roomId, requests, register, send, fence } = setup();
    register(1);
    await send("first");
    fence(1, requests[0].delivery_token!, "writing");
    register(2);
    service.db.prepare("UPDATE member_wake_endpoints SET wake_pending = 1 WHERE room_id = ?").run(roomId);
    await service.flushWakes();
    expect(requests).toHaveLength(1);
  });

  test("only a human reconciles a fenced batch: resend offers it again, drop marks it read", async () => {
    const resend = setup();
    resend.register(1);
    const first = await resend.send("first");
    const batch = resend.requests[0].delivery_token!;
    resend.fence(1, batch, "writing");
    expect(() => resend.service.reconcileManagedDelivery({ agent_id: "claude:w", batch_token: batch, action: "resend" }))
      .toThrow("Only the operator");
    expect(resend.service.reconcileManagedDelivery({ agent_id: OP, batch_token: batch, action: "resend" }).status).toBe("resent");
    await resend.service.flushWakes();
    expect(resend.offered()).toEqual([[first], [first]]);

    const drop = setup();
    drop.register(1);
    await drop.send("first");
    const dropped = drop.requests[0].delivery_token!;
    drop.fence(1, dropped, "writing");
    drop.fence(1, dropped, "written");
    expect(drop.service.reconcileManagedDelivery({ agent_id: OP, batch_token: dropped, action: "drop" }).status).toBe("dropped");
    drop.register(2);
    await drop.service.flushWakes();
    expect(drop.requests).toHaveLength(1);
  });
});

// Codex's review of #204 (#32403): every envelope path honours the fence.
describe("hook and interrupt paths", () => {
  test("a Codex Stop hook cannot replay a fenced event after a generation change", async () => {
    const { service, requests, register, send, fence } = setup("codex");
    register(1);
    await send("already possibly written");
    fence(1, requests[0].delivery_token!, "writing");
    register(2);
    service.handleCodexTurnHook({ sessionId: "w", pid: 600, processStartedAt: "s", turnId: "turn-x", event: "UserPromptSubmit" });
    expect(service.handleCodexTurnHook({ sessionId: "w", pid: 600, processStartedAt: "s", turnId: "turn-x", event: "Stop" })).toBeNull();
  });

  test("a Grok hook cannot deliver a fenced event", async () => {
    const { service, project, requests, register, send, fence } = setup("grok");
    register(1);
    await send("fenced");
    fence(1, requests[0].delivery_token!, "writing");
    expect(service.prepareGrokHookDelivery({ context_path: project, harness_session_id: "harness:w" })).toBeNull();
  });

  test("an interrupt never re-sends a fenced event", async () => {
    const { service, roomId, requests, register, send, fence } = setup();
    register(1);
    const seq = await send("fenced");
    fence(1, requests[0].delivery_token!, "writing");
    service.db.prepare(`INSERT INTO interrupt_deliveries (room_id, agent_id, event_seq, harness_session_id, host_id)
      VALUES (?, 'claude:w', ?, 'harness:w', ?)`).run(roomId, seq, HOST);
    await service.flushWakes();
    expect(requests).toHaveLength(1);
    expect(service.db.prepare("SELECT status, error FROM interrupt_deliveries").get())
      .toEqual({ status: "failed", error: "interrupt_managed_fenced" });
  });
});
