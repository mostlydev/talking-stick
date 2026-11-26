import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseCommand } from "../src/cli/parser.js";
import { runStartupUpdate } from "../src/cli/startup-update.js";
import { autoUpdate } from "../src/auto-update.js";
import { isStandalone } from "../src/standalone-mode.js";
import { resolveCliIdentity } from "../src/cli/identity.js";
vi.mock("../src/auto-update.js", () => ({ autoUpdate: vi.fn(async () => true) }));
vi.mock("../src/standalone-mode.js", () => ({ isStandalone: vi.fn(() => true), standaloneRoot: () => "/fixture/releases/0.24.1" }));
vi.mock("../src/cli/identity.js", () => ({ resolveCliIdentity: vi.fn(() => ({ source: "human_cli_default" })), isKnownHarnessCliEnv: () => false }));
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
beforeEach(() => {
  vi.stubEnv("TT_NO_AUTO_UPDATE", "");
  vi.stubEnv("TT_HARNESS_EXPORT", "");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  vi.mocked(isStandalone).mockReturnValue(true);
  vi.mocked(resolveCliIdentity).mockReturnValue({ source: "human_cli_default" } as ReturnType<typeof resolveCliIdentity>);
  vi.mocked(autoUpdate).mockClear();
});
afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty); else Reflect.deleteProperty(process.stdin, "isTTY");
  if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty); else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.unstubAllEnvs();
});
test("interactive human chat stops dispatch when an update requires restart", async () => {
  expect(await runStartupUpdate(parseCommand(["chat"]))).toBe(true);
  expect(autoUpdate).toHaveBeenCalledExactlyOnceWith({ releaseRoot: "/fixture/releases/0.24.1" });
});
test.each(["wait", "release", "standby", "msg", "ack", "guard", "session-hook", "post-install", "update", "self-update"])("%s never triggers a startup install", async (command) => {
  expect(await runStartupUpdate(parseCommand([command]))).toBe(false);
  expect(autoUpdate).not.toHaveBeenCalled();
});
test.each([["chat", "--json"], ["up", "--print"]])("%j is side-effect free", async (...args) => {
  expect(await runStartupUpdate(parseCommand(args))).toBe(false);
  expect(autoUpdate).not.toHaveBeenCalled();
});
test("source checkouts, harnesses, redirected input and opt-outs never check the network", async () => {
  vi.mocked(isStandalone).mockReturnValue(false);
  expect(await runStartupUpdate(parseCommand(["chat"]))).toBe(false);
  vi.mocked(isStandalone).mockReturnValue(true);
  vi.mocked(resolveCliIdentity).mockReturnValue({ source: "harness_cli_env_detection" } as ReturnType<typeof resolveCliIdentity>);
  expect(await runStartupUpdate(parseCommand(["chat"]))).toBe(false);
  vi.mocked(resolveCliIdentity).mockReturnValue({ source: "human_cli_default" } as ReturnType<typeof resolveCliIdentity>);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  expect(await runStartupUpdate(parseCommand(["chat"]))).toBe(false);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  vi.stubEnv("TT_NO_AUTO_UPDATE", "1");
  expect(await runStartupUpdate(parseCommand(["chat"]))).toBe(false);
  expect(autoUpdate).not.toHaveBeenCalled();
});
