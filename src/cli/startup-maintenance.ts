import { syncInstalledSkills } from "../skill-install.js";
import { updateInstructions } from "../instructions.js";
import { getCommand } from "./registry.js";
import type { ParsedCommand } from "./parser.js";

export async function runStartupMaintenance(
  parsed: ParsedCommand,
  cliEntryUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  void cliEntryUrl;

  const command = getCommand(parsed.name);
  if (!command?.startupMaintenance) {
    return;
  }

  try {
    const updates = updateInstructions({
      markOffers: true,
      options: { env, homeDir: env.HOME }
    });
    for (const update of updates) {
      if (update.status === "updated") {
        process.stderr.write(`Talking Stick updated unedited ${update.scope} instructions: ${update.path}\n`);
      } else if (update.status === "update_available" && update.offer) {
        process.stderr.write(`Talking Stick preserved customized ${update.scope} instructions. Run \`tt instructions update --${update.scope} --replace\` to replace them: ${update.path}\n`);
      }
    }
    if (!shouldAutoSyncInstalledSkills(parsed, env)) {
      return;
    }
    const sync = syncInstalledSkills({
      skipMissing: true,
      env,
      homeDir: env.HOME
    });
    for (const target of sync.targets) {
      if (target.status === "update_available" && target.offer) {
        process.stderr.write(`Talking Stick preserved customized skill instructions at ${target.targetPath}. Run \`tt install ${target.harness} --replace\` to replace them.\n`);
      }
    }
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

  return getCommand(parsed.name)?.startupMaintenance ?? true;
}
