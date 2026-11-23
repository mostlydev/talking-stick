import path from "node:path";
import { spawn } from "node:child_process";
import {
  SUPPORTED_HARNESSES,
  planSessionHooks,
  detectHarness,
  parseHarnessList,
  planClaudeStopGuardInstall,
  planClaudeStopGuardUninstall,
  planGrokSessionHookInstall,
  planGrokSessionHookUninstall,
  planGrokStopHookInstall,
  planGrokStopHookUninstall,
  planGrokInboxHookInstall,
  planGrokInboxHookUninstall,
  runAction,
  type HarnessId,
  type InstallAction,
  type InstallResult,
  type InstallStatus
} from "../install.js";
import {
  removeDuplicateSkillInstalls,
  planSkillInstall,
  BUNDLED_SKILL_NAMES,
  planSkillUninstall,
  planSharedSkillUninstall,
  resolveDuplicateSkillTargetPaths,
  migrateLegacySkillInstalls
} from "../skill-install.js";
import {
  runSkillerCleanupDuplicates,
  runSkillerDryRun,
  runSkillerInstall,
  runSkillerUninstall
} from "../skiller-adapter.js";
import { resolveDataDir } from "../config.js";
import {
  FileAuditLog,
  defaultAuditLogPath,
  type CleanupResult
} from "../install-audit.js";
import {
  detectInstallSource,
  isPackageManager,
  planSelfUpdate,
  resolveCurrentBinaryPath,
  planStandaloneUpdate,
  STANDALONE_MIGRATION_NOTICE,
  type InstallSource
} from "../self-update.js";
import { createSystemHerdrRunner, type HerdrRunner } from "../herdr.js";
import { chatLinkArgv, installHerdrPlugin, uninstallHerdrPlugin } from "../herdr-plugin.js";
import { shouldUseJson } from "./output.js";
import { isInstalledRelease, isStandalone, standaloneInstallDir, standaloneRoot } from "../standalone-mode.js";
import { advanceCurrentLink, findRemovableNpmCopy, installRoomsAlias, repointManagedSkillLinks, skillLinksInto } from "../standalone-migration.js";
import { acquireUpdateLock } from "../auto-update.js";
import {
  getStringOption,
  hasOption,
  type ParsedCommand
} from "./parser.js";

export async function runInstallCommand(parsed: ParsedCommand, cliEntryUrl: string): Promise<void> {
  const herdr = splitHerdrTarget(parsed);
  if (herdr.requested) {
    runHerdrPluginCommand("install", hasOption(parsed, "print"), { cliEntryUrl });
    if (herdr.rest.positionals.length === 0 && !hasOption(parsed, "all")) return;
    parsed = herdr.rest;
  }
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = {
    link: resolveSkillInstallLinkMode(parsed),
    replace: hasOption(parsed, "replace"),
    skipMissing: true,
    guard: !hasOption(parsed, "no-guard")
  };

  if (dryRun) {
    const skillerLines = installOptions.replace
      ? null
      : await runSkillerDryRun("install", {
          harnesses,
          ...installOptions
        });
    if (skillerLines) {
      for (const line of skillerLines) {
        process.stdout.write(`${line}\n`);
      }
      for (const action of [
        ...harnesses.flatMap(h => planSessionHooks(h, "install", installOptions)),
        ...(harnesses.includes("grok")
          ? [
              planGrokSessionHookInstall(installOptions),
              planGrokInboxHookInstall(installOptions),
              ...(installOptions.guard !== false
                ? [planGrokStopHookInstall(installOptions)]
                : [])
            ]
          : []),
        ...(harnesses.includes("claude-code") && installOptions.guard !== false
          ? [planClaudeStopGuardInstall(installOptions)]
          : [])
      ]) {
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
    printDuplicateSkillCleanupPlan(harnesses, installOptions);
    return;
  }

  reportLegacySkillMigration();
  const skillerResults = installOptions.replace
    ? null
    : await runSkillerInstall({
        harnesses,
        ...installOptions
      });
  const results = skillerResults
    ? [
        ...skillerResults,
        ...await runSkillInstallActions(harnesses.flatMap(h => planSessionHooks(h, "install", installOptions)), installOptions),
        ...(harnesses.includes("grok")
          ? await runSkillInstallActions(
              [
                planGrokSessionHookInstall(installOptions),
                planGrokInboxHookInstall(installOptions),
                ...(installOptions.guard !== false
                  ? [planGrokStopHookInstall(installOptions)]
                  : [])
              ],
              installOptions
            )
          : []),
        ...(harnesses.includes("claude-code") && installOptions.guard !== false
          ? await runSkillInstallActions(
              [planClaudeStopGuardInstall(installOptions)],
              installOptions
            )
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
  const herdr = splitHerdrTarget(parsed);
  if (herdr.requested) {
    runHerdrPluginCommand("uninstall", hasOption(parsed, "print"));
    if (herdr.rest.positionals.length === 0 && !hasOption(parsed, "all") && !hasOption(parsed, "shared")) return;
    parsed = herdr.rest;
  }
  const { harnesses, removeShared } = selectUninstallTargets(parsed);
  const dryRun = hasOption(parsed, "print");
  const installOptions = { skipMissing: true };
  const actions = [
    ...planUninstallActions(harnesses, installOptions),
    ...(removeShared ? BUNDLED_SKILL_NAMES.map((skillName) => planSharedSkillUninstall({ ...installOptions, skillName })) : [])
  ];

  if (dryRun) {
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
      for (const action of [
        ...harnesses.flatMap(h => planSessionHooks(h, "uninstall", installOptions)),
        ...(harnesses.includes("grok")
          ? [
              planGrokSessionHookUninstall({
                ...installOptions,
                skipMissing: false
              }),
              planGrokInboxHookUninstall({ ...installOptions, skipMissing: false }),
              planGrokStopHookUninstall({
                ...installOptions,
                skipMissing: false
              })
            ]
          : []),
        ...(harnesses.includes("claude-code")
          ? [
              planClaudeStopGuardUninstall({
                ...installOptions,
                skipMissing: false
              })
            ]
          : [])
      ]) {
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
        ...await Promise.all(harnesses.flatMap(h => planSessionHooks(h, "uninstall", installOptions)).map(a => runAction(a, installOptions))),
        ...(harnesses.includes("grok")
          ? [
              await runAction(
                planGrokSessionHookUninstall({
                  ...installOptions,
                  skipMissing: false
                }),
                installOptions
              ),
              await runAction(
                planGrokInboxHookUninstall({ ...installOptions, skipMissing: false }), installOptions
              ),
              await runAction(
                planGrokStopHookUninstall({
                  ...installOptions,
                  skipMissing: false
                }),
                installOptions
              )
            ]
          : []),
        ...(harnesses.includes("claude-code")
          ? [
              await runAction(
                planClaudeStopGuardUninstall({
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
    for (const skillName of BUNDLED_SKILL_NAMES) {
      results.push(await runAction(planSharedSkillUninstall({ ...installOptions, skillName }), installOptions));
    }
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
  const installOptions = {
    link,
    replace: hasOption(parsed, "replace"),
    skipMissing: true
  };
  const actions = dedupeInstallActions(
    harnesses.flatMap((harness) => BUNDLED_SKILL_NAMES.map((skillName) => planSkillInstall(harness, { ...installOptions, skillName })))
  );

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  reportLegacySkillMigration();
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
    ...harnesses.flatMap((harness) => BUNDLED_SKILL_NAMES.map((skillName) => planSkillUninstall(harness, { ...installOptions, skillName }))),
    ...(removeShared ? BUNDLED_SKILL_NAMES.map((skillName) => planSharedSkillUninstall({ ...installOptions, skillName })) : [])
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

  if (!managerOverride && isStandalone()) {
    if (!isInstalledRelease()) {
      throw new Error("This tt was not installed by the installer, so it cannot update itself. Install with: curl -fsSL https://raw.githubusercontent.com/mostlydev/shrooms/master/scripts/install.sh | sh");
    }
    const plan = planStandaloneUpdate(standaloneRoot());
    if (dryRun) {
      process.stdout.write(`${plan.description}\n`);
      return;
    }
    const release = acquireUpdateLock(standaloneRoot());
    try {
      process.stdout.write(`Updating via: ${plan.description}\n`);
      await runInheritIo(plan.command, plan.args);
      process.stdout.write("Done. Restart any long-running harness sessions to pick up the new tt.\n");
    } finally {
      release();
    }
    return;
  }

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

  if (isPackageManager(source) && !shouldUseJson(parsed)) process.stderr.write(`${STANDALONE_MIGRATION_NOTICE}\n\n`);
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
  process.stdout.write("Done. Restart any long-running harness sessions to pick up the new tt.\n");
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
    return `${action.kind}:${action.operation ?? "op"}:${action.dedupeKey ?? action.filePath}`;
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
    ...planSessionHooks(harness, "uninstall", installOptions),
    ...BUNDLED_SKILL_NAMES.map((skillName) => planSkillUninstall(harness, {
      ...installOptions,
      skipMissing: false,
      skillName
    })),
    ...(harness === "claude-code"
      ? [
          planClaudeStopGuardUninstall({
            ...installOptions,
            skipMissing: false
          })
        ]
      : []),
    ...(harness === "grok"
      ? [
          planGrokSessionHookUninstall({
            ...installOptions,
            skipMissing: false
          }),
          planGrokInboxHookUninstall({ ...installOptions, skipMissing: false }),
          planGrokStopHookUninstall({
            ...installOptions,
            skipMissing: false
          })
        ]
      : [])
  ]);
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
    ...planSessionHooks(harness, "uninstall", { ...installOptions, skipMissing: false }),
    ...BUNDLED_SKILL_NAMES.map((skillName) => planSkillUninstall(harness, {
      ...installOptions,
      skipMissing: false,
      skillName
    })),
    ...(harness === "claude-code"
      ? [
          planClaudeStopGuardUninstall({
            ...installOptions,
            skipMissing: false
          })
        ]
      : []),
    ...(harness === "grok"
      ? [
          planGrokSessionHookUninstall({
            ...installOptions,
            skipMissing: false
          }),
          planGrokInboxHookUninstall({ ...installOptions, skipMissing: false }),
          planGrokStopHookUninstall({
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
  installOptions: { link: boolean; skipMissing: boolean; guard?: boolean }
): InstallAction[] {
  return [
    ...BUNDLED_SKILL_NAMES.map((skillName) => planSkillInstall(harness, { ...installOptions, skillName })),
    ...planSessionHooks(harness, "install", installOptions),
    ...(harness === "grok"
      ? [
          planGrokSessionHookInstall(installOptions),
          planGrokInboxHookInstall(installOptions),
          ...(installOptions.guard !== false
            ? [planGrokStopHookInstall(installOptions)]
            : [])
        ]
      : []),
    ...(harness === "claude-code" && installOptions.guard !== false
      ? [planClaudeStopGuardInstall(installOptions)]
      : [])
  ];
}

async function runCleanup(
  harnesses: HarnessId[],
  reason: "manual" | "uninstall",
  installOptions: { skipMissing: boolean }
): Promise<CleanupResult[]> {
  const dataDir = resolveDataDir();
  const audit = new FileAuditLog(defaultAuditLogPath(dataDir));
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
  return skillResults;
}

// `herdr` is not a harness: it names the Herdr plugin that turns a Ctrl-click
// on a pinned chat message into an acknowledgement.
function splitHerdrTarget(parsed: ParsedCommand): { requested: boolean; rest: ParsedCommand } {
  const positionals = parsed.positionals.filter((value) => value !== "herdr");
  return { requested: positionals.length !== parsed.positionals.length, rest: { ...parsed, positionals } };
}

export function runHerdrPluginCommand(
  operation: "install" | "uninstall",
  dryRun: boolean,
  options: { cliEntryUrl?: string; runner?: HerdrRunner; dataDir?: string } = {}
): void {
  const dataDir = options.dataDir ?? resolveDataDir();
  if (dryRun) {
    process.stdout.write(operation === "install"
      ? `would link the Herdr plugin talking-stick.chat (runs ${chatLinkArgv(options.cliEntryUrl ?? "").join(" ")})\n`
      : "would unlink the Herdr plugin talking-stick.chat\n");
    return;
  }
  const runner = options.runner ?? createSystemHerdrRunner();
  if (operation === "uninstall") {
    const status = uninstallHerdrPlugin({ runner, dataDir });
    process.stdout.write(`${status === "removed" ? "removed" : "not-installed"} herdr plugin talking-stick.chat\n`);
    return;
  }
  const result = installHerdrPlugin({ runner, dataDir, argv: chatLinkArgv(options.cliEntryUrl ?? "") });
  process.stdout.write(`${result.status} herdr plugin talking-stick.chat (${result.dir})\n`);
}

function selectHarnesses(parsed: ParsedCommand): HarnessId[] {
  if (hasOption(parsed, "all")) {
    const detected = SUPPORTED_HARNESSES.filter(
      (harness) => detectHarness(harness).detected
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

function printSharedSkillLeftHint(
  harnesses: HarnessId[],
  removeShared: boolean
): void {
  if (removeShared) return;
  if (
    !harnesses.some((harness) =>
      harness === "codex" ||
      harness === "grok" ||
      harness === "opencode"
    )
  ) {
    return;
  }
  process.stdout.write(
    "Left ~/.agents/skills/rooms (shared with other agents). Run `tt uninstall --all` or `tt uninstall agents` to remove the shared skill.\n"
  );
}

// Skills still installed under their pre-0.39 names move to the new ones
// before the install, so no harness ends up with both.
function reportLegacySkillMigration(): void {
  for (const result of migrateLegacySkillInstalls({ markOffers: false })) {
    process.stdout.write(`${result.message}\n`);
  }
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
  if (results.some(result => result.ok && result.harness === "codex" &&
      result.action.kind === "file-patch" && result.action.dedupeKey?.endsWith(":lifecycle"))) {
    process.stdout.write("Codex: review and trust the new lifecycle hooks with /hooks.\n");
  }
  const changed = new Set<InstallStatus>(["added", "updated", "ok"]);
  if (!results.some((result) => result.ok && changed.has(result.status))) {
    return;
  }
  process.stdout.write(
    "Customize collaboration instructions with: tt instructions edit\n"
  );
}

export function reportCleanupResults(
  results: CleanupResult[],
  mode: "install" | "uninstall" | "self-update"
): void {
  let anyFailed = false;
  for (const result of results) {
    if (result.action === "absent" || result.action === "skipped") {
      continue;
    }
    process.stdout.write(`[${result.harness}] skill-cleanup ${result.action}: ${result.message}\n`);
    if (result.action === "failed") anyFailed = true;
  }
  if (anyFailed) {
    throw new Error(`${mode} completed with cleanup failures.`);
  }
}

function formatInstallStatus(status: InstallStatus): string {
  return status.replaceAll("_", "-");
}

// Called by scripts/install.sh after it links a new release. Output is one
// fact per line for the shell to read: skill and npm records carry paths,
// and `rooms_*` records describe the optional alias.
export function runPostInstallCommand(binDir: string | undefined): void {
  if (!isStandalone()) throw new Error("post-install runs only from the standalone binary.");
  if (!binDir) throw new Error("Usage: tt post-install --bin-dir DIR");
  if (!isInstalledRelease()) throw new Error("post-install runs only from a release the installer placed under <install-dir>/releases/.");
  const lines = advanceCurrentLink().map((link) => `pinned ${link.path}`);
  try {
    lines.push(installRoomsAlias(binDir) ? "rooms_ready" : "rooms_occupied");
  } catch {
    lines.push("rooms_unavailable");
  }
  // Skills installed under their pre-0.39 names move to the new names, through
  // `current` like every other managed link.
  const current = path.join(standaloneInstallDir(standaloneRoot()), "current", "skills");
  for (const result of migrateLegacySkillInstalls({ markOffers: false, linkSourceFor: (name) => path.join(current, name) })) {
    if (result.status === "renamed") lines.push(`renamed ${result.legacyPath}`);
    else if (result.status !== "failed") lines.push(`kept ${result.legacyPath}`);
  }
  const { repointed, unproven } = repointManagedSkillLinks();
  lines.push(...repointed.map((link) => `repointed ${link.path}`));
  lines.push(...unproven.map((link) => `kept ${link.path}`));
  const npmCopy = findRemovableNpmCopy(binDir);
  if (npmCopy) {
    // Removing the package would strand any skill that still resolves into it.
    const blocking = skillLinksInto(npmCopy.package_dir)[0];
    lines.push(blocking ? `npm_blocked ${blocking}` : `npm_copy ${npmCopy.path}`);
  }
  if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
}
