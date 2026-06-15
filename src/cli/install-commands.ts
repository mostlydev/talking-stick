import { spawn } from "node:child_process";
import {
  SUPPORTED_HARNESSES,
  detectHarness,
  isDeprecatedHarness,
  parseHarnessList,
  planGrokSessionHookInstall,
  planGrokSessionHookUninstall,
  planUninstall,
  runAction,
  type HarnessId,
  type InstallAction,
  type InstallResult,
  type InstallStatus
} from "../install.js";
import {
  removeDuplicateSkillInstalls,
  planSkillInstall,
  planSkillUninstall,
  planSharedSkillUninstall,
  resolveDuplicateSkillTargetPaths
} from "../skill-install.js";
import {
  runSkillerCleanupDuplicates,
  runSkillerDryRun,
  runSkillerInstall,
  runSkillerUninstall
} from "../skiller-adapter.js";
import { resolveDataDir } from "../config.js";
import { FileAuditLog, defaultAuditLogPath, type AuditReason } from "../install-audit.js";
import {
  removeStaleMcpRegistrations,
  type RemoveStaleMcpResult
} from "../install-migration.js";
import {
  detectInstallSource,
  isPackageManager,
  planSelfUpdate,
  resolveCurrentBinaryPath,
  type InstallSource
} from "../self-update.js";
import { readPackageVersion, runStaleMcpCleanup } from "../update-migration.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";

export async function runInstallCommand(parsed: ParsedCommand): Promise<void> {
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = {
    link: resolveSkillInstallLinkMode(parsed),
    skipMissing: true
  };

  if (dryRun) {
    printDeprecatedHarnessNotices(harnesses);
    const skillerLines = await runSkillerDryRun("install", {
      harnesses,
      ...installOptions
    });
    if (skillerLines) {
      for (const line of skillerLines) {
        process.stdout.write(`${line}\n`);
      }
      for (const action of harnesses.includes("grok")
        ? [planGrokSessionHookInstall(installOptions)]
        : []) {
        printActionPlan(action);
      }
      for (const action of planCleanupActions(harnesses, installOptions)) {
        printActionPlan(action);
      }
      const cleanupLines = await runSkillerDryRun("cleanup-duplicates", {
        harnesses,
        ...installOptions
      });
      for (const line of cleanupLines ?? []) {
        process.stdout.write(`${line}\n`);
      }
      return;
    }
    for (const action of dedupeInstallActions(planInstallActions(harnesses, installOptions))) {
      printActionPlan(action);
    }
    for (const action of planCleanupActions(harnesses, installOptions)) {
      printActionPlan(action);
    }
    printDuplicateSkillCleanupPlan(harnesses, installOptions);
    return;
  }

  printDeprecatedHarnessNotices(harnesses);
  const skillerResults = await runSkillerInstall({
    harnesses,
    ...installOptions
  });
  const results = skillerResults
    ? [
        ...skillerResults,
        ...(harnesses.includes("grok")
          ? await runSkillInstallActions([planGrokSessionHookInstall(installOptions)], installOptions)
          : [])
      ]
    : await runSkillInstallActions(
        dedupeInstallActions(planInstallActions(harnesses, installOptions)),
        installOptions
      );
  reportInstallResults(results, "install");
  reportCleanupResults(await runCleanup(harnesses, "manual", installOptions), "install");
  printInstructionHint(results);
}

export async function runUninstallCommand(
  parsed: ParsedCommand
): Promise<void> {
  const { harnesses, removeShared } = selectUninstallTargets(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = { skipMissing: true };
  const actions = [
    ...planUninstallActions(harnesses, installOptions),
    ...(removeShared ? [planSharedSkillUninstall(installOptions)] : [])
  ];

  if (dryRun) {
    printDeprecatedHarnessNotices(harnesses);
    const skillerLines = await runSkillerDryRun("uninstall", {
      harnesses,
      removeShared,
      removeAll: hasOption(parsed, "all"),
      ...installOptions
    });
    if (skillerLines) {
      for (const line of skillerLines) {
        process.stdout.write(`${line}\n`);
      }
      for (const action of harnesses.includes("grok")
        ? [
            planGrokSessionHookUninstall({
              ...installOptions,
              skipMissing: false
            })
          ]
        : []) {
        printActionPlan(action);
      }
      for (const action of planCleanupActions(harnesses, installOptions)) {
        printActionPlan(action);
      }
      printSharedSkillLeftHint(harnesses, removeShared);
      return;
    }
    for (const action of actions) {
      printActionPlan(action);
    }
    printSharedSkillLeftHint(harnesses, removeShared);
    return;
  }

  const skillerResults = await runSkillerUninstall({
    harnesses,
    removeShared,
    removeAll: hasOption(parsed, "all"),
    ...installOptions
  });
  const results = skillerResults
    ? [
        ...skillerResults,
        ...(harnesses.includes("grok")
          ? [
              await runAction(
                planGrokSessionHookUninstall({
                  ...installOptions,
                  skipMissing: false
                }),
                installOptions
              )
            ]
          : [])
      ]
    : (
        await Promise.all(
          harnesses.map((harness) => runSkillUninstall(harness, installOptions))
        )
      ).flat();
  if (!skillerResults && removeShared) {
    results.push(await runAction(planSharedSkillUninstall(installOptions), installOptions));
  }
  reportInstallResults(results, "uninstall");
  printSharedSkillLeftHint(harnesses, removeShared);
  reportCleanupResults(await runCleanup(harnesses, "uninstall", installOptions), "uninstall");
}

export async function runInstallSkillCommand(
  parsed: ParsedCommand
): Promise<void> {
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const link = resolveSkillInstallLinkMode(parsed);
  const installOptions = { link, skipMissing: true };
  const actions = dedupeInstallActions(
    harnesses.map((harness) => planSkillInstall(harness, installOptions))
  );

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  printDeprecatedHarnessNotices(harnesses);
  const results = await Promise.all(actions.map((action) => runAction(action, installOptions)));
  reportInstallResults(results, "install");
}

export async function runUninstallSkillCommand(
  parsed: ParsedCommand
): Promise<void> {
  const { harnesses, removeShared } = selectUninstallTargets(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = { skipMissing: true };
  const actions = [
    ...harnesses.map((harness) => planSkillUninstall(harness, installOptions)),
    ...(removeShared ? [planSharedSkillUninstall(installOptions)] : [])
  ];

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action, installOptions)));
  reportInstallResults(results, "uninstall");
  printSharedSkillLeftHint(harnesses, removeShared);
}

export async function runSelfUpdateCommand(
  parsed: ParsedCommand,
  cliEntryUrl: string
): Promise<void> {
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

  const packageVersionFrom = readPackageVersion(cliEntryUrl);
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
  const packageVersionTo = readPackageVersion(cliEntryUrl);
  const cleanup = await runStaleMcpCleanup({
    harnesses: "all",
    reason: "update",
    packageVersionFrom,
    packageVersionTo,
    installOptions: { skipMissing: true }
  });
  reportCleanupResults(cleanup.results, "self-update");
  process.stdout.write("Done. Restart any long-running harness sessions to pick up the new tt.\n");
}

export async function runMcpMigrationCommand(parsed: ParsedCommand): Promise<void> {
  const reason = parseAuditReason(getStringOption(parsed, "reason") ?? "manual");
  const quiet = hasOption(parsed, "quiet");
  const cleanup = await runStaleMcpCleanup({
    harnesses: "all",
    reason,
    installOptions: { skipMissing: true }
  });

  if (!quiet) {
    reportCleanupResults(cleanup.results, "self-update");
  }
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

function planInstallActions(
  harnesses: HarnessId[],
  installOptions: { link: boolean; skipMissing: boolean }
): InstallAction[] {
  return harnesses.flatMap((harness) => planInstallActionsForHarness(harness, installOptions));
}

function dedupeInstallActions(actions: InstallAction[]): InstallAction[] {
  const seen = new Set<string>();
  const result: InstallAction[] = [];
  for (const action of actions) {
    const key = installActionDedupeKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(action);
  }
  return result;
}

function installActionDedupeKey(action: InstallAction): string {
  if (action.kind === "file-patch") {
    return `${action.kind}:${action.operation ?? "op"}:${action.filePath}`;
  }
  if (action.kind === "exec") {
    return `${action.kind}:${action.operation ?? "op"}:${action.command}:${action.args.join("\0")}`;
  }
  return `${action.kind}:${action.harness}:${action.message}`;
}

function planUninstallActions(
  harnesses: HarnessId[],
  installOptions: { skipMissing: boolean }
): InstallAction[] {
  return harnesses.flatMap((harness) => [
    planSkillUninstall(harness, {
      ...installOptions,
      skipMissing: false
    }),
    ...(harness === "grok"
      ? [
          planGrokSessionHookUninstall({
            ...installOptions,
            skipMissing: false
          })
        ]
      : []),
    planUninstall(harness, installOptions)
  ]);
}

function planCleanupActions(
  harnesses: HarnessId[],
  installOptions: { skipMissing: boolean }
): InstallAction[] {
  return harnesses.map((harness) => planUninstall(harness, installOptions));
}

async function runSkillInstallActions(
  actions: InstallAction[],
  installOptions: { link: boolean; skipMissing: boolean }
): Promise<InstallResult[]> {
  return Promise.all(actions.map((action) => runAction(action, installOptions)));
}

async function runSkillUninstall(
  harness: HarnessId,
  installOptions: { skipMissing: boolean }
): Promise<InstallResult[]> {
  const actions = [
    planSkillUninstall(harness, {
      ...installOptions,
      skipMissing: false
    }),
    ...(harness === "grok"
      ? [
          planGrokSessionHookUninstall({
            ...installOptions,
            skipMissing: false
          })
        ]
      : [])
  ];
  return Promise.all(actions.map((action) => runAction(action, installOptions)));
}

function planInstallActionsForHarness(
  harness: HarnessId,
  installOptions: { link: boolean; skipMissing: boolean }
): InstallAction[] {
  return [
    planSkillInstall(harness, installOptions),
    ...(harness === "grok" ? [planGrokSessionHookInstall(installOptions)] : [])
  ];
}

async function runCleanup(
  harnesses: HarnessId[],
  reason: "manual" | "uninstall",
  installOptions: { skipMissing: boolean }
): Promise<RemoveStaleMcpResult[]> {
  const dataDir = resolveDataDir();
  const audit = new FileAuditLog(defaultAuditLogPath(dataDir));
  const mcpResults = await removeStaleMcpRegistrations({
    harnesses,
    reason,
    audit,
    installOptions
  });
  const skillResults = await runSkillerCleanupDuplicates({
    harnesses,
    reason,
    audit,
    ...installOptions
  }) ?? removeDuplicateSkillInstalls({
    harnesses,
    reason,
    audit,
    ...installOptions
  });
  return [...mcpResults, ...skillResults];
}

function selectHarnesses(parsed: ParsedCommand): HarnessId[] {
  if (hasOption(parsed, "all")) {
    const detected = SUPPORTED_HARNESSES.filter(
      (harness) => !isDeprecatedHarness(harness) && detectHarness(harness).detected
    );
    return [...detected];
  }

  if (parsed.positionals.length === 0) {
    throw new Error(
      `Specify at least one harness (${SUPPORTED_HARNESSES.join(", ")}) or pass --all to target every detected one.`
    );
  }

  return parseHarnessList(parsed.positionals);
}

function selectUninstallTargets(parsed: ParsedCommand): {
  harnesses: HarnessId[];
  removeShared: boolean;
} {
  if (hasOption(parsed, "all")) {
    return { harnesses: [...SUPPORTED_HARNESSES], removeShared: true };
  }

  const removeShared =
    hasOption(parsed, "shared") || parsed.positionals.includes("agents");
  const harnessTokens = parsed.positionals.filter((value) => value !== "agents");

  if (harnessTokens.length === 0) {
    if (removeShared) return { harnesses: [], removeShared: true };
    throw new Error(
      `Specify at least one harness (${SUPPORTED_HARNESSES.join(", ")}, agents) or pass --all to target every installed one.`
    );
  }

  return {
    harnesses: parseHarnessList(harnessTokens),
    removeShared
  };
}

function printDeprecatedHarnessNotices(harnesses: HarnessId[]): void {
  if (!harnesses.includes("gemini")) return;
  process.stdout.write(
    "[gemini] deprecated: Gemini CLI skill install is deprecated; use `tt install antigravity`.\n"
  );
}

function printSharedSkillLeftHint(
  harnesses: HarnessId[],
  removeShared: boolean
): void {
  if (removeShared) return;
  if (
    !harnesses.some((harness) =>
      harness === "codex" ||
      harness === "grok" ||
      harness === "opencode" ||
      harness === "antigravity"
    )
  ) {
    return;
  }
  process.stdout.write(
    "Left ~/.agents/skills/talking-stick (shared with other agents). Run `tt uninstall --all` or `tt uninstall agents` to remove the shared skill.\n"
  );
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

function printDuplicateSkillCleanupPlan(
  harnesses: HarnessId[],
  installOptions: { skipMissing: boolean }
): void {
  for (const harness of harnesses) {
    for (const targetPath of resolveDuplicateSkillTargetPaths(harness, installOptions)) {
      process.stdout.write(
        `[${harness}] remove duplicate skill symlink ${targetPath} if it points at bundled skill\n`
      );
    }
  }
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

export function printInstructionHint(results: InstallResult[]): void {
  const changed = new Set<InstallStatus>(["added", "updated", "ok"]);
  if (!results.some((result) => result.ok && changed.has(result.status))) {
    return;
  }
  process.stdout.write(
    "Customize collaboration instructions with: tt instructions edit\n"
  );
}

export function reportCleanupResults(
  results: RemoveStaleMcpResult[],
  mode: "install" | "uninstall" | "self-update"
): void {
  let anyFailed = false;
  for (const result of results) {
    if (result.action === "absent" || result.action === "skipped") {
      continue;
    }
    const label = result.target_type === "skill" ? "skill-cleanup" : "mcp-cleanup";
    process.stdout.write(`[${result.harness}] ${label} ${result.action}: ${result.message}\n`);
    if (result.action === "failed") anyFailed = true;
  }
  if (anyFailed) {
    throw new Error(`${mode} completed with cleanup failures.`);
  }
}

function formatInstallStatus(status: InstallStatus): string {
  return status.replaceAll("_", "-");
}

function parseAuditReason(value: string): AuditReason {
  if (value === "update" || value === "first-run" || value === "uninstall" || value === "manual") {
    return value;
  }
  throw new Error(`--reason must be one of update | first-run | uninstall | manual (got ${value}).`);
}
