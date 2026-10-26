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
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
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
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
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
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
  }, 30_000);

  test("its launchd self-test runs every step through a stand-in launchctl, and leaves no job or helper behind", async () => {
    const before = leftovers();
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
    expect(result.steps[3]).toMatchObject({ cleanup_ok: true, job: "unloaded", wrapper: "gone", helper: "gone" });
    for (const step of result.steps.slice(0, 2)) expect(step).toMatchObject({ job: "unloaded", cleanup_ok: true });
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
  }, 60_000);

  // Runs the launchd self-test with one injected fault; Ctrl-C at step 4 when it gets there.
  const launchdRun = async (env: Record<string, string>, signals = 1) => {
    const child = spawn(process.execPath, [script, "--launchd", "--self-test"], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let sent = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Each signal on its own, a moment apart, so two can't coalesce into one.
      if (stdout.includes("press Ctrl-C here") && sent === 0) {
        sent = 1;
        child.kill("SIGINT");
        if (signals > 1) setTimeout(() => { sent = 2; child.kill("SIGINT"); }, 300);
      }
    });
    const status = await new Promise<number | string | null>((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    return { status, stdout, stderr };
  };

  test("a bootstrap failure is an infrastructure error, not a helper result, and cleans up", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "bootstrap-fail" });
    expect(status).toBe(1);
    expect(resultOf(stdout).error).toContain("infrastructure_error");
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
  }, 60_000);

  test("a stale exit record from another label never satisfies a step", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "stale-record" });
    expect(status).toBe(0);
    expect(resultOf(stdout).steps.map((step: { kind?: string }) => step.kind)).toEqual(["confirmed", "refused", "unavailable", "aborted"]);
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
  }, 60_000);

  test("a helper that never finishes is a timeout, then its agent is unloaded and the helper gone", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "timeout", TT_GATE_ACCEPTANCE_STEP_TIMEOUT_MS: "500" });
    expect(status).toBe(1);
    const result = resultOf(stdout);
    expect(result.error).toContain('"kind":"timeout"');
    expect(result.bootouts[0]).toMatchObject({ job: "unloaded", helper: "gone", ok: true });
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
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
      // Only this run's own leftovers: its stand-in jobs, from its own private registry, and its kept root.
      const own: string = result.retained_root ? path.join(result.retained_root, "fake-registry") : "";
      for (const entry of own && fs.existsSync(own) ? fs.readdirSync(own) : []) {
        try { process.kill(-Number(fs.readFileSync(path.join(own, entry), "utf8")), "SIGKILL"); } catch { /* gone */ }
      }
      if (result.retained_root) fs.rmSync(result.retained_root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a dialog in the background domain, even one cancelled, is a finding and never Accepted", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "background-dialog" });
    expect(status).toBe(1);
    expect(stdout).toContain("FINDING: a dialog appeared in user/<uid> and was cancelled");
    expect(stdout).not.toContain("Accepted:");
    expect(resultOf(stdout)).toMatchObject({ ok: false, finding: "background_dialog" });
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
  }, 60_000);

  test("an unload and inspection that both fail never count as unloaded, and keep the evidence", async () => {
    // Every bootout and every print fails, as with a permission error: nothing is proven gone.
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "launchctl-denied" });
    const result = resultOf(stdout);
    try {
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("Accepted:");
      expect(result.ok).toBe(false);
      expect(result.bootouts.every((row: { job: string; ok: boolean }) => row.job === "unknown" && !row.ok)).toBe(true);
      expect(result.cleanup_incomplete.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(result.retained_root, "ledger.json"))).toBe(true);
    } finally {
      const own: string = result.retained_root ? path.join(result.retained_root, "fake-registry") : "";
      for (const entry of own && fs.existsSync(own) ? fs.readdirSync(own) : []) {
        try { process.kill(-Number(fs.readFileSync(path.join(own, entry), "utf8")), "SIGKILL"); } catch { /* gone */ }
      }
      if (result.retained_root) fs.rmSync(result.retained_root, { recursive: true, force: true });
    }
  }, 60_000);

  test("an inspection that answers nothing never proves a live helper gone", async () => {
    // ps answers empty, and the step-4 helper stays alive (ignoring SIGTERM) until released here.
    const release = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tt-gate-release-")), "release");
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "inspect-empty", TT_GATE_ACCEPTANCE_RELEASE: release });
    const result = resultOf(stdout);
    const unknown = result.bootouts.find((row: { helper: string }) => row.helper === "unknown");
    try {
      // While it lived, an empty inspection was "unknown" on every check, never "gone".
      expect(status).not.toBe(0);
      expect(stdout).not.toContain("Accepted:");
      expect(result.ok).toBe(false);
      expect(unknown).toMatchObject({ job: "unloaded", ok: false });
      expect(result.bootouts.filter((row: { label: string }) => row.label === unknown.label)
        .every((row: { helper: string; ok: boolean }) => row.helper === "unknown" && !row.ok)).toBe(true);
      expect(result.cleanup_incomplete).toEqual([unknown.label]);
      expect(fs.existsSync(path.join(result.retained_root, "ledger.json"))).toBe(true);
    } finally {
      // Release only this run's helper, wait (bounded) for that exact pid to be gone, then remove its root.
      fs.writeFileSync(release, "");
      const pid = unknown?.helper_identity?.pid as number | undefined;
      const deadline = Date.now() + 10_000;
      const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive()).toBe(false);
      if (result.retained_root) fs.rmSync(result.retained_root, { recursive: true, force: true });
      fs.rmSync(path.dirname(release), { recursive: true, force: true });
    }
  }, 60_000);

  test("a second signal during cleanup takes the bounded path and still unloads what this run loaded", async () => {
    const before = leftovers();
    // Cleanup is held open (self-test only) so the second signal provably lands during it.
    const { status, stdout, stderr } = await launchdRun({ TT_GATE_ACCEPTANCE_SLOW_FINISH_MS: "1000" }, 2);
    expect(status).toBe(130);
    expect(stderr).toContain("Second SIGINT: unloading this run's agents and exiting.");
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
    // Only a result file this run printed, if it got that far.
    const printed = stdout.match(/Result: (\S+)/)?.[1];
    if (printed) fs.rmSync(printed, { force: true });
  }, 60_000);

  test("a background step that can't be observed is never Accepted", async () => {
    const before = leftovers();
    const { status, stdout } = await launchdRun({ TT_GATE_ACCEPTANCE_FAULT: "background-timeout", TT_GATE_ACCEPTANCE_STEP_TIMEOUT_MS: "500" });
    expect(status).toBe(1);
    expect(stdout).not.toContain("Accepted:");
    expect(resultOf(stdout)).toMatchObject({ ok: false, finding: "background_unobserved" });
    expect(leftovers().filter((entry) => !before.includes(entry))).toEqual([]);
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
