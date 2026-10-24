import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemHerdrStartRunner, runHerdrStartJson } from "../src/herdr.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-start-runner-"));
  roots.push(root);
  const script = path.join(root, "child.cjs");
  fs.writeFileSync(script, source);
  return { root, script, runner: createSystemHerdrStartRunner({ ...process.env, HERDR_BIN_PATH: process.execPath }) };
}

test("real startup children overlap instead of waiting for each other", async () => {
  const { root, script, runner } = fixture(`const fs=require('node:fs'); const [own,peer]=process.argv.slice(2); fs.writeFileSync(own,'ready'); const timer=setInterval(()=>{if(fs.existsSync(peer)){clearInterval(timer);console.log(JSON.stringify({result:{ready:true}}));}},10);`);
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const results = await Promise.all([
    runHerdrStartJson(runner, [script, a, b], { timeoutMs: 5000 }),
    runHerdrStartJson(runner, [script, b, a], { timeoutMs: 5000 })
  ]);
  expect(results).toEqual([{ ready: true }, { ready: true }]);
});

test("abort waits for its exact child to exit, and a timeout kills its child too", async () => {
  const { root, script, runner } = fixture(`require('node:fs').writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
  const pidFile = path.join(root, "pid");
  const controller = new AbortController();
  const pending = runner([script, pidFile], { timeoutMs: 5000, signal: controller.signal });
  // Attach the rejection assertion before abort to avoid an unhandled rejection.
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 2000 });
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();
  await rejected;
  expect(() => process.kill(pid, 0)).toThrow();
  fs.rmSync(pidFile);
  await expect(runner([script, pidFile], { timeoutMs: 1500 })).rejects.toThrow();
  expect(fs.existsSync(pidFile)).toBe(true);
  const timedOutPid = Number(fs.readFileSync(pidFile, "utf8"));
  expect(() => process.kill(timedOutPid, 0)).toThrow();
});
