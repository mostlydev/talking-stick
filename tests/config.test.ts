import { describe, expect, test } from "vitest";
import { resolveDataDir } from "../src/config.js";

describe("resolveDataDir", () => {
  test("prefers TALKING_STICK_DATA_DIR when set", () => {
    expect(
      resolveDataDir({
        env: {
          TALKING_STICK_DATA_DIR: "../custom-state",
          XDG_DATA_HOME: "/tmp/xdg",
          APPDATA: "C:\\Users\\wojtek\\AppData\\Roaming"
        },
        platform: "darwin",
        homeDir: "/Users/wojtek"
      })
    ).toBe(requireResolved("../custom-state"));
  });

  test("uses XDG_DATA_HOME on Unix-like systems when present", () => {
    expect(
      resolveDataDir({
        env: {
          XDG_DATA_HOME: "/Users/wojtek/.xdg"
        },
        platform: "linux",
        homeDir: "/Users/wojtek"
      })
    ).toBe("/Users/wojtek/.xdg/talking-stick");

    expect(
      resolveDataDir({
        env: {
          XDG_DATA_HOME: "/Users/wojtek/.xdg"
        },
        platform: "darwin",
        homeDir: "/Users/wojtek"
      })
    ).toBe("/Users/wojtek/.xdg/talking-stick");
  });

  test("falls back to ~/.local/share on macOS and Linux", () => {
    expect(
      resolveDataDir({
        env: {},
        platform: "linux",
        homeDir: "/home/wojtek"
      })
    ).toBe("/home/wojtek/.local/share/talking-stick");

    expect(
      resolveDataDir({
        env: {},
        platform: "darwin",
        homeDir: "/Users/wojtek"
      })
    ).toBe("/Users/wojtek/.local/share/talking-stick");
  });

  test("uses APPDATA on Windows and falls back to AppData/Roaming", () => {
    expect(
      resolveDataDir({
        env: {
          APPDATA: "C:\\Users\\wojtek\\AppData\\Roaming"
        },
        platform: "win32",
        homeDir: "C:\\Users\\wojtek"
      })
    ).toBe("C:\\Users\\wojtek\\AppData\\Roaming\\talking-stick");

    expect(
      resolveDataDir({
        env: {},
        platform: "win32",
        homeDir: "C:\\Users\\wojtek"
      })
    ).toBe("C:\\Users\\wojtek\\AppData\\Roaming\\talking-stick");
  });
});

function requireResolved(relativePath: string): string {
  return new URL(relativePath, `file://${process.cwd()}/`).pathname;
}
