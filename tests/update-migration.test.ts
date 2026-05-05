import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { InstallOptions } from "../src/install.js";
import {
  readUpdateMigrationState,
  resolveUpdateMigrationStatePath,
  runFirstRunMcpMigration,
  runStaleMcpCleanup
} from "../src/update-migration.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("update MCP migration state", () => {
  test("first run removes stale MCP entries and records the package version", async () => {
    const dataDir = makeTempDataDir();
    const memory = memoryFs(
      {
        "/home/u/.config/opencode/opencode.json": JSON.stringify({
          mcp: {
            "talking-stick": { type: "local", command: ["tt", "mcp"], enabled: true }
          }
        })
      },
      ["/home/u/.config/opencode"]
    );

    const run = await runFirstRunMcpMigration({
      packageVersion: "0.3.0",
      dataDir,
      installOptions: {
        env: {},
        platform: "linux",
        homeDir: "/home/u",
        skipMissing: true,
        ...memory.hooks
      }
    });

    expect(run.status).toBe("ran");
    expect(run.results).toContainEqual(
      expect.objectContaining({ harness: "opencode", action: "removed" })
    );
    expect(readUpdateMigrationState(resolveUpdateMigrationStatePath(dataDir))).toMatchObject({
      mcp_cleanup_version: "0.3.0"
    });
    const after = JSON.parse(memory.files.get("/home/u/.config/opencode/opencode.json")!);
    expect(after.mcp["talking-stick"]).toBeUndefined();
  });

  test("first run is skipped when the current package version is already recorded", async () => {
    const dataDir = makeTempDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      resolveUpdateMigrationStatePath(dataDir),
      JSON.stringify({ mcp_cleanup_version: "0.3.0" })
    );

    const run = await runFirstRunMcpMigration({
      packageVersion: "0.3.0",
      dataDir,
      installOptions: { skipMissing: true, which: () => null }
    });

    expect(run.status).toBe("current");
    expect(run.results).toEqual([]);
  });

  test("failed cleanup does not mark the package version migrated", async () => {
    const dataDir = makeTempDataDir();

    const run = await runStaleMcpCleanup({
      harnesses: ["codex"],
      reason: "first-run",
      packageVersionTo: "0.3.0",
      dataDir,
      installOptions: {
        skipMissing: true,
        which: () => "/usr/local/bin/codex",
        run: async (_command, args) => {
          if (args[1] === "get") {
            return { exitCode: 0, stdout: "talking-stick: tt mcp", stderr: "" };
          }
          return { exitCode: 2, stdout: "", stderr: "remove failed" };
        }
      }
    });

    expect(run.results).toEqual([
      expect.objectContaining({ harness: "codex", action: "failed" })
    ]);
    expect(readUpdateMigrationState(resolveUpdateMigrationStatePath(dataDir))).toEqual({});
  });
});

interface MemoryFs {
  files: Map<string, string>;
  dirs: Set<string>;
  hooks: Pick<InstallOptions, "readFile" | "writeFile" | "ensureDir" | "pathExists" | "which">;
}

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-update-migration-"));
  tempRoots.push(dir);
  return dir;
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
