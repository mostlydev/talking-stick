import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { type InstallOptions } from "../src/install.js";
import {
  type AuditEntry,
  FileAuditLog,
  NoopAuditLog,
  defaultAuditLogPath
} from "../src/install-audit.js";
import { removeStaleMcpRegistrations } from "../src/install-migration.js";

interface MemoryFs {
  files: Map<string, string>;
  dirs: Set<string>;
  hooks: Pick<InstallOptions, "readFile" | "writeFile" | "ensureDir" | "pathExists" | "which">;
}

function memoryFs(seed: Record<string, string> = {}, dirs: string[] = []): MemoryFs {
  const files = new Map<string, string>(Object.entries(seed));
  const dirSet = new Set(dirs);
  return {
    files,
    dirs: dirSet,
    hooks: {
      readFile: (filePath) => files.get(filePath) ?? null,
      writeFile: (filePath, data) => {
        files.set(filePath, data);
      },
      ensureDir: (dirPath) => {
        dirSet.add(dirPath);
      },
      pathExists: (filePath) => files.has(filePath) || dirSet.has(filePath),
      which: () => null
    }
  };
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-migration-"));
  tempRoots.push(dir);
  return dir;
}

describe("removeStaleMcpRegistrations", () => {
  test("removes the canonical opencode entry and preserves unrelated MCP servers", async () => {
    const memory = memoryFs(
      {
        "/home/u/.config/opencode/opencode.json": JSON.stringify({
          mcp: {
            "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true },
            "another-server": { type: "local", command: ["other", "stdio"], enabled: true }
          }
        })
      },
      ["/home/u/.config/opencode"]
    );

    const audit: AuditEntry[] = [];
    await removeStaleMcpRegistrations({
      harnesses: ["opencode"],
      reason: "update",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        env: {},
        platform: "linux",
        homeDir: "/home/u",
        skipMissing: true,
        ...memory.hooks
      }
    });

    const after = JSON.parse(memory.files.get("/home/u/.config/opencode/opencode.json")!);
    expect(after.mcp["talking-stick"]).toBeUndefined();
    expect(after.mcp["another-server"]).toEqual({
      type: "local",
      command: ["other", "stdio"],
      enabled: true
    });
    expect(audit).toEqual([
      expect.objectContaining({
        harness: "opencode",
        action: "removed",
        server_name: "talking-stick",
        config_path: "/home/u/.config/opencode/opencode.json",
        reason: "update"
      })
    ]);
  });

  test("preserves a hand-edited opencode entry whose value differs from the canonical install", async () => {
    const handEdited = {
      type: "local",
      command: ["tt", "mcp", "--debug"], // user added a flag
      enabled: true
    };
    const memory = memoryFs(
      {
        "/home/u/.config/opencode/opencode.json": JSON.stringify({
          mcp: { "talking-stick": handEdited }
        })
      },
      ["/home/u/.config/opencode"]
    );

    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: ["opencode"],
      reason: "update",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        env: {},
        platform: "linux",
        homeDir: "/home/u",
        skipMissing: true,
        ...memory.hooks
      }
    });

    const after = JSON.parse(memory.files.get("/home/u/.config/opencode/opencode.json")!);
    expect(after.mcp["talking-stick"]).toEqual(handEdited);
    expect(results).toEqual([
      expect.objectContaining({ harness: "opencode", action: "preserved" })
    ]);
    expect(audit).toEqual([expect.objectContaining({ action: "preserved" })]);
  });

  test("reports absent when no opencode config file exists", async () => {
    const memory = memoryFs({}, ["/home/u/.config/opencode"]);

    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: ["opencode"],
      reason: "first-run",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        env: {},
        platform: "linux",
        homeDir: "/home/u",
        skipMissing: true,
        ...memory.hooks
      }
    });

    expect(results).toEqual([expect.objectContaining({ harness: "opencode", action: "skipped" })]);
    expect(audit[0]).toMatchObject({ harness: "opencode", action: "skipped", reason: "first-run" });
  });

  test("is idempotent on second run", async () => {
    const memory = memoryFs(
      {
        "/home/u/.config/opencode/opencode.json": JSON.stringify({
          mcp: { "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true } }
        })
      },
      ["/home/u/.config/opencode"]
    );

    const baseOptions = {
      harnesses: ["opencode"] as const,
      reason: "update" as const,
      audit: new NoopAuditLog(),
      installOptions: {
        env: {},
        platform: "linux" as const,
        homeDir: "/home/u",
        skipMissing: true,
        ...memory.hooks
      }
    };

    const first = await removeStaleMcpRegistrations(baseOptions);
    const second = await removeStaleMcpRegistrations(baseOptions);

    expect(first[0].action).toBe("removed");
    expect(second[0].action).toBe("absent");
  });

  test("removes by name on exec harnesses (claude-code) and audits the removal", async () => {
    const calls: string[][] = [];
    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: ["claude-code"],
      reason: "update",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        which: () => "/usr/local/bin/claude",
        run: async (_command, args) => {
          calls.push(args);
          if (args[1] === "get") {
            return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
          }
          return { exitCode: 0, stdout: "Removed talking-stick", stderr: "" };
        }
      }
    });

    expect(results).toEqual([expect.objectContaining({ harness: "claude-code", action: "removed" })]);
    expect(calls).toEqual([
      ["mcp", "get", "talking-stick"],
      ["mcp", "remove", "-s", "user", "talking-stick"]
    ]);
    expect(audit[0]).toMatchObject({ harness: "claude-code", action: "removed", server_name: "talking-stick" });
  });

  test("reports absent when claude has no talking-stick entry", async () => {
    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: ["claude-code"],
      reason: "update",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        which: () => "/usr/local/bin/claude",
        run: async (_command, args) => {
          if (args[1] === "get") {
            return { exitCode: 1, stdout: "", stderr: "not found" };
          }
          throw new Error("should not run mcp remove when entry is absent");
        }
      }
    });

    expect(results).toEqual([expect.objectContaining({ harness: "claude-code", action: "absent" })]);
    expect(audit[0]).toMatchObject({ harness: "claude-code", action: "absent" });
  });

  test("skips harnesses whose CLI is not on PATH when skipMissing is true", async () => {
    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: ["codex"],
      reason: "update",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: { skipMissing: true, which: () => null }
    });

    expect(results).toEqual([expect.objectContaining({ harness: "codex", action: "skipped" })]);
    expect(audit[0]).toMatchObject({ harness: "codex", action: "skipped" });
  });

  test("processes all supported harnesses when harnesses === 'all'", async () => {
    const memory = memoryFs({}, ["/home/u/.config/opencode"]);
    const audit: AuditEntry[] = [];
    const results = await removeStaleMcpRegistrations({
      harnesses: "all",
      reason: "uninstall",
      audit: { append: (entry) => audit.push(entry as AuditEntry) },
      installOptions: {
        env: {},
        platform: "linux",
        homeDir: "/home/u",
        skipMissing: true,
        which: () => null,
        ...memory.hooks
      }
    });

    expect(results.map((r) => r.harness).sort()).toEqual(
      ["claude-code", "codex", "antigravity", "gemini", "grok", "opencode"].sort()
    );
    expect(audit).toHaveLength(6);
    for (const entry of audit) {
      expect(entry.reason).toBe("uninstall");
    }
  });
});

describe("FileAuditLog", () => {
  test("appends one JSONL entry per call and creates the parent directory", () => {
    const dataDir = makeTempDataDir();
    const auditPath = defaultAuditLogPath(path.join(dataDir, "deeper"));
    const log = new FileAuditLog(auditPath);

    log.append({
      reason: "update",
      package_version_from: "0.2.0",
      package_version_to: "0.3.0",
      harness: "claude-code",
      action: "removed",
      server_name: "talking-stick",
      detail: "removed"
    });
    log.append({
      reason: "update",
      harness: "opencode",
      action: "preserved",
      server_name: "talking-stick"
    });

    const lines = fs
      .readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      reason: "update",
      harness: "claude-code",
      action: "removed",
      server_name: "talking-stick",
      package_version_from: "0.2.0",
      package_version_to: "0.3.0"
    });
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
