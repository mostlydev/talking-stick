import {
  deriveHarnessCliIdentity,
  deriveHumanCliIdentity,
  type DerivedIdentity
} from "../index.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";

export interface CliIdentityResolution {
  identity: DerivedIdentity;
  source:
    | "agent_override"
    | "harness_cli_exported_agent_id"
    | "harness_cli_exported_detection"
    | "human_cli_default";
  detail: string;
}

export function deriveCliIdentity(parsed: ParsedCommand): DerivedIdentity {
  return resolveCliIdentity(parsed).identity;
}

export function resolveCliIdentity(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): CliIdentityResolution {
  const agentIdOption = getStringOption(parsed, "agent");
  if (agentIdOption) {
    const displayName = agentIdOption.replace(/^[^:]+:/, "");
    return {
      identity: deriveHumanCliIdentity({
        agentId: agentIdOption,
        displayName
      }),
      source: "agent_override",
      detail: "Resolved from explicit --agent override."
    };
  }

  const harnessIdentity = deriveHarnessCliIdentity({ env });
  if (harnessIdentity) {
    if (env.TT_HARNESS_AGENT_ID?.trim()) {
      return {
        identity: harnessIdentity,
        source: "harness_cli_exported_agent_id",
        detail: "Resolved from explicit TT_HARNESS_AGENT_ID export."
      };
    }

    return {
      identity: harnessIdentity,
      source: "harness_cli_exported_detection",
      detail:
        "Resolved as harness CLI because TT_HARNESS_EXPORT enabled harness-aware detection."
    };
  }

  if (env.TT_HARNESS_EXPORT?.trim()) {
    return {
      identity: deriveHumanCliIdentity(),
      source: "human_cli_default",
      detail:
        "TT_HARNESS_EXPORT was set, but no harness signal matched; defaulted to human CLI identity."
    };
  }

  return {
    identity: deriveHumanCliIdentity(),
    source: "human_cli_default",
    detail: "Defaulted to stable human CLI identity."
  };
}

export function resolveTakeoverReason(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicitReason = getStringOption(parsed, "reason");
  if (explicitReason) {
    return explicitReason;
  }

  if (hasOption(parsed, "operator-requested")) {
    return "operator requested takeover";
  }

  if (isKnownHarnessCliEnv(env)) {
    throw new Error(
      "Missing required option --reason. Harness CLI takeovers must explain why, unless --operator-requested is set."
    );
  }

  return "operator takeover";
}

export function shouldUseOperatorOverride(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    !isKnownHarnessCliEnv(env) ||
    hasOption(parsed, "operator-requested") ||
    hasOption(parsed, "force")
  );
}

export function isKnownHarnessCliEnv(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TT_HARNESS_AGENT_ID?.trim()) {
    return true;
  }

  return deriveHarnessCliIdentity({ env }) !== null;
}
