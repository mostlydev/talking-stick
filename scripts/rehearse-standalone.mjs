#!/usr/bin/env node
// Drive a compiled tt through a full turn lifecycle against an isolated data
// directory: join, guardian-backed claim, message, release, notes and leave.
// The release workflow runs it on every platform, including native Windows,
// where the install-script test cannot run.
//
// Usage: node scripts/rehearse-standalone.mjs <path to tt or tt.exe> [node cli.js]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [tt, nodeCli] = process.argv.slice(2);
if (!tt) {
  console.error("usage: rehearse-standalone.mjs <tt> [dist/cli.js]");
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-rehearse-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
execFileSync("git", ["init", "-q", project]);

// An isolated HOME keeps startup maintenance away from real installs, and no
// inherited harness marker may decide the identity instead of the explicit one.
const harnessMarker = /^(TT_|TALKING_STICK_|CLAUDE|CODEX_|GROK_|CMUX_|ANTIGRAVITY_|GEMINI_CLI|OPENCODE|HERDR_)/;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !harnessMarker.test(name))),
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
  XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"),
  TALKING_STICK_DATA_DIR: path.join(root, "data"), TT_HARNESS_AGENT_ID: "claude:rehearsal",
  TALKING_STICK_DISABLE_SKILL_SYNC: "1", TALKING_STICK_DISABLE_SKILLER: "1"
};
const run = (args, file = tt, prefix = []) => {
  const output = execFileSync(file, [...prefix, ...args, "--json"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  return JSON.parse(output);
};
const check = (condition, message, value) => {
  if (!condition) throw new Error(`rehearsal failed: ${message} ${value === undefined ? "" : JSON.stringify(value)}`);
  console.log(`ok - ${message}`);
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let guardian;
try {
  for (const skill of ["talking-stick", "talking-stick-rooms"]) {
    check(fs.existsSync(path.join(path.dirname(tt), "skills", skill, "SKILL.md")), `the archive bundles ${skill}/SKILL.md`);
  }
  const joined = run(["join"]);
  check(Boolean(joined.room_id), "join creates the repository room", joined);
  const turn = run(["wait", "--claim", "--timeout", "10"]);
  check(turn.status === "your_turn", "wait --claim grants the turn", turn);
  check(Number.isSafeInteger(turn.guardian_pid) && turn.guardian_pid > 0, "the turn has a guardian", turn);
  guardian = turn.guardian_pid;
  check(alive(guardian), "the guardian process is running", guardian);
  const sent = run(["msg", "send", "room", "from the compiled binary"]);
  check(sent.event_seq > 0, "msg send records an event", sent);
  const released = run(["release", "--status", "done", "--next-action", "none"]);
  check(released.status === "released", "release hands the turn back", released);
  // Release stops the guardian only when its recorded start time proves the
  // PID; a lost start time would leave it running until its heartbeat ends.
  for (let waited = 0; alive(guardian) && waited < 20_000; waited += 100) await sleep(100);
  check(!alive(guardian), "release stops that exact guardian", guardian);
  const state = run(["state"]);
  check(state.room.owner === null, "the room has no owner after release", state.room);
  const note = run(["notes", "add", "from the binary"]);
  const notes = run(["notes", "list"]);
  check(JSON.stringify(notes).includes("from the binary"), "notes add is readable through notes list", note);
  if (nodeCli) {
    const nodeState = run(["state"], process.execPath, [path.resolve(nodeCli)]);
    check(nodeState.room.room_id === state.room.room_id, "the Node build reads the same database", nodeState.room);
  }
  const left = run(["leave"]);
  check(left.status !== undefined, "leave succeeds", left);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
