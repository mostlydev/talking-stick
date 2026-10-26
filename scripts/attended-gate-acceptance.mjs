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
// --launchd is the separate launchd step: whether the dialog appears when a
// wrapper shell run as a throwaway launchd user agent starts the helper, in the
// GUI session and in the background domain. It doesn't show a supervisor
// LaunchAgent spawning the helper.
//
//   node scripts/attended-gate-acceptance.mjs                         the attended foreground run
//   node scripts/attended-gate-acceptance.mjs --launchd               the attended launchd run
//   node scripts/attended-gate-acceptance.mjs [--launchd] --self-test no dialog and no launchd, for CI
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const launchdMode = process.argv.includes("--launchd");
const SCOPE = launchdMode
  ? "launchd presentation only: whether the helper, run by a wrapper shell that is a throwaway launchd user agent, shows the " +
    "LocalAuthentication dialog in gui/<uid>, and what it does in user/<uid>. It does not show a supervisor LaunchAgent spawning that helper, " +
    "and says nothing about request binding (the foreground run) or worker confinement (command/exec evidence)."
  : "Foreground LocalAuthentication dialog and its binding to exact requests only. The worker is a protocol " +
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
const owned = { root: null, ask: null, store: null, supervisor: null, deciding: null, labels: new Map() };
// launchctl itself, or in the self-test a stand-in that runs the job without launchd.
const launchctl = selfTest ? process.env.TT_GATE_ACCEPTANCE_LAUNCHCTL ?? path.join(repo, "tests", "fixtures", "fake-launchctl.cjs") : "/bin/launchctl";
const runLaunchctl = (args) => spawnSync(launchctl, args, { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
// Unloads every agent this run loaded, then checks it is unloaded and its helper process gone.
// Returns whether all of that was shown; otherwise the evidence stays and the labels are named.
function bootoutAll(only = null) {
  let complete = true;
  for (const [label, entry] of owned.labels) {
    if (only && label !== only) continue;
    const run = runLaunchctl(["bootout", `${entry.domain}/${label}`]);
    const stillLoaded = runLaunchctl(["print", `${entry.domain}/${label}`]).status === 0;
    const pid = fs.existsSync(entry.pidFile) ? Number(fs.readFileSync(entry.pidFile, "utf8").trim()) : null;
    let helper = "never started";
    if (pid) {
      // A signalled helper may take a moment to exit: give it two seconds, and it must then be gone.
      const deadline = Date.now() + 2_000;
      for (;;) {
        try { process.kill(pid, 0); helper = "still running"; } catch { helper = "gone"; break; }
        if (Date.now() > deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    } else if (entry.started) helper = "unknown";
    const ok = !stillLoaded && (helper === "gone" || helper === "never started");
    if (!ok) complete = false;
    (result.bootouts ??= []).push({ label, domain: entry.domain, bootout_status: run.status, unloaded: !stillLoaded, helper_pid: pid, helper, ok });
    if (ok) owned.labels.delete(label);
  }
  writeLedger();
  if (!complete) result.cleanup_incomplete = [...owned.labels.keys()];
  else if (!owned.labels.size) delete result.cleanup_incomplete;
  return complete;
}
// The private record of what this run loaded, written before each load.
function writeLedger() {
  if (!owned.root || !fs.existsSync(owned.root)) return;
  fs.writeFileSync(path.join(owned.root, "ledger.json"), JSON.stringify([...owned.labels].map(([label, entry]) => ({ label, ...entry })), null, 2), { mode: 0o600 });
}
// What the gate makes of the helper's raw exit status.
const gateKind = (exit) => exit === 0 ? "confirmed" : exit === 3 ? "refused" : exit === null ? "timeout" : "unavailable";
let finished = false;
async function finish(outcome) {
  if (finished) return;
  finished = true;
  if (outcome) Object.assign(result, outcome);
  owned.ask?.close();
  let unloaded = true;
  try { unloaded = bootoutAll(); } catch (error) { unloaded = false; result.cleanup_error = String(error); }
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
  // A job that couldn't be shown unloaded keeps its root: the ledger, plist and logs are the evidence.
  if (owned.root && unloaded) fs.rmSync(owned.root, { recursive: true, force: true });
  else if (owned.root) result.retained_root = owned.root;
  result.finished_at = new Date().toISOString();
  const out = path.join(os.tmpdir(), `tt-gate-acceptance-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`\n${result.ok ? "Accepted" : result.aborted ? "Aborted" : "Not accepted"}: ${SCOPE}\n` +
    (result.cleanup_incomplete ? `CLEANUP INCOMPLETE: unload by hand ${result.cleanup_incomplete.join(", ")}; evidence kept in ${owned.root}\n` : "") +
    `Result: ${out}\n`);
  process.exitCode = result.ok ? 0 : result.aborted ? 130 : 1;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  // The first signal aborts in order; a second one doesn't wait, but still removes the temp root.
  process.on(signal, () => {
    if (!abortReason) return abort(`Stopped by ${signal}.`);
    // Still bounded and owned-only: unload what this run loaded, and keep the root unless that was shown.
    let unloaded = false;
    try { unloaded = bootoutAll(); } catch { /* reported below */ }
    if (owned.root && unloaded) fs.rmSync(owned.root, { recursive: true, force: true });
    if (!unloaded) process.stderr.write(`CLEANUP INCOMPLETE: unload by hand ${[...owned.labels.keys()].join(", ")}; evidence kept in ${owned.root}\n`);
    process.exit(130);
  });
}

if (launchdMode) await launchdRun();
else try {
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


/**
 * The launchd step. Each sub-step loads a throwaway user agent (its own label,
 * its plist in the temp root, no KeepAlive) whose only job is the helper,
 * given that step's reason on stdin, writing its exit status into the root.
 */
async function launchdRun() {
  try {
    owned.root = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "tt-gate-launchd-")));
    const uid = process.getuid();
    let helper;
    if (selfTest) {
      helper = path.join(repo, "tests", "fixtures", "fake-gate-helper.cjs");
    } else {
      helper = path.join(owned.root, "tt-human-gate");
      process.stdout.write("Building the LocalAuthentication helper (no dialog yet)…\n");
      execFileSync("swiftc", ["-O", path.join(repo, "native", "human-gate", "main.swift"), "-o", helper],
        { stdio: "inherit", timeout: 300_000, killSignal: "SIGKILL" });
      fs.chmodSync(helper, 0o700);
      owned.ask = readline.createInterface({ input: process.stdin, output: process.stdout });
      owned.ask.on("SIGINT", () => abort("Stopped by SIGINT."));
    }
    const pause = async (text) => {
      checkAbort();
      if (owned.ask) await Promise.race([owned.ask.question(`\n${text}\nPress Enter when ready… `), aborted()]);
      checkAbort();
    };
    const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Self-test only: an injected fault, so the same controller is shown to handle it.
    const fault = selfTest ? process.env.TT_GATE_ACCEPTANCE_FAULT ?? "" : "";
    const stepTimeout = selfTest && process.env.TT_GATE_ACCEPTANCE_STEP_TIMEOUT_MS ? Number(process.env.TT_GATE_ACCEPTANCE_STEP_TIMEOUT_MS) : 150_000;
    // Loads one agent for one dialog and returns what became of it. Every file is named by that
    // agent's own label, and its exit record must carry the label, so no other step's file counts.
    const agent = async (domain, instruction, { waitForAbort = false } = {}) => {
      const label = `com.talking-stick.gate-acceptance.${randomBytes(6).toString("hex")}`;
      const file = (kind) => path.join(owned.root, `${label}.${kind}`);
      const text = `Gate acceptance (${domain.split("/")[0]} domain): ${instruction}. No request is decided by this.`;
      // The helper refuses an empty or over-4096-byte reason before any dialog; never send one.
      if (!text.trim() || Buffer.byteLength(text) > 4096) throw new Error("The step's reason is not a valid dialog reason.");
      fs.writeFileSync(file("reason"), text, { mode: 0o600 });
      // A wrapper shell, the LaunchAgent's program, runs the helper with that reason on stdin,
      // records its pid, and only after it exits writes "<label> <raw status>".
      const job = `"$0" < "$1" & echo $! > "$2"; wait $!; status=$?; echo "$4 $status" > "$3"`;
      const args = ["/bin/sh", "-c", job, helper, file("reason"), file("pid"), file("exit"), label];
      fs.writeFileSync(file("plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xml(file("log"))}</string>
  <key>StandardErrorPath</key><string>${xml(file("log"))}</string>
</dict>
</plist>
`, { mode: 0o600 });
      // The self-test's stand-in can't read a plist: it gets the same job as JSON beside it.
      if (selfTest) fs.writeFileSync(`${file("plist")}.json`, JSON.stringify({ label, args }), { mode: 0o600 });
      // A leftover record with another label: it must not satisfy this step.
      if (fault === "stale-record") fs.writeFileSync(file("exit"), "com.talking-stick.gate-acceptance.stale 0\n");
      process.stdout.write(`\nThe dialog should read:\n    ${text}\n`);
      // In the ledger before it is loaded, so every exit path unloads it.
      owned.labels.set(label, { domain, uid, plist: file("plist"), pidFile: file("pid"), exitFile: file("exit"), started: false });
      writeLedger();
      const loaded = runLaunchctl(["bootstrap", domain, file("plist")]);
      if (loaded.status !== 0) {
        return { domain, label, loaded: false, kind: "infrastructure_error", launchctl_status: loaded.status,
          error: (loaded.stderr || loaded.stdout || "").trim().slice(0, 300) };
      }
      owned.labels.get(label).started = true;
      writeLedger();
      const record = () => {
        if (!fs.existsSync(file("exit"))) return null;
        const [owner, status] = fs.readFileSync(file("exit"), "utf8").trim().split(" ");
        return owner === label && /^\d+$/.test(status ?? "") ? Number(status) : null;
      };
      let exit = null;
      if (waitForAbort) {
        process.stdout.write("  … the dialog is up; press Ctrl-C here without answering it\n");
        // Something has to keep the event loop alive while only a signal can end the wait.
        const alive = setInterval(() => {}, 1_000);
        await aborted();
        clearInterval(alive);
      } else {
        const deadline = Date.now() + stepTimeout;
        while ((exit = record()) === null && Date.now() < deadline) {
          checkAbort();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      // This step's own agent is unloaded and checked now; anything else stays in the ledger, and owned.
      const before = result.bootouts?.length ?? 0;
      const unloaded = bootoutAll(label);
      const check = result.bootouts?.[before] ?? {};
      const kind = waitForAbort ? "aborted" : gateKind(exit);
      return { domain, label, loaded: true, exit, kind, unloaded: check.unloaded === true, helper: check.helper, cleanup_ok: unloaded };
    };
    const gui = `gui/${uid}`;

    await pause("Step 1: a dialog started by a launchd agent will appear. CONFIRM it with Touch ID or your password.");
    const confirmed = await agent(gui, "CONFIRM this one");
    if (confirmed.kind !== "confirmed" || !confirmed.cleanup_ok) throw new Error(`Step 1 expected confirmed and cleaned up, got ${JSON.stringify(confirmed)}.`);
    step("1: a launchd agent's dialog was shown in the GUI session and confirmed", confirmed);

    await pause("Step 2: another dialog from a launchd agent. CANCEL it.");
    const cancelled = await agent(gui, "CANCEL this one");
    if (cancelled.kind !== "refused" || !cancelled.cleanup_ok) throw new Error(`Step 2 expected refused and cleaned up, got ${JSON.stringify(cancelled)}.`);
    step("2: a launchd agent's dialog was cancelled, and the helper refused", cancelled);

    // The background domain has no GUI session: the dialog should be unavailable, not shown.
    await pause("Step 3: an agent in the background domain. No dialog should appear; if one does, CANCEL it and note it.");
    const background = await agent(`user/${uid}`, "in the background domain; CANCEL it if it appears");
    // Recorded as found: a dialog appearing here is a finding about the background domain, not a pass.
    const finding = !background.loaded ? "launchctl did not load the agent in user/<uid> (infrastructure, not a result)"
      : background.exit === 2 ? "the helper was unavailable there (exit 2)"
      : background.exit === 3 ? "FINDING: a dialog appeared in user/<uid> and was cancelled"
      : background.exit === 0 ? "FINDING: a dialog appeared in user/<uid> and was confirmed"
      : background.exit === null ? "the helper never finished there" : `the helper exited ${background.exit}`;
    step(`3: background domain: ${finding}`, { ...background, finding });
    if (background.exit === 0) throw new Error(`Step 3 confirmed in the background domain: ${JSON.stringify(background)}.`);
    // A dialog there at all, even one cancelled, means the background domain can present it: not accepted.
    const backgroundDialog = background.exit === 3;
    if (background.loaded && !background.cleanup_ok) throw new Error(`Step 3's agent couldn't be shown unloaded: ${JSON.stringify(background)}.`);

    await pause("Step 4: one more launchd dialog will appear. Do NOT answer it. Press Ctrl-C in this terminal instead.");
    // This step's Ctrl-C is the expected answer: it aborts only the step, which must leave nothing running.
    const abortedStep = await agent(gui, "do not answer this one; press Ctrl-C in the terminal", { waitForAbort: true });
    if (!abortedStep.cleanup_ok || abortedStep.helper !== "gone") throw new Error(`Step 4 expected the agent and helper gone, got ${JSON.stringify(abortedStep)}.`);
    step("4: an abort with the dialog up unloaded the agent and left no helper running", abortedStep);
    if (backgroundDialog) {
      process.stderr.write("\n✗ A dialog appeared in the background domain; that is a finding, not an acceptance.\n");
      await finish({ ok: false, aborted: false, error: "A dialog appeared in user/<uid>.", finding: "background_dialog" });
    } else {
      await finish({ ok: true, aborted: false, error: undefined });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n✗ ${message}\n`);
    await finish({ ok: false, error: message, ...(abortReason ? { aborted: true } : {}) });
  }
}
