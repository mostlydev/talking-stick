import { afterEach, describe, expect, test, vi } from "vitest";
import {
  printInstructionHint,
  reportCleanupResults
} from "../src/cli/install-commands.js";
import type { InstallResult } from "../src/install.js";
import type { CleanupResult } from "../src/install-audit.js";

function captureStdout(): { lines: () => string[] } {
  const written: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return { lines: () => written.join("").split("\n").filter(Boolean) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportCleanupResults", () => {
  test("stays silent for absent and skipped cleanup results", () => {
    const stdout = captureStdout();
    const results: CleanupResult[] = [
      {
        harness: "claude-code",
        action: "absent",
        message: "duplicate skill is absent",
        target_type: "skill"
      },
      {
        harness: "grok",
        action: "skipped",
        message: "no duplicate target",
        target_type: "skill"
      }
    ];

    reportCleanupResults(results, "install");

    expect(stdout.lines()).toEqual([]);
  });

  test("still reports removed, preserved, and failed cleanup results", () => {
    const stdout = captureStdout();
    const results: CleanupResult[] = [
      {
        harness: "codex",
        action: "removed",
        message: "removed duplicate skill",
        target_type: "skill"
      },
      {
        harness: "opencode",
        action: "preserved",
        message: "custom skill left in place",
        target_type: "skill"
      },
      {
        harness: "gemini",
        action: "failed",
        message: "could not remove duplicate",
        target_type: "skill"
      }
    ];

    expect(() => reportCleanupResults(results, "install")).toThrow(
      /install completed with cleanup failures/
    );
    expect(stdout.lines()).toEqual([
      "[codex] skill-cleanup removed: removed duplicate skill",
      "[opencode] skill-cleanup preserved: custom skill left in place",
      "[gemini] skill-cleanup failed: could not remove duplicate"
    ]);
  });
});

describe("printInstructionHint", () => {
  const result = (status: InstallResult["status"]): InstallResult => ({
    harness: "claude-code",
    ok: status !== "failed",
    action: {
      kind: "skip",
      harness: "claude-code",
      description: "test",
      message: "test"
    },
    status,
    message: "test"
  });

  test("stays silent when every harness is already installed", () => {
    const stdout = captureStdout();

    printInstructionHint([result("already_present"), result("already_absent")]);

    expect(stdout.lines()).toEqual([]);
  });

  test("prints when an install actually changed something", () => {
    const stdout = captureStdout();

    printInstructionHint([result("already_present"), result("added")]);

    expect(stdout.lines()).toEqual([
      "Customize collaboration instructions with: tt instructions edit"
    ]);
  });
});
