import { describe, expect, test } from "vitest";
import {
  detectInstallSource,
  isPackageManager,
  planSelfUpdate
} from "../src/self-update.js";

describe("detectInstallSource", () => {
  test("detects npm via the standard global node_modules layout", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/Users/wojtek/.local/share/mise/installs/node/lts/lib/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("npm");
  });

  test("detects npm when installed under Homebrew's node prefix", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/opt/homebrew/lib/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("npm");
  });

  test("detects pnpm under ~/.local/share/pnpm", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/home/wojtek/.local/share/pnpm/global/5/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("pnpm");
  });

  test("detects pnpm under a pnpm/global segment", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/usr/local/share/pnpm/global/5/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("pnpm");
  });

  test("detects yarn classic global", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/Users/wojtek/.config/yarn/global/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("yarn");
  });

  test("detects bun global", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "/Users/wojtek/.bun/install/global/node_modules/talking-stick/dist/cli.js"
      })
    ).toBe("bun");
  });

  test("treats a checked-out source tree as dev", () => {
    expect(
      detectInstallSource({
        binaryPath: "/Users/wojtek/dev/ai/talking-stick/dist/cli.js"
      })
    ).toBe("dev");
  });

  test("normalizes Windows-style backslashes when matching", () => {
    expect(
      detectInstallSource({
        binaryPath:
          "C:\\Users\\wojtek\\AppData\\Roaming\\npm\\node_modules\\talking-stick\\dist\\cli.js"
      })
    ).toBe("npm");
  });
});

describe("planSelfUpdate", () => {
  test("returns the right command per package manager", () => {
    expect(planSelfUpdate("npm")).toMatchObject({
      command: "npm",
      args: ["install", "-g", "talking-stick@latest"]
    });
    expect(planSelfUpdate("pnpm")).toMatchObject({
      command: "pnpm",
      args: ["install", "-g", "talking-stick@latest"]
    });
    expect(planSelfUpdate("yarn")).toMatchObject({
      command: "yarn",
      args: ["global", "add", "talking-stick@latest"]
    });
    expect(planSelfUpdate("bun")).toMatchObject({
      command: "bun",
      args: ["add", "-g", "talking-stick@latest"]
    });
  });

  test("returns null for dev / unknown sources so the CLI can surface a clear error", () => {
    expect(planSelfUpdate("dev")).toBeNull();
    expect(planSelfUpdate("unknown")).toBeNull();
  });

  test("descriptions match the actual command line for --print", () => {
    expect(planSelfUpdate("npm")?.description).toBe(
      "npm install -g talking-stick@latest"
    );
    expect(planSelfUpdate("pnpm")?.description).toBe(
      "pnpm install -g talking-stick@latest"
    );
    expect(planSelfUpdate("yarn")?.description).toBe(
      "yarn global add talking-stick@latest"
    );
    expect(planSelfUpdate("bun")?.description).toBe(
      "bun add -g talking-stick@latest"
    );
  });
});

describe("isPackageManager", () => {
  test("accepts the four known managers", () => {
    expect(isPackageManager("npm")).toBe(true);
    expect(isPackageManager("pnpm")).toBe(true);
    expect(isPackageManager("yarn")).toBe(true);
    expect(isPackageManager("bun")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isPackageManager("dev")).toBe(false);
    expect(isPackageManager("")).toBe(false);
    expect(isPackageManager("Yarn")).toBe(false); // case-sensitive
  });
});
