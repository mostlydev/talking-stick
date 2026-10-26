#!/usr/bin/env node
// The attended acceptance of the supervisor's human gate (docs/supervisor.md,
// "Human control"). A human runs it from a repository checkout, after
// `npm run build`, in a plain terminal. It enables nothing: it runs a
// disposable supervisor, with disposable data and state directories, whose
// only worker is the deterministic Codex app-server fixture (read-only, no
// model, no credentials), and asks the person at the console to confirm or
// cancel real macOS LocalAuthentication dialogs.
//
//   node scripts/attended-gate-acceptance.mjs              the attended run
//   node scripts/attended-gate-acceptance.mjs --self-test  no dialog: a scripted gate, for CI
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => import(path.join(repo, "dist", file));
const selfTest = process.argv.includes("--self-test");

const { runningInsideHarness } = await dist("identity.js");
const { Supervisor } = await dist("supervisor/daemon.js");
const { SupervisorStore, supervisorDatabasePath } = await dist("supervisor/state.js");
const { CodexAdapter } = await dist("supervisor/adapters/codex.js");
const { gateReason, localAuthenticationGate } = await dist("supervisor/human-gate.js");
const { supervisorProtectedSet } = await dist("supervisor/run.js");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

// Agents never run the attended path: it would put a dialog in front of a human unasked.
if (!selfTest) {
  const harness = runningInsideHarness();
  if (harness) fail(`This is the operator's own acceptance; it doesn't run inside a ${harness} session.`);
  if (process.platform !== "darwin") fail("The LocalAuthentication gate is macOS only.");
  if (!process.stdin.isTTY) fail("Run it in a terminal: it asks you to confirm and cancel dialogs.");
}

const root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "tt-gate-accept-")));
const stateDir = path.join(root, "state");
const dataDir = path.join(root, "data");
const work = path.join(root, "work");
for (const dir of [stateDir, dataDir, work]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const result = { started_at: new Date().toISOString(), self_test: selfTest, steps: [] };
const step = (name, detail = {}) => {
  result.steps.push({ step: name, at: new Date().toISOString(), ...detail });
  process.stdout.write(`  ✓ ${name}\n`);
};

let gate;
if (selfTest) {
  // A scripted human: confirms what the script expects confirmed, cancels the rest.
  let next = [];
  gate = { kind: "scripted", protectedPaths: [], asked: 0, expect: (answers) => { next = answers; },
    confirm: async () => { gate.asked++; return next.shift() ?? "refused"; } };
} else {
  const helper = path.join(stateDir, "tt-human-gate");
  process.stdout.write("Building the LocalAuthentication helper (no dialog yet)…\n");
  execFileSync("swiftc", ["-O", path.join(repo, "native", "human-gate", "main.swift"), "-o", helper], { stdio: "inherit" });
  fs.chmodSync(helper, 0o700);
  gate = localAuthenticationGate({ helper, timeoutMs: 120_000 });
}

const ask = selfTest ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const pause = async (text) => { if (ask) await ask.question(`\n${text}\nPress Enter when ready… `); };
const until = async (what, done, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const store = new SupervisorStore(supervisorDatabasePath(stateDir));
const fixture = path.join(repo, "tests", "fixtures", "codex-app-server.cjs");
const supervisor = new Supervisor({ store, processLiveness: () => "alive", stateDir, dataDir, gate,
  adapters: { codex: new CodexAdapter({ command: process.execPath, argsPrefix: [fixture], requestTimeoutMs: 2_000, startTimeoutMs: 5_000 }) },
  protectedSet: supervisorProtectedSet() });
const actor = `human:${os.userInfo().username}`;

try {
  supervisor.reconcileStartup();
  store.addWorker({ worker_id: "accept", harness: "codex", cwd: work,
    permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" }, env: [] }, actor, new Date().toISOString());
  await supervisor.tick();
  if (!supervisor.handle("accept")) throw new Error(`The fixture worker didn't start: ${store.worker("accept")?.hold_reason ?? "unknown"}.`);
  const ineligible = supervisor.gateIneligibility();
  if (ineligible.length) throw new Error(`The gate isn't eligible here, so nothing would be asked: ${ineligible.join(" ")}`);
  step("a confined, eligible worker is running", { confinement: supervisor.handle("accept").confinement() });

  const approval = async () => {
    const before = new Set(store.pendingApprovals().map((row) => row.approval_id));
    await supervisor.submit("accept", "approval", "start_turn", "acceptance");
    let row;
    await until("the fixture's approval request", () => (row = store.pendingApprovals().find((r) => !before.has(r.approval_id))) !== undefined);
    return row;
  };
  const show = (row) => {
    const request = { action: "approve", worker_id: row.worker_id, generation: row.generation, approval_id: row.approval_id,
      tool: row.tool, summary: row.summary, detail_sha256: row.detail_sha256 };
    process.stdout.write(`\nThe dialog should read:\n${gateReason(request).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
  };

  // 1. Positive: a human confirms exactly the request they were shown.
  const first = await approval();
  show(first);
  gate.expect?.(["confirmed"]);
  await pause("Step 1: a dialog will ask you to allow this request. Read it, then CONFIRM with Touch ID or your password.");
  const allowed = await supervisor.control({ action: "approve", actor, approval_id: first.approval_id, detail_sha256: first.detail_sha256 });
  if (!allowed.ok || allowed.result?.status !== "allowed") throw new Error(`Step 1 expected allowed, got ${JSON.stringify(allowed)}.`);
  await until("the allowed answer to reach the worker", () => store.approval(first.approval_id)?.answer_status === "delivered");
  step("1: a confirmed approval is allowed and delivered", { approval_id: first.approval_id });

  // 2. A replay asks no one and finds nothing pending.
  gate.expect?.([]);
  const askedBefore = gate.asked;
  const replay = await supervisor.control({ action: "approve", actor, approval_id: first.approval_id, detail_sha256: first.detail_sha256 });
  if (replay.ok) throw new Error("Step 2 expected the replay to be refused.");
  if (selfTest && gate.asked !== askedBefore) throw new Error("Step 2 asked the gate for a replay.");
  step("2: a replay is refused without a dialog", { error: replay.error });

  // 3. Negative: a human cancels, and nothing changes.
  await until("the first turn to finish", () => !supervisor.handle("accept") || store.latestGeneration("accept")?.state === "idle");
  const second = await approval();
  show(second);
  gate.expect?.(["refused"]);
  await pause("Step 3: a dialog will ask about this second request. CANCEL it.");
  const refused = await supervisor.control({ action: "approve", actor, approval_id: second.approval_id, detail_sha256: second.detail_sha256 });
  if (refused.ok || store.approval(second.approval_id)?.status !== "pending") throw new Error(`Step 3 expected a refusal, got ${JSON.stringify(refused)}.`);
  step("3: a cancelled dialog refuses, and the request stays pending", { approval_id: second.approval_id, gate: refused.gate });

  // 4. The same request can still be decided by a later, separate confirmation.
  show(second);
  gate.expect?.(["confirmed"]);
  await pause("Step 4: the same second request is asked again. This time CONFIRM it.");
  const later = await supervisor.control({ action: "approve", actor, approval_id: second.approval_id, detail_sha256: second.detail_sha256 });
  if (!later.ok) throw new Error(`Step 4 expected allowed, got ${JSON.stringify(later)}.`);
  step("4: a later confirmation decides only that request", { approval_id: second.approval_id });

  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n✗ ${result.error}\n`);
} finally {
  ask?.close();
  await supervisor.shutdown();
  result.audit = store.auditRows().filter((row) => row.action.startsWith("control_")).map((row) => ({ at: row.at, action: row.action }));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
  result.finished_at = new Date().toISOString();
  const out = path.join(os.tmpdir(), `tt-gate-acceptance-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`\n${result.ok ? "Accepted" : "Not accepted"}. Result: ${out}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
