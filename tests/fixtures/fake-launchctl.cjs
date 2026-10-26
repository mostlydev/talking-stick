#!/usr/bin/env node
// A stand-in for launchctl in the acceptance kit's self-test: it runs a job
// the kit describes beside its plist, in its own process group, and stops
// that group on bootout. Nothing is loaded into launchd. TT_GATE_ACCEPTANCE_FAULT
// injects a bootstrap or bootout failure.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const registry = path.join(os.tmpdir(), "tt-fake-launchctl");
fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
const fault = process.env.TT_GATE_ACCEPTANCE_FAULT ?? "";
const [command, target, plist] = process.argv.slice(2);
const entry = (label) => path.join(registry, `${label}.pgid`);
if (command === "bootstrap") {
  if (fault === "bootstrap-fail") { process.stderr.write("Bootstrap failed: 5: Input/output error\n"); process.exit(5); }
  const job = JSON.parse(fs.readFileSync(`${plist}.json`, "utf8"));
  const child = spawn(job.args[0], job.args.slice(1), { detached: true, stdio: "ignore", env: { ...process.env, FAKE_DOMAIN: target } });
  fs.writeFileSync(entry(job.label), String(child.pid));
  child.unref();
  process.exit(0);
}
const label = (target ?? "").split("/").pop();
if (command === "bootout") {
  if (fault === "bootout-fail") { process.stderr.write("Boot-out failed: 5: Input/output error\n"); process.exit(5); }
  if (!fs.existsSync(entry(label))) process.exit(3);
  try { process.kill(-Number(fs.readFileSync(entry(label), "utf8")), "SIGTERM"); } catch { /* already gone */ }
  fs.rmSync(entry(label), { force: true });
  process.exit(0);
}
if (command === "print") {
  // Loaded until a bootout succeeds, as with launchd, whether or not its process still runs.
  process.exit(fs.existsSync(entry(label)) ? 0 : 113);
}
process.exit(64);
