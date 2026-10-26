import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = fileURLToPath(new URL("../scripts/attended-gate-acceptance.mjs", import.meta.url));
const built = fs.existsSync(fileURLToPath(new URL("../dist/supervisor/human-gate.js", import.meta.url)));

// The attended run asks a human; only its scripted self-test runs here, and never a real dialog.
describe.skipIf(!built || process.platform === "win32")("the attended gate acceptance kit", () => {
  test("its self-test runs every step against a confined fixture worker, and cleans up", () => {
    const output = execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf8", timeout: 60_000 });
    for (const step of ["a confined, eligible worker is running", "1: a confirmed approval is allowed and delivered",
      "2: a replay is refused without a dialog", "3: a cancelled dialog refuses, and the request stays pending",
      "4: a later confirmation decides only that request"]) expect(output).toContain(step);
    const file = output.match(/Result: (\S+)/)![1];
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file);
    expect(result).toMatchObject({ ok: true, self_test: true });
    expect(result.audit.map((row: { action: string }) => row.action))
      .toEqual(["control_approve_confirmed", "control_approve_refused", "control_approve_confirmed"]);
  });

  test("the attended run refuses inside a harness session, asking nothing", () => {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CLAUDECODE: "1" }, timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("doesn't run inside");
    expect(path.basename(script)).toBe("attended-gate-acceptance.mjs");
  });
});
