import { spawn } from "node:child_process";
import {
  SUPPORTED_HARNESSES,
  detectHarness,
  parseHarnessList,
  planInstall,
  planUninstall,
  runAction,
  type HarnessId,
  type InstallAction,
  type InstallResult,
  type InstallStatus
} from "../install.js";
import {
  planSkillInstall,
  planSkillUninstall
} from "../skill-install.js";
import {
  detectInstallSource,
  isPackageManager,
  planSelfUpdate,
  resolveCurrentBinaryPath,
  type InstallSource
} from "../self-update.js";
import {
  getStringOption,
  hasOption,
  normalizeBooleanFlag,
  type ParsedCommand
} from "./parser.js";

export async function runInstallCommand(parsed: ParsedCommand): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  normalizeBooleanFlag(parsed, "copy");
  normalizeBooleanFlag(parsed, "link");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = {
    link: resolveSkillInstallLinkMode(parsed),
    skipMissing: true
  };

  if (dryRun) {
    for (const action of planCombinedInstallActions(harnesses, installOptions)) {
      printActionPlan(action);
    }
    return;
  }

  const results = (
    await Promise.all(
      harnesses.map((harness) => runCombinedInstall(harness, installOptions))
    )
  ).flat();
  reportInstallResults(results, "install");
}

export async function runUninstallCommand(
  parsed: ParsedCommand
): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = { skipMissing: true };
  const actions = planCombinedUninstallActions(harnesses, installOptions);

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = (
    await Promise.all(
      harnesses.map((harness) => runCombinedUninstall(harness, installOptions))
    )
  ).flat();
  reportInstallResults(results, "uninstall");
}

export async function runInstallSkillCommand(
  parsed: ParsedCommand
): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  normalizeBooleanFlag(parsed, "copy");
  normalizeBooleanFlag(parsed, "link");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const link = resolveSkillInstallLinkMode(parsed);
  const installOptions = { link, skipMissing: true };
  const actions = harnesses.map((harness) =>
    planSkillInstall(harness, installOptions)
  );

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action, installOptions)));
  reportInstallResults(results, "install");
}

export async function runUninstallSkillCommand(
  parsed: ParsedCommand
): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = { skipMissing: true };
  const actions = harnesses.map((harness) => planSkillUninstall(harness, installOptions));

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action, installOptions)));
  reportInstallResults(results, "uninstall");
}

export async function runSelfUpdateCommand(
  parsed: ParsedCommand,
  cliEntryUrl: string
): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const dryRun = hasOption(parsed, "print");
  const managerOverride = getStringOption(parsed, "manager");

  let source: InstallSource;
  if (managerOverride) {
    if (!isPackageManager(managerOverride)) {
      throw new Error(
        `--manager must be one of npm | pnpm | yarn | bun (got ${managerOverride}).`
      );
    }
    source = managerOverride;
  } else {
    const binaryPath = resolveCurrentBinaryPath(cliEntryUrl);
    source = detectInstallSource({ binaryPath });
  }

  const plan = planSelfUpdate(source);
  if (!plan) {
    if (source === "dev") {
      throw new Error(
        "tt is running from a development checkout. Use `git pull && npm install && npm run build` instead of `tt self-update`, or pass `--manager npm|pnpm|yarn|bun` if this is wrong."
      );
    }
    throw new Error(
      `Could not determine how tt was installed. Pass --manager npm|pnpm|yarn|bun to override.`
    );
  }

  if (dryRun) {
    process.stdout.write(`${plan.description}\n`);
    return;
  }

  process.stdout.write(`Updating via: ${plan.description}\n`);
  await runInheritIo(plan.command, plan.args);
  process.stdout.write("Done. Restart your harness MCP subprocess to pick up the new dist.\n");
}

function resolveSkillInstallLinkMode(parsed: ParsedCommand): boolean {
  const wantsCopy = hasOption(parsed, "copy");
  const wantsLink = hasOption(parsed, "link");

  if (wantsCopy && wantsLink) {
    throw new Error("Pass only one of --copy or --link.");
  }

  if (wantsCopy) {
    return false;
  }

  return true;
}

function planCombinedInstallActions(
  harnesses: HarnessId[],
  installOptions: { link: boolean; skipMissing: boolean }
): InstallAction[] {
  return harnesses.flatMap((harness) => {
    const mcpAction = planInstall(harness, installOptions);
    if (mcpAction.kind === "skip") {
      return [mcpAction];
    }

    return [
      mcpAction,
      planSkillInstall(harness, {
        ...installOptions,
        // In dry-run mode, show the skill action that will follow MCP setup
        // even when the MCP installer is what creates the harness config root.
        skipMissing: false
      })
    ];
  });
}

function planCombinedUninstallActions(
  harnesses: HarnessId[],
  installOptions: { skipMissing: boolean }
): InstallAction[] {
  return harnesses.flatMap((harness) => [
    planUninstall(harness, installOptions),
    planSkillUninstall(harness, {
      ...installOptions,
      skipMissing: false
    })
  ]);
}

async function runCombinedInstall(
  harness: HarnessId,
  installOptions: { link: boolean; skipMissing: boolean }
): Promise<InstallResult[]> {
  const mcpAction = planInstall(harness, installOptions);
  const mcpResult = await runAction(mcpAction, installOptions);
  if (!mcpResult.ok || mcpResult.skipped) {
    return [mcpResult];
  }

  const skillAction = planSkillInstall(harness, installOptions);
  const skillResult = await runAction(skillAction, installOptions);
  return [mcpResult, skillResult];
}

async function runCombinedUninstall(
  harness: HarnessId,
  installOptions: { skipMissing: boolean }
): Promise<InstallResult[]> {
  const mcpAction = planUninstall(harness, installOptions);
  const mcpResult = await runAction(mcpAction, installOptions);
  const skillAction = planSkillUninstall(harness, installOptions);
  const skillResult = await runAction(skillAction, installOptions);
  return [mcpResult, skillResult];
}

function selectHarnesses(parsed: ParsedCommand): HarnessId[] {
  if (hasOption(parsed, "all")) {
    const detected = SUPPORTED_HARNESSES.filter((harness) => detectHarness(harness).detected);
    return [...detected];
  }

  if (parsed.positionals.length === 0) {
    throw new Error(
      `Specify at least one harness (${SUPPORTED_HARNESSES.join(", ")}) or pass --all to target every detected one.`
    );
  }

  return parseHarnessList(parsed.positionals);
}

function printActionPlan(action: InstallAction): void {
  if (action.kind === "skip") {
    return;
  }
  if (action.kind === "exec") {
    process.stdout.write(`[${action.harness}] ${action.description}\n`);
    return;
  }
  process.stdout.write(`[${action.harness}] ${action.description}\n`);
}

function runInheritIo(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function reportInstallResults(
  results: InstallResult[],
  mode: "install" | "uninstall"
): void {
  let anyFailed = false;
  for (const result of results) {
    const status = formatInstallStatus(result.status);
    process.stdout.write(`[${result.harness}] ${status}: ${result.message}\n`);
    if (!result.ok) anyFailed = true;
  }
  if (anyFailed) {
    throw new Error(`${mode} completed with failures.`);
  }
}

function formatInstallStatus(status: InstallStatus): string {
  return status.replaceAll("_", "-");
}
