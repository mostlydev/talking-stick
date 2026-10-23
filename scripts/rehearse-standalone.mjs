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

// An isolated HOME keeps startup maintenance away from real installs.
const env = {
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
  XDG_CONFIG_HOME: path.join(home, ".config"), TALKING_STICK_DATA_DIR: path.join(root, "data"),
  TT_ROOM: "", TT_HARNESS_AGENT_ID: "claude:rehearsal",
  TALKING_STICK_DISABLE_SKILL_SYNC: "1", TALKING_STICK_DISABLE_SKILLER: "1"
};
const run = (args, file = tt, prefix = []) => {
  const output = execFileSync(file, [...prefix, ...args, "--json"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  return JSON.parse(output);
};
const check = (condition, message, value) => {
  if (!condition) {
    console.error(`rehearsal failed: ${message}`, value === undefined ? "" : JSON.stringify(value));
    process.exit(1);
  }
  console.log(`ok - ${message}`);
};

try {
  const joined = run(["join"]);
  check(Boolean(joined.room_id), "join creates the repository room", joined);
  const turn = run(["wait", "--claim", "--timeout", "10"]);
  check(turn.status === "your_turn", "wait --claim grants the turn", turn);
  check(Number.isSafeInteger(turn.guardian_pid) && turn.guardian_pid > 0, "the turn has a guardian", turn);
  let guardianAlive = false;
  try { process.kill(turn.guardian_pid, 0); guardianAlive = true; } catch { /* checked below */ }
  check(guardianAlive, "the guardian process is running", turn.guardian_pid);
  const sent = run(["msg", "send", "room", "from the compiled binary"]);
  check(sent.event_seq > 0, "msg send records an event", sent);
  const released = run(["release", "--status", "done", "--next-action", "none"]);
  check(released.status === "released", "release hands the turn back", released);
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
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
