import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertLocalFilesystem,
  detectFilesystemType,
  openDatabase
} from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("filesystem detection", () => {
  test("detectFilesystemType uses Linux stat format", () => {
    let observedArgs: string[] = [];

    const filesystemType = detectFilesystemType("/tmp/talking-stick", {
      platform: "linux",
      execFile(command, args) {
        observedArgs = [command, ...args];
        return "ext4\n" as never;
      }
    });

    expect(filesystemType).toBe("ext4");
    expect(observedArgs).toEqual(["stat", "-f", "-c", "%T", "/tmp"]);
  });

  test("assertLocalFilesystem rejects common remote filesystems", () => {
    expect(() =>
      assertLocalFilesystem("/tmp/talking-stick", {
        platform: "darwin",
        execFile() {
          return "smbfs\n" as never;
        }
      })
    ).toThrow(/local filesystem/i);

    expect(() =>
      assertLocalFilesystem("/tmp/talking-stick", {
        platform: "linux",
        execFile() {
          return "nfs\n" as never;
        }
      })
    ).toThrow(/local filesystem/i);
  });

  test("openDatabase rejects remote filesystems before opening sqlite", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-db-"));
    tempRoots.push(tempRoot);

    expect(() =>
      openDatabase({
        dbPath: path.join(tempRoot, "rooms.sqlite"),
        filesystemTypeOptions: {
          platform: "linux",
          execFile() {
            return "nfs\n";
          }
        }
      })
    ).toThrow(/local filesystem/i);
  });
});
