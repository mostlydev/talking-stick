import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/attended-gate-acceptance.mjs", import.meta.url));
const built = fs.existsSync(fileURLToPath(new URL("../dist/supervisor/human-gate.js", import.meta.url)));

// The attended run asks a human; only its scripted self-test runs here, and never a real dialog.
describe.skipIf(!built || process.platform === "win32")("the attended gate acceptance kit", () => {
  const resultOf = (output: string) => {
    const file = output.match(/Result: (\S+)/)![1];
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file);
    return result;
  };
  const leftovers = () => fs.readdirSync("/tmp").filter((entry) => entry.startsWith("tt-gate-accept-") || entry.startsWith("tt-gate-launchd-"));

  test("its self-test runs every step against the fixture worker, states its scope, and cleans up", () => {
    const before = leftovers();
    const output = execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf8", timeout: 60_000 });
    for (const step of ["the fixture worker reports a read-only sandbox", "1: a confirmed approval is allowed and delivered",
      "2: a replay is refused without a dialog", "3: two requests are pending at once",
      "4: a cancelled dialog refuses, and neither request is settled or answered",
      "5: confirming one request decides and answers only that one", "6: an unavailable gate settles nothing"]) expect(output).toContain(step);
    expect(output).toContain("not OS-enforced");
    const result = resultOf(output);
    expect(result).toMatchObject({ ok: true, self_test: true, scope: expect.stringContaining("launchd") });
    expect(result.audit.map((row: { action: string }) => row.action))
      .toEqual(["control_approve_confirmed", "control_approve_refused", "control_approve_confirmed", "control_approve_unavailable"]);
    // Nothing a token could be recovered from.
    expect(JSON.stringify(result)).not.toMatch(/token/i);
    expect(leftovers()).toEqual(before);
  });

  test("a signal at a prompt records an honest abort, settles nothing more, and still cleans up", async () => {
    const before = leftovers();
    const child = spawn(process.execPath, [script, "--self-test"], { env: { ...process.env, TT_GATE_ACCEPTANCE_WAIT_AFTER: "3:" } });
    let stdout = "";
    let signalled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("waiting at the prompt")) { if (!signalled) { signalled = true; child.kill("SIGTERM"); } }
    });
    const status = await new Promise<number | string | null>((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    expect(status).toBe(130);
    const result = resultOf(stdout);
    expect(result).toMatchObject({ ok: false, aborted: true, error: "Stopped by SIGTERM." });
    // Stopped before step 4: nothing after the prompt ran.
    expect(result.steps.map((step: { step: string }) => step.step.slice(0, 2))).not.toContain("4:");
    expect(result.audit.map((row: { action: string }) => row.action)).toEqual(["control_approve_confirmed"]);
    expect(leftovers()).toEqual(before);
  }, 30_000);

  test("a signal while the gate is asking refuses that decision before anything settles", async () => {
    const before = leftovers();
    const child = spawn(process.execPath, [script, "--self-test"], { env: { ...process.env, TT_GATE_ACCEPTANCE_CONFIRM_DELAY_MS: "10000" } });
    let stdout = "";
    let signalled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("the gate is asking")) { if (!signalled) { signalled = true; child.kill("SIGTERM"); } }
    });
    const status = await new Promise<number | string | null>((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    expect(status).toBe(130);
    const result = resultOf(stdout);
    expect(result).toMatchObject({ ok: false, aborted: true, error: "Stopped by SIGTERM." });
    // The confirmation the scripted human would have given never landed.
    expect(result.audit.map((row: { action: string }) => row.action)).toEqual(["control_approve_refused"]);
    expect(result.approvals.every((row: { status: string }) => row.status !== "allowed")).toBe(true);
    expect(result.approvals.every((row: { answer_status: string | null }) => row.answer_status !== "delivered")).toBe(true);
    expect(leftovers()).toEqual(before);
  }, 30_000);

  test("its launchd self-test runs every step through a stand-in launchctl, and leaves no job or helper behind", async () => {
    const before = leftovers();
    const registry = path.join(os.tmpdir(), "tt-fake-launchctl");
    const child = spawn(process.execPath, [script, "--launchd", "--self-test"]);
    let stdout = "";
    let signalled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Step 4 asks for Ctrl-C with the dialog up instead of an answer.
      if (stdout.includes("press Ctrl-C here") && !signalled) { signalled = true; child.kill("SIGINT"); }
    });
    const status = await new Promise<number | string | null>((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    expect(status).toBe(0);
    for (const step of ["1: a launchd agent's dialog was shown in the GUI session and confirmed",
      "2: a launchd agent's dialog was cancelled, and the helper refused", "3: background domain: the helper was unavailable there (exit 2)",
      "4: an abort with the dialog up unloaded the agent and left no helper running"]) expect(stdout).toContain(step);
    const result = resultOf(stdout);
    expect(result).toMatchObject({ ok: true, self_test: true, scope: expect.stringContaining("does not show a supervisor LaunchAgent") });
    expect(result.steps.map((step: { kind?: string }) => step.kind)).toEqual(["confirmed", "refused", "unavailable", "aborted"]);
    expect(result.steps[3]).toMatchObject({ cleanup_ok: true, helper: "gone" });
    expect(leftovers()).toEqual(before);
    expect(fs.existsSync(registry) ? fs.readdirSync(registry) : []).toEqual([]);
  }, 60_000);

  // Runs the launchd self-test with one injected fault; Ctrl-C at step 4 when it gets there.
  const launchdRun = async (env: Record<string, string>, signals = 1) => {
    const child = spawn(process.execPath, [script, "--launchd", "--self-test"], { env: { ...process.env, ...env } });
    let stdout = "";
    let sent = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("press Ctrl-C here")) while (sent < signals) { sent++; child.kill("SIGINT"); }
    });
    const status = await new Promise<number | string | null>((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    return { status, stdout };
  };
  const registry = path.join(os.tmpdir(), "tt-fake-launchctl");
  const registryEmpty = () => (fs.existsSync(registry) ? fs.readdirSync(registry) : []).length === 0;

  test("a bootstrap failure is an infrastructure error, not a helper result, and cleans up", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "bootstrap-fail" });
    expect(status).toBe(1);
    expect(resultOf(stdout).error).toContain("infrastructure_error");
    expect(leftovers()).toEqual(before);
    expect(registryEmpty()).toBe(true);
  }, 60_000);

  test("a stale exit record from another label never satisfies a step", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "stale-record" });
    expect(status).toBe(0);
    expect(resultOf(stdout).steps.map((step: { kind?: string }) => step.kind)).toEqual(["confirmed", "refused", "unavailable", "aborted"]);
    expect(leftovers()).toEqual(before);
  }, 60_000);

  test("a helper that never finishes is a timeout, then its agent is unloaded and the helper gone", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "timeout", TT_GATE_ACCEPTANCE_STEP_TIMEOUT_MS: "500" });
    expect(status).toBe(1);
    const result = resultOf(stdout);
    expect(result.error).toContain('"kind":"timeout"');
    expect(result.bootouts[0]).toMatchObject({ unloaded: true, helper: "gone", ok: true });
    expect(leftovers()).toEqual(before);
    expect(registryEmpty()).toBe(true);
  }, 60_000);

  test("an agent that can't be shown unloaded keeps its evidence and is named", async () => {
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "bootout-fail" });
    const result = resultOf(stdout);
    try {
      expect(status).toBe(1);
      expect(result.cleanup_incomplete).toHaveLength(1);
      expect(stdout).toContain("CLEANUP INCOMPLETE");
      expect(fs.existsSync(path.join(result.retained_root, "ledger.json"))).toBe(true);
    } finally {
      // The test's own leftovers: stop the stand-in job and remove the kept root.
      for (const entry of fs.existsSync(registry) ? fs.readdirSync(registry) : []) {
        try { process.kill(-Number(fs.readFileSync(path.join(registry, entry), "utf8")), "SIGKILL"); } catch { /* gone */ }
        fs.rmSync(path.join(registry, entry), { force: true });
      }
      if (result.retained_root) fs.rmSync(result.retained_root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a second signal still unloads what this run loaded before it exits", async () => {
    const before = leftovers();
    const { status } = await launchdRun({}, 2);
    expect([0, 130]).toContain(status);
    expect(leftovers()).toEqual(before);
    expect(registryEmpty()).toBe(true);
    for (const file of fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tt-gate-acceptance-"))) fs.rmSync(path.join(os.tmpdir(), file));
  }, 60_000);

  test("the attended launchd run refuses inside a harness session, before building or loading anything", () => {
    const run = spawnSync(process.execPath, [script, "--launchd"], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1" }, timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("doesn't run inside");
  });

  test("the attended run refuses inside a harness session, asking nothing", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1" }, timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("doesn't run inside");
    expect(path.basename(script)).toBe("attended-gate-acceptance.mjs");
  });
});
