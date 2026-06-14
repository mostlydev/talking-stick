export type SkillLoadingModel =
  | "proprietary"
  | "shared"
  | "shared+proprietary"
  | "deprecated";

export interface HarnessSkillModel {
  identity: HarnessCliHarness;
  commandLabels: readonly string[];
  skillLoadingModel: SkillLoadingModel;
  deprecated?: boolean;
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
    skillLoadingModel: "shared"
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
  },
  gemini: {
    identity: "gemini",
    commandLabels: ["gemini"],
    skillLoadingModel: "deprecated",
    deprecated: true
  }
} as const;

export type HarnessId = keyof typeof HARNESS_SKILL_MODELS;
export type HarnessCliHarness =
  (typeof HARNESS_SKILL_MODELS)[HarnessId]["identity"];

export type FileSkillHarness = Exclude<HarnessId, "gemini">;

export const SUPPORTED_HARNESSES = Object.keys(
  HARNESS_SKILL_MODELS
) as HarnessId[];

export const FILE_SKILL_HARNESSES = SUPPORTED_HARNESSES.filter(
  (harness): harness is FileSkillHarness =>
    HARNESS_SKILL_MODELS[harness].skillLoadingModel !== "deprecated"
);

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

export function isDeprecatedHarness(harness: HarnessId): boolean {
  const model = HARNESS_SKILL_MODELS[harness] as HarnessSkillModel;
  return model.deprecated === true;
}
