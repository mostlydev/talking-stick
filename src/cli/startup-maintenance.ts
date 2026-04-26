import { syncInstalledSkills } from "../skill-install.js";
import { isKnownHarnessCliEnv } from "./identity.js";
import { getCommand } from "./registry.js";
import type { ParsedCommand } from "./parser.js";

export function runStartupMaintenance(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!shouldAutoSyncInstalledSkills(parsed, env)) {
    return;
  }

  try {
    syncInstalledSkills({ skipMissing: true });
  } catch {
    // Skill sync is a best-effort human CLI convenience. It must not make an
    // unrelated tt command fail.
  }
}

export function shouldAutoSyncInstalledSkills(
  parsed: ParsedCommand,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TALKING_STICK_DISABLE_SKILL_SYNC?.trim()) {
    return false;
  }

  if (isKnownHarnessCliEnv(env)) {
    return false;
  }

  return getCommand(parsed.name)?.startupMaintenance ?? true;
}
