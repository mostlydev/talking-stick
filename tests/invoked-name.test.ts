import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { invokedCommandName, usageFor } from "../src/cli/invoked-name.js";
import { COMMAND_REGISTRY, HELP_GROUPS, helpGroups } from "../src/cli/registry.js";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("the invoked name", () => {
  test("Node keeps the link's name in argv[1]; a compiled binary keeps it in argv0", () => {
    expect(invokedCommandName({ standalone: false, argv: ["node", "/usr/local/bin/rooms"] })).toBe("rooms");
    expect(invokedCommandName({ standalone: false, argv: ["node", "/usr/local/bin/tt"] })).toBe("tt");
    expect(invokedCommandName({ standalone: false, argv: ["node", "/repo/dist/cli.js"] })).toBe("tt");
    expect(invokedCommandName({ standalone: false, argv: ["node"] })).toBe("tt");
    expect(invokedCommandName({ standalone: true, argv0: "rooms" })).toBe("rooms");
    expect(invokedCommandName({ standalone: true, argv0: "./bin/rooms" })).toBe("rooms");
    expect(invokedCommandName({ standalone: true, argv0: "C:\\Users\\me\\bin\\Rooms.EXE" })).toBe("rooms");
    expect(invokedCommandName({ standalone: true, argv0: "/home/me/.local/bin/tt" })).toBe("tt");
    expect(invokedCommandName({ standalone: true, argv0: "roomsy" })).toBe("tt");
  });

  test("usage lines take the invoked name, including continuation lines, and nothing else changes", () => {
    const usage = "tt supervisor status\n  tt supervisor add <worker>\n  [--sandbox read-only] uses tt's skill";
    expect(usageFor(usage, "tt")).toBe(usage);
    expect(usageFor(usage, "rooms")).toBe("rooms supervisor status\n  rooms supervisor add <worker>\n  [--sandbox read-only] uses tt's skill");
  });
});

describe("grouped help", () => {
  test("every public command is in exactly one group, and every grouped command exists", () => {
    const publicNames = COMMAND_REGISTRY.filter((entry) => !entry.internal).map((entry) => entry.name).sort();
    const grouped = HELP_GROUPS.flatMap((group) => [...group.commands]);
    expect([...grouped].sort()).toEqual(publicNames);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(helpGroups().map((group) => group.usages.length)).toEqual(HELP_GROUPS.map((group) => group.commands.length));
  });

  test("the built program names itself after the link it was run through", () => {
    const cli = path.resolve("dist/cli.js");
    if (!fs.existsSync(cli)) return; // CI builds dist before the tests.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-invoked-"));
    cleanup.push(dir);
    fs.symlinkSync(cli, path.join(dir, "rooms"));
    fs.symlinkSync(cli, path.join(dir, "tt"));
    const env = { ...process.env, TT_NO_AUTO_UPDATE: "1", TALKING_STICK_DISABLE_SKILL_SYNC: "1" };
    const run = (name: string, args: string[]) =>
      execFileSync(process.execPath, [path.join(dir, name), ...args, "--text"], { env, encoding: "utf8" });
    const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
    expect(run("rooms", ["--version"])).toBe(`rooms ${version}\n`);
    expect(run("tt", ["--version"])).toBe(`tt ${version}\n`);
    const help = run("rooms", ["--help"]);
    expect(help).toMatch(/^Usage: rooms <command> \[options\]/);
    expect(help).toContain("Manage rooms:\n  rooms chat");
    expect(help).toContain("Inside a room (the talking stick):\n  rooms join");
    expect(help).toContain("`tt` is the same program");
    expect(run("rooms", ["wait", "--help"])).toMatch(/^Usage: rooms wait/);
    expect(run("tt", ["wait", "--help"])).toMatch(/^Usage: tt wait/);
  });
});
