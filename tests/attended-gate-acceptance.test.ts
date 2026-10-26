import fs from "node:fs";
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
  const leftovers = () => fs.readdirSync("/tmp").filter((entry) => entry.startsWith("tt-gate-accept-"));

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

  test("the attended run refuses inside a harness session, asking nothing", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1" }, timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("doesn't run inside");
    expect(path.basename(script)).toBe("attended-gate-acceptance.mjs");
  });
});
