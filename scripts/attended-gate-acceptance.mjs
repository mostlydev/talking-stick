#!/usr/bin/env node
// The attended acceptance of the supervisor's human gate (docs/supervisor.md,
// "Human control"). A human runs it from a repository checkout, after
// `npm run build`, in a plain terminal. It enables nothing: it runs a
// disposable supervisor, with disposable data and state directories, whose
// only worker is the deterministic Codex app-server fixture (no model, no
// credentials), and asks the person at the console to confirm or cancel real
// macOS LocalAuthentication dialogs.
//
// What it accepts: the foreground dialog and its binding to exact requests.
// What it doesn't: the fixture only REPORTS a read-only sandbox, so real OS
// confinement of a worker is not shown here, and neither is launchd showing
// the dialog.
//
//   node scripts/attended-gate-acceptance.mjs              the attended run
//   node scripts/attended-gate-acceptance.mjs --self-test  no dialog: a scripted gate, for CI
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCOPE = "Foreground LocalAuthentication dialog and its binding to exact requests only. The worker is a protocol " +
  "fixture whose read-only sandbox is self-reported, not OS-enforced, so worker confinement is unproven here, " +
  "and so is launchd presenting the dialog.";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = (file) => import(path.join(repo, "dist", file));
const selfTest = process.argv.includes("--self-test");

const { runningInsideHarness } = await dist("identity.js");
const { Supervisor } = await dist("supervisor/daemon.js");
const { SupervisorStore, supervisorDatabasePath } = await dist("supervisor/state.js");
const { CodexAdapter } = await dist("supervisor/adapters/codex.js");
const { gateReason, localAuthenticationGate } = await dist("supervisor/human-gate.js");
const { displayText, safeDetail } = await dist("supervisor/approval-detail.js");
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

const result = { scope: SCOPE, started_at: new Date().toISOString(), self_test: selfTest, steps: [] };
// A signal, or Ctrl-C at a prompt, aborts: the run stops at its next wait or decision, then cleans up.
let abortReason = null;
const abortWaiters = [];
// Aborts a dialog in flight too: the gate sees it as its own signal and refuses, before anything settles.
const runAbort = new AbortController();
const abort = (reason) => {
  if (abortReason) return;
  abortReason = reason;
  runAbort.abort();
  for (const wake of abortWaiters.splice(0)) wake();
};
const aborted = () => new Promise((resolve) => { if (abortReason) resolve(); else abortWaiters.push(resolve); });
const checkAbort = () => { if (abortReason) throw new Error(abortReason); };
const step = (name, detail = {}) => {
  result.steps.push({ step: name, at: new Date().toISOString(), ...detail });
  process.stdout.write(`  ✓ ${name}\n`);
  // Self-test only: the next prompt waits, as a person would, so a test can signal the run mid-way.
  if (selfTest && process.env.TT_GATE_ACCEPTANCE_WAIT_AFTER && name.startsWith(process.env.TT_GATE_ACCEPTANCE_WAIT_AFTER)) waitAtNextPrompt = true;
};
let waitAtNextPrompt = false;
const until = async (what, done, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    checkAbort();
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// Everything from here on is owned, and one cleanup releases it, on success, failure or a signal.
const owned = { root: null, ask: null, store: null, supervisor: null, deciding: null };
let finished = false;
async function finish(outcome) {
  if (finished) return;
  finished = true;
  if (outcome) Object.assign(result, outcome);
  owned.ask?.close();
  // A dialog in flight was aborted with the run; wait until its helper has exited and the decision is refused.
  try { await owned.deciding; } catch { /* recorded where it was awaited */ }
  // Then the fixture worker, and with it anything it owns.
  try { await owned.supervisor?.shutdown(); } catch (error) { result.cleanup_error = String(error); }
  if (owned.store) {
    try {
      result.audit = owned.store.auditRows().filter((row) => row.action.startsWith("control_")).map((row) => ({ at: row.at, action: row.action }));
      // What every request ended as, so an abort can be shown to have settled nothing.
      result.approvals = owned.store.db.prepare("SELECT approval_id, status, answer_status FROM approvals ORDER BY requested_at").all();
      owned.store.close();
    } catch { /* already closed */ }
  }
  if (owned.root) fs.rmSync(owned.root, { recursive: true, force: true });
  result.finished_at = new Date().toISOString();
  const out = path.join(os.tmpdir(), `tt-gate-acceptance-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`\n${result.ok ? "Accepted" : result.aborted ? "Aborted" : "Not accepted"}: ${SCOPE}\nResult: ${out}\n`);
  process.exitCode = result.ok ? 0 : result.aborted ? 130 : 1;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  // The first signal aborts in order; a second one doesn't wait, but still removes the temp root.
  process.on(signal, () => {
    if (!abortReason) return abort(`Stopped by ${signal}.`);
    if (owned.root) fs.rmSync(owned.root, { recursive: true, force: true });
    process.exit(130);
  });
}

try {
  owned.root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "tt-gate-accept-")));
  const stateDir = path.join(owned.root, "state");
  const dataDir = path.join(owned.root, "data");
  const work = path.join(owned.root, "work");
  for (const dir of [stateDir, dataDir, work]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trace = path.join(owned.root, "fixture-trace.jsonl");

  let inner;
  if (selfTest) {
    // A scripted human: confirms what the script expects confirmed, cancels the rest. A delay
    // (self-test only) lets a test signal the run while a "dialog" is up.
    let next = [];
    const delay = Number(process.env.TT_GATE_ACCEPTANCE_CONFIRM_DELAY_MS ?? 0);
    inner = { kind: "scripted", protectedPaths: [], asked: 0, expect: (answers) => { next = answers; },
      confirm: async (_request, signal) => {
        inner.asked++;
        const answer = next.shift() ?? "refused";
        if (!delay) return answer;
        process.stdout.write("  … the gate is asking\n");
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(answer), delay);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve("refused"); }, { once: true });
        });
      } };
  } else {
    const helper = path.join(stateDir, "tt-human-gate");
    process.stdout.write("Building the LocalAuthentication helper (no dialog yet)…\n");
    execFileSync("swiftc", ["-O", path.join(repo, "native", "human-gate", "main.swift"), "-o", helper],
      { stdio: "inherit", timeout: 300_000, killSignal: "SIGKILL" });
    fs.chmodSync(helper, 0o700);
    inner = localAuthenticationGate({ helper, timeoutMs: 120_000 });
    owned.ask = readline.createInterface({ input: process.stdin, output: process.stdout });
    owned.ask.on("SIGINT", () => abort("Stopped by SIGINT."));
  }
  // The gate the supervisor uses: the run's abort reaches the dialog, and nothing answered after it counts.
  const gate = { kind: inner.kind, protectedPaths: inner.protectedPaths, expect: inner.expect?.bind(inner),
    get asked() { return inner.asked; },
    confirm: async (request, signal) => {
      if (runAbort.signal.aborted) return "refused";
      const either = AbortSignal.any([signal, runAbort.signal]);
      const answer = await inner.confirm(request, either);
      return runAbort.signal.aborted ? "refused" : answer;
    } };
  const pause = async (text) => {
    checkAbort();
    if (owned.ask) await Promise.race([owned.ask.question(`\n${text}\nPress Enter when ready… `), aborted()]);
    if (waitAtNextPrompt) {
      waitAtNextPrompt = false;
      process.stdout.write("  … waiting at the prompt\n");
      await Promise.race([aborted(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    }
    checkAbort();
  };

  owned.store = new SupervisorStore(supervisorDatabasePath(stateDir));
  const store = owned.store;
  const fixture = path.join(repo, "tests", "fixtures", "codex-app-server.cjs");
  owned.supervisor = new Supervisor({ store, processLiveness: () => "alive", stateDir, dataDir, gate,
    adapters: { codex: new CodexAdapter({ command: process.execPath, argsPrefix: [fixture], requestTimeoutMs: 2_000, startTimeoutMs: 5_000 }) },
    protectedSet: supervisorProtectedSet() });
  const supervisor = owned.supervisor;
  const actor = `human:${os.userInfo().username}`;

  supervisor.reconcileStartup();
  store.addWorker({ worker_id: "accept", harness: "codex", cwd: work,
    permissions: { harness: "codex", sandbox: "read-only", approval: "on-request" },
    env: [{ name: "FIXTURE_TRACE", from: "literal", value: trace }] }, actor, new Date().toISOString());
  await supervisor.tick();
  if (!supervisor.handle("accept")) throw new Error(`The fixture worker didn't start: ${store.worker("accept")?.hold_reason ?? "unknown"}.`);
  const ineligible = supervisor.gateIneligibility();
  if (ineligible.length) throw new Error(`The gate isn't eligible here, so nothing would be asked: ${ineligible.join(" ")}`);
  step("the fixture worker reports a read-only sandbox, so the eligibility algorithm passes",
    { reported_confinement: supervisor.handle("accept").confinement() });

  // What the fixture was sent: answers to its requests are JSON-RPC replies with that id and no method.
  const answered = (nativeId) => fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .some((message) => !message.method && `n:${message.id}` === nativeId);
  // Waits for the requests one input raises, and returns them in native-id order.
  const raise = async (text, count) => {
    const before = new Set(store.pendingApprovals().map((row) => row.approval_id));
    await supervisor.submit("accept", text, "start_turn", "acceptance");
    let rows = [];
    await until("the fixture's approval requests", () =>
      (rows = store.pendingApprovals().filter((row) => !before.has(row.approval_id))).length === count);
    return rows.sort((a, b) => a.native_request_id.localeCompare(b.native_request_id));
  };
  // What the person reads before deciding: the whole stored request, its full digest, and the dialog's text.
  const show = (row) => {
    const request = { action: "approve", worker_id: row.worker_id, generation: row.generation, approval_id: row.approval_id,
      tool: row.tool, summary: row.summary, detail_sha256: row.detail_sha256 };
    process.stdout.write(`\nRequest ${displayText(row.approval_id, 64)} from ${displayText(row.worker_id, 48)}#${row.generation}\n` +
      `sha256 ${displayText(row.detail_sha256, 64)}\nFull request:\n${safeDetail(row.detail)}\n` +
      `The dialog should read:\n${gateReason(request).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
  };
  const decide = async (row) => {
    checkAbort();
    owned.deciding = supervisor.control({ action: "approve", actor, approval_id: row.approval_id, detail_sha256: row.detail_sha256 });
    const outcome = await owned.deciding;
    // A dialog cut short by the abort is no decision of anyone's.
    checkAbort();
    return outcome;
  };
  const idle = () => until("the turn to finish", () => store.latestGeneration("accept")?.state === "idle");

  // 1. Positive: a human confirms exactly the request they were shown.
  const [first] = await raise("approval", 1);
  show(first);
  gate.expect?.(["confirmed"]);
  await pause("Step 1: a dialog will ask you to allow this request. Read it, then CONFIRM with Touch ID or your password.");
  const allowed = await decide(first);
  if (!allowed.ok || allowed.result?.status !== "allowed" || allowed.result?.answer !== "delivered") {
    throw new Error(`Step 1 expected allowed and delivered, got ${JSON.stringify(allowed)}.`);
  }
  await until("the allowed answer to reach the worker", () => store.approval(first.approval_id)?.answer_status === "delivered");
  step("1: a confirmed approval is allowed and delivered", { approval_id: first.approval_id, control: allowed });

  // 2. A replay asks no one and finds nothing pending.
  gate.expect?.([]);
  const askedBefore = gate.asked;
  const replay = await decide(first);
  if (replay.ok) throw new Error("Step 2 expected the replay to be refused.");
  if (selfTest && gate.asked !== askedBefore) throw new Error("Step 2 asked the gate for a replay.");
  step("2: a replay is refused without a dialog", { control: replay });

  // 3. Two requests pending together, with distinct native ids.
  await idle();
  const [second, third] = await raise("two-approvals", 2);
  step("3: two requests are pending at once", { approvals: [second.approval_id, third.approval_id] });

  // 4. Negative: a cancelled dialog settles neither, and nothing reaches the worker.
  show(second);
  gate.expect?.(["refused"]);
  await pause("Step 4: a dialog will ask about the first of the two. CANCEL it.");
  const refused = await decide(second);
  const untouched = (row) => store.approval(row.approval_id)?.status === "pending" && store.approval(row.approval_id)?.answer_status === null &&
    !answered(row.native_request_id);
  // Only the gate's own refusal is a cancellation: unavailable, ineligible or a transport failure is not.
  if (refused.ok || refused.gate !== "refused" || !untouched(second) || !untouched(third)) {
    throw new Error(`Step 4 expected the gate to refuse, with both untouched, got ${JSON.stringify(refused)}.`);
  }
  step("4: a cancelled dialog refuses, and neither request is settled or answered", { approval_id: second.approval_id, control: refused });

  // 5. Confirming one of two settles exactly that one.
  show(third);
  gate.expect?.(["confirmed"]);
  await pause("Step 5: a dialog will ask about the second of the two. CONFIRM it.");
  const one = await decide(third);
  if (!one.ok || one.result?.answer !== "delivered" || store.approval(third.approval_id)?.status !== "allowed" || !untouched(second)) {
    throw new Error(`Step 5 expected only the second to be allowed, got ${JSON.stringify(one)}.`);
  }
  await until("the allowed answer to reach the worker", () => answered(third.native_request_id));
  step("5: confirming one request decides and answers only that one", { allowed: third.approval_id, untouched: second.approval_id, control: one });

  // 6. An unavailable gate settles nothing either (the helper's exit 2). Only scriptable without a dialog.
  if (selfTest) {
    gate.expect?.(["unavailable"]);
    const unavailable = await decide(second);
    if (unavailable.ok || unavailable.gate !== "unavailable" || !untouched(second)) {
      throw new Error(`Step 6 expected an unavailable gate to settle nothing, got ${JSON.stringify(unavailable)}.`);
    }
    step("6: an unavailable gate settles nothing", { control: unavailable });
  }

  await finish({ ok: true });
} catch (error) {
  const message = abortReason ?? (error instanceof Error ? error.message : String(error));
  process.stderr.write(`\n✗ ${message}\n`);
  await finish({ ok: false, error: message, ...(abortReason ? { aborted: true } : {}) });
}
