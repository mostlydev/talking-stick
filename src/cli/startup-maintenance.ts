import { BUNDLED_SKILL_NAMES, DEFAULT_SKILL_NAME, migrateLegacySkillInstalls, syncInstalledSkills } from "../skill-install.js";
import { updateInstructions } from "../instructions.js";
import { getCommand } from "./registry.js";
import type { ParsedCommand } from "./parser.js";
import { isInstalledRelease, isStandalone } from "../standalone-mode.js";
import { ensureCurrentLink, repointManagedSkillLinks } from "../standalone-migration.js";

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
    // A release installed by the 0.23.0 installer has no `current` link yet,
    // and its skills may still point at the npm package or an old release.
    if (isStandalone() && isInstalledRelease()) {
      ensureCurrentLink();
      if (shouldAutoSyncInstalledSkills(parsed, env)) repointManagedSkillLinks({ env, homeDir: env.HOME });
    }
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
    // Skills installed under their pre-0.39 names move to the new names first,
    // so the sync below finds them. A kept old install is mentioned once.
    for (const result of migrateLegacySkillInstalls({ env, homeDir: env.HOME })) {
      if ((result.status === "kept_customized" || result.status === "kept_occupied") && result.offer) {
        process.stderr.write(`shrooms: ${result.message}\n`);
      }
    }
    const targets = BUNDLED_SKILL_NAMES.flatMap((skillName) => syncInstalledSkills({
      skipMissing: true,
      env,
      homeDir: env.HOME,
      skillName,
      installBesideDefault: skillName !== DEFAULT_SKILL_NAME
    }).targets);
    for (const target of targets) {
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
