import { syncInstalledSkills } from "../skill-install.js";
import { runFirstRunMcpMigration } from "../update-migration.js";
import {
  detectInstallSource,
  resolveCurrentBinaryPath
} from "../self-update.js";
import { isKnownHarnessCliEnv } from "./identity.js";
import { getCommand } from "./registry.js";
import type { ParsedCommand } from "./parser.js";

export async function runStartupMaintenance(
  parsed: ParsedCommand,
  cliEntryUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (shouldRunFirstRunMcpMigration(parsed, cliEntryUrl, env)) {
    try {
      await runFirstRunMcpMigration({
        installOptions: { env }
      });
    } catch {
      // Startup cleanup is best-effort. Explicit install, uninstall, and
      // self-update paths surface cleanup failures directly.
    }
  }

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

export function shouldRunFirstRunMcpMigration(
  parsed: ParsedCommand,
  cliEntryUrl: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.TALKING_STICK_DISABLE_MCP_MIGRATION?.trim()) {
    return false;
  }

  const command = getCommand(parsed.name);
  if (!command?.startupMaintenance) {
    return false;
  }

  const source = detectInstallSource({
    binaryPath: resolveCurrentBinaryPath(cliEntryUrl)
  });
  return source !== "dev" && source !== "unknown";
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
