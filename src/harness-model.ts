export type SkillLoadingModel =
  | "proprietary"
  | "shared"
  | "shared+proprietary";

export interface HarnessSkillModel {
  identity: HarnessCliHarness;
  commandLabels: readonly string[];
  skillLoadingModel: SkillLoadingModel;
}

export const HARNESS_SKILL_MODELS = {
  "claude-code": {
    identity: "claude",
    commandLabels: ["claude", "claude-code"],
    skillLoadingModel: "proprietary"
  },
  codex: {
    identity: "codex",
    commandLabels: ["codex"],
    skillLoadingModel: "shared+proprietary"
  },
  antigravity: {
    identity: "antigravity",
    commandLabels: ["agy", "antigravity"],
    // agy reads global skills only from its own config folder, not ~/.agents/skills.
    skillLoadingModel: "proprietary"
  },
  grok: {
    identity: "grok",
    commandLabels: ["grok"],
    skillLoadingModel: "shared+proprietary"
  },
  opencode: {
    identity: "opencode",
    commandLabels: ["opencode"],
    skillLoadingModel: "shared+proprietary"
  }
} as const;

export type HarnessId = keyof typeof HARNESS_SKILL_MODELS;
export type HarnessCliHarness =
  (typeof HARNESS_SKILL_MODELS)[HarnessId]["identity"];

export const SUPPORTED_HARNESSES = Object.keys(
  HARNESS_SKILL_MODELS
) as HarnessId[];

export const HARNESS_CLI_HARNESSES = Array.from(
  new Set(
    SUPPORTED_HARNESSES.map((harness) => HARNESS_SKILL_MODELS[harness].identity)
  )
) as HarnessCliHarness[];

export const HARNESS_COMMAND_MAPPING = Object.fromEntries(
  SUPPORTED_HARNESSES.flatMap((harness) =>
    HARNESS_SKILL_MODELS[harness].commandLabels.map((label) => [
      label,
      HARNESS_SKILL_MODELS[harness].identity
    ])
  )
) as Record<string, HarnessCliHarness>;
