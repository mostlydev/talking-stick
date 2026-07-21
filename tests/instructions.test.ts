import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  editInstructions,
  EDITABLE_INSTRUCTIONS_TEMPLATE,
  resetInstructions,
  resolveInstructionHarness,
  resolveInstructionPaths,
  showInstructions,
  updateInstructions
} from "../src/index.js";
import { digestText, recordManagedContent } from "../src/managed-content.js";
import type { DerivedIdentity } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("collaboration instructions", () => {
  test("bundled harness view keeps the shared preamble and selected harness section", () => {
    const result = showInstructions({
      harness: "codex",
      scope: "bundled"
    });

    expect(result.harness).toBe("codex");
    expect(result.text).toContain("tt wait --json");
    expect(result.text).toContain("silently renews internal service waits");
    expect(result.text).toContain("resume only that process");
    expect(result.text).toContain("do not start another wait, narrate timer polls");
    expect(result.text).toContain("tt standby --wake cmux --json");
    expect(result.text).toContain("Wait output is not ambient");
    expect(result.text).not.toContain("## Codex");
  });

  test("effective instructions layer bundled, user, and project files", () => {
    const { dataDir, project, nested } = setupProject();
    fs.writeFileSync(
      path.join(dataDir, "instructions.md"),
      [
        "# User instructions",
        "",
        "User shared preamble.",
        "",
        "## Codex",
        "",
        "User codex guidance.",
        "",
        "## Claude",
        "",
        "User claude guidance."
      ].join("\n")
    );
    fs.mkdirSync(path.join(project, ".talking-stick"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".talking-stick", "instructions.md"),
      [
        "# Project instructions",
        "",
        "Project shared preamble.",
        "",
        "## Codex",
        "",
        "Project codex guidance."
      ].join("\n")
    );

    const result = showInstructions({
      harness: "codex",
      options: {
        contextPath: nested,
        env: { TALKING_STICK_DATA_DIR: dataDir }
      }
    });

    expect(result.sources.map((source) => source.scope)).toEqual([
      "bundled",
      "user",
      "project"
    ]);
    expect(result.text).toContain("## Codex");
    expect(result.text).toContain("User shared preamble.");
    expect(result.text).toContain("User codex guidance.");
    expect(result.text).toContain("Project shared preamble.");
    expect(result.text).toContain("Project codex guidance.");
    expect(result.text).not.toContain("User claude guidance.");
  });

  test("non-harness h2 sections after a harness section do not bleed into that harness", () => {
    const { dataDir, project } = setupProject();
    fs.writeFileSync(
      path.join(dataDir, "instructions.md"),
      [
        "# User instructions",
        "",
        "Shared preamble.",
        "",
        "## Codex",
        "",
        "Codex-only guidance.",
        "",
        "## Troubleshooting",
        "",
        "Do not include this in Codex.",
        "",
        "## Claude",
        "",
        "Claude-only guidance."
      ].join("\n")
    );

    const result = showInstructions({
      harness: "codex",
      scope: "user",
      options: {
        contextPath: project,
        env: { TALKING_STICK_DATA_DIR: dataDir }
      }
    });

    expect(result.text).toContain("Shared preamble.");
    expect(result.text).toContain("Codex-only guidance.");
    expect(result.text).not.toContain("Do not include this in Codex.");
    expect(result.text).not.toContain("Claude-only guidance.");
  });

  test("edit materializes a user file and reset removes it", async () => {
    const { dataDir, project } = setupProject();
    const result = await editInstructions({
      scope: "user",
      options: {
        contextPath: project,
        env: { TALKING_STICK_DATA_DIR: dataDir },
        platform: "linux"
      }
    });

    expect(result.created).toBe(true);
    expect(result.opened).toBe(false);
    expect(result.path).toBe(path.join(dataDir, "instructions.md"));
    expect(fs.readFileSync(result.path, "utf8")).toBe(EDITABLE_INSTRUCTIONS_TEMPLATE);

    const reset = resetInstructions({
      scope: "user",
      options: {
        contextPath: project,
        env: { TALKING_STICK_DATA_DIR: dataDir }
      }
    });

    expect(reset.removed).toBe(true);
    expect(fs.existsSync(result.path)).toBe(false);
  });

  test("instruction update refreshes generated defaults and preserves custom files", () => {
    const { dataDir, project } = setupProject();
    const userPath = path.join(dataDir, "instructions.md");
    const oldGenerated = "# Prior generated Talking Stick instructions\n";
    fs.writeFileSync(userPath, oldGenerated);
    recordManagedContent(
      userPath,
      "editable-instructions",
      digestText(oldGenerated),
      { dataDir }
    );

    const updated = updateInstructions({
      scopes: ["user"],
      options: { contextPath: project, env: { TALKING_STICK_DATA_DIR: dataDir } }
    });
    expect(updated[0].status).toBe("updated");
    expect(fs.readFileSync(userPath, "utf8")).toBe(EDITABLE_INSTRUCTIONS_TEMPLATE);

    fs.writeFileSync(userPath, "# My custom coordination\n");
    const preserved = updateInstructions({
      scopes: ["user"],
      markOffers: true,
      options: { contextPath: project, env: { TALKING_STICK_DATA_DIR: dataDir } }
    });
    expect(preserved[0].status).toBe("update_available");
    expect(preserved[0].offer).toBe(true);
    expect(fs.readFileSync(userPath, "utf8")).toBe("# My custom coordination\n");

    const offeredAgain = updateInstructions({
      scopes: ["user"],
      markOffers: true,
      options: { contextPath: project, env: { TALKING_STICK_DATA_DIR: dataDir } }
    });
    expect(offeredAgain[0].offer).toBe(false);

    const replaced = updateInstructions({
      scopes: ["user"],
      replaceEdited: true,
      options: { contextPath: project, env: { TALKING_STICK_DATA_DIR: dataDir } }
    });
    expect(replaced[0].status).toBe("updated");
    expect(fs.readFileSync(userPath, "utf8")).toBe(EDITABLE_INSTRUCTIONS_TEMPLATE);
  });

  test("show rejects oversized editable instruction files", () => {
    const { dataDir, project } = setupProject();
    fs.writeFileSync(path.join(dataDir, "instructions.md"), "x".repeat(32));

    expect(() =>
      showInstructions({
        harness: "codex",
        options: {
          contextPath: project,
          env: { TALKING_STICK_DATA_DIR: dataDir },
          maxInstructionFileBytes: 16
        }
      })
    ).toThrow(/user instructions file is too large/);
  });

  test("project instructions resolve from the workspace root", () => {
    const { dataDir, project, nested } = setupProject();
    const paths = resolveInstructionPaths({
      contextPath: nested,
      env: { TALKING_STICK_DATA_DIR: dataDir }
    });

    expect(paths.project).toBe(
      path.join(project, ".talking-stick", "instructions.md")
    );
  });

  test("harness detection uses explicit harness before identity fallback", () => {
    const identity: DerivedIdentity = {
      agent_id: "codex:abc12345",
      process_metadata: {
        session_kind: "harness_cli",
        display_name: "codex"
      }
    };

    expect(resolveInstructionHarness(undefined, identity)).toBe("codex");
    expect(resolveInstructionHarness("claude", identity)).toBe("claude");
  });

  test("bundled instructions include Antigravity and retain Gemini alias support", () => {
    const antigravity = showInstructions({
      harness: "agy",
      scope: "bundled"
    });
    expect(antigravity.harness).toBe("antigravity");
    expect(antigravity.text).toContain("tt wait --json");

    expect(resolveInstructionHarness("gemini")).toBe("gemini");
  });
});

function setupProject(): {
  dataDir: string;
  project: string;
  nested: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-instructions-"));
  tempRoots.push(root);
  const dataDir = path.join(root, "data");
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "feature");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  return {
    dataDir,
    project: fs.realpathSync.native(project),
    nested: fs.realpathSync.native(nested)
  };
}
