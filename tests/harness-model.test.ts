import { describe, expect, test } from "vitest";
import {
  FILE_SKILL_HARNESSES,
  HARNESS_ALIASES,
  HARNESS_CLI_HARNESSES,
  HARNESS_COMMAND_MAPPING,
  HARNESS_SKILL_MODELS,
  INSTRUCTION_HARNESSES,
  SUPPORTED_HARNESSES,
  normalizeInstructionHarness,
  skillLoadingModel
} from "../src/index.js";

describe("harness model drift guard", () => {
  test("SUPPORTED_HARNESSES is derived from the skill model map", () => {
    expect(SUPPORTED_HARNESSES).toEqual(Object.keys(HARNESS_SKILL_MODELS));
  });

  test("file skill harnesses match non-deprecated models", () => {
    const expected = SUPPORTED_HARNESSES.filter(
      (harness) => skillLoadingModel(harness) !== "deprecated"
    );

    expect(FILE_SKILL_HARNESSES).toEqual(expected);
  });

  test("command mapping covers every declared command label", () => {
    const expected = Object.fromEntries(
      SUPPORTED_HARNESSES.flatMap((harness) =>
        HARNESS_SKILL_MODELS[harness].commandLabels.map((label) => [
          label,
          HARNESS_SKILL_MODELS[harness].identity
        ])
      )
    );

    expect(HARNESS_COMMAND_MAPPING).toEqual(expected);
  });

  test("identity and instruction harness lists agree with the model", () => {
    const identities = Array.from(
      new Set(
        SUPPORTED_HARNESSES.map((harness) => HARNESS_SKILL_MODELS[harness].identity)
      )
    );

    expect(HARNESS_CLI_HARNESSES).toEqual(identities);
    expect(INSTRUCTION_HARNESSES).toEqual([...identities, "all"]);
    for (const identity of identities) {
      expect(normalizeInstructionHarness(identity)).toBe(identity);
    }
    expect(HARNESS_ALIASES.agy).toBe("antigravity");
  });
});
