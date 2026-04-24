#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearCliSessionLease,
  createSystemProcessInspector,
  deriveHarnessCliIdentity,
  deriveHumanCliIdentity,
  findCliSessionByRoom,
  findCliSessionForContextPath,
  isProtocolError,
  resolveCliSessionPath,
  runStdioServer,
  TalkingStickCommands,
  TalkingStickService,
  terminateKnownProcess,
  type CliSession,
  type DerivedIdentity,
  type Handoff,
  type PathRoom,
  upsertCliSession
} from "./index.js";
import {
  SUPPORTED_HARNESSES,
  detectHarness,
  parseHarnessList,
  planInstall,
  planUninstall,
  runAction,
  type HarnessId,
  type InstallAction,
  type InstallResult
} from "./install.js";
import { planSkillInstall, planSkillUninstall } from "./skill-install.js";
import { resolveContextPath } from "./path-resolution.js";

interface ParsedCommand {
  name: string;
  positionals: string[];
  options: Map<string, string | true>;
}

interface Runtime {
  commands: TalkingStickCommands;
  close: () => void;
}

interface CliIdentityResolution {
  identity: DerivedIdentity;
  source:
    | "agent_override"
    | "harness_cli_exported_agent_id"
    | "harness_cli_exported_detection"
    | "human_cli_default";
  detail: string;
}

const GUARD_READY = "READY";
const STALE_GUARD_ERRORS = new Set(["stale_lease", "turn_mismatch", "room_not_found"]);

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCommand(argv);

  if (!parsed.name || parsed.name === "help" || parsed.name === "--help") {
    printHelp();
    return;
  }

  if (parsed.name === "mcp") {
    await runStdioServer();
    return;
  }

  if (parsed.name === "guard") {
    await runGuardCommand(parsed);
    return;
  }

  if (parsed.name === "install") {
    await runInstallCommand(parsed);
    return;
  }

  if (parsed.name === "uninstall") {
    await runUninstallCommand(parsed);
    return;
  }

  if (parsed.name === "install-skill") {
    await runInstallSkillCommand(parsed);
    return;
  }

  if (parsed.name === "uninstall-skill") {
    await runUninstallSkillCommand(parsed);
    return;
  }

  if (parsed.name === "whoami") {
    handleWhoAmICommand(parsed);
    return;
  }

  const runtime = createRuntime();
  try {
    switch (parsed.name) {
      case "list":
        handleListCommand(runtime, parsed);
        return;
      case "join":
        handleJoinCommand(runtime, parsed);
        return;
      case "state":
        handleStateCommand(runtime, parsed);
        return;
      case "events":
        handleEventsCommand(runtime, parsed);
        return;
      case "wait":
        await handleWaitCommand(runtime, parsed, false);
        return;
      case "try":
        await handleWaitCommand(runtime, parsed, true);
        return;
      case "takeover":
        await handleTakeoverCommand(runtime, parsed);
        return;
      case "release":
        handleReleaseCommand(runtime, parsed);
        return;
      case "pass":
        handlePassCommand(runtime, parsed);
        return;
      default:
        throw new Error(`Unknown command: ${parsed.name}`);
    }
  } finally {
    runtime.close();
  }
}

function createRuntime(): Runtime {
  const service = new TalkingStickService();
  return {
    commands: new TalkingStickCommands(service),
    close: () => service.close()
  };
}

function handleListCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const result = runtime.commands.listRooms({ context_path: contextPath });
  printResult(parsed, result, () => {
    if (result.rooms.length === 0) {
      return "No rooms found.";
    }

    return result.rooms
      .map((room) => {
        const owner = room.owner ? ` owner=${room.owner}` : "";
        const reserved = room.reserved_for
          ? ` reserved_for=${room.reserved_for}`
          : "";
        return `${room.state} ${room.canonical_path}${owner}${reserved}`;
      })
      .join("\n");
  });
}

function handleJoinCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, {
    context_path: contextPath,
    force_new: hasOption(parsed, "force-new")
  });
  upsertSessionFromJoin(identity, joined);

  printResult(parsed, joined, () => {
    return `Joined ${joined.canonical_path} as ${joined.agent_id}`;
  });
}

function handleStateCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  const state = runtime.commands.getRoomState({
    room_id: session.room_id,
    agent_id: identity.agent_id
  });

  printResult(parsed, { room: state.room, members: state.members }, () => {
    const owner = state.room.owner ? ` owner=${state.room.owner}` : "";
    const reserved = state.room.reserved_for
      ? ` reserved_for=${state.room.reserved_for}`
      : "";
    return `${state.room.state} ${session.canonical_path}${owner}${reserved}`;
  });
}

function handleEventsCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const identity = deriveCliIdentity(parsed);
  const session = resolveSessionForReads(runtime, parsed, identity);
  const events = runtime.commands.getRoomEvents({
    room_id: session.room_id,
    agent_id: identity.agent_id,
    after_event_seq: parseOptionalInteger(parsed, "after"),
    limit: parseOptionalInteger(parsed, "limit")
  });

  printResult(parsed, events, () => {
    if (events.length === 0) {
      return "No events.";
    }

    return events
      .map(
        (event) =>
          `${event.event_seq} ${event.event_type} ${event.from_agent_id ?? "-"} -> ${
            event.to_agent_id ?? "-"
          }`
      )
      .join("\n");
  });
}

async function handleWaitCommand(
  runtime: Runtime,
  parsed: ParsedCommand,
  isTry: boolean
): Promise<void> {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);

  const waitResult = await runtime.commands.waitForTurn(identity, {
    room_id: joined.room_id,
    max_wait_ms: isTry ? 0 : parseWaitTimeout(parsed)
  });

  if (waitResult.status === "your_turn") {
    if (waitResult.reason === "already_owner") {
      const existing = findCliSessionByRoom(
        resolveCliSessionPath(),
        identity.agent_id,
        joined.room_id
      );
      const guardianPid = existing?.guardian_pid;
      printResult(
        parsed,
        { ...waitResult, guardian_pid: guardianPid ?? null },
        () =>
          guardianPid
            ? `Already holding the stick (turn ${waitResult.turn_id}). Guardian ${guardianPid} is still active.`
            : `Already holding the stick (turn ${waitResult.turn_id}).`
      );
      return;
    }

    const guardianPid = await spawnGuardian({
      agentId: identity.agent_id,
      canonicalPath: joined.canonical_path,
      roomId: joined.room_id,
      leaseId: waitResult.lease_id,
      turnId: waitResult.turn_id
    });

    upsertCliSession(resolveCliSessionPath(), {
      agent_id: identity.agent_id,
      room_id: joined.room_id,
      canonical_path: joined.canonical_path,
      workspace_root: joined.workspace_root,
      lease_id: waitResult.lease_id,
      turn_id: waitResult.turn_id,
      guardian_pid: guardianPid.pid,
      guardian_process_started_at: guardianPid.process_started_at,
      updated_at: new Date().toISOString()
    });

    printResult(
      parsed,
      { ...waitResult, guardian_pid: guardianPid.pid },
      () => `Your turn. Guardian ${guardianPid.pid} is holding the lease.`
    );
    return;
  }

  printResult(parsed, waitResult, () => formatWaitResult(waitResult));
}

async function handleTakeoverCommand(
  runtime: Runtime,
  parsed: ParsedCommand
): Promise<void> {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const identity = deriveCliIdentity(parsed);
  const joined = runtime.commands.joinPath(identity, { context_path: contextPath });
  upsertSessionFromJoin(identity, joined);

  const availability = await runtime.commands.waitForTurn(identity, {
    room_id: joined.room_id,
    max_wait_ms: 0
  });

  if (availability.status !== "takeover_available") {
    throw new Error(`Takeover is not available: ${formatWaitResult(availability)}`);
  }

  const result = runtime.commands.takeoverStick(identity, {
    room_id: joined.room_id,
    expected_turn_id: availability.turn_id,
    reason: requireStringOption(parsed, "reason")
  });

  const guardianPid = await spawnGuardian({
    agentId: identity.agent_id,
    canonicalPath: joined.canonical_path,
    roomId: joined.room_id,
    leaseId: result.lease_id,
    turnId: result.turn_id
  });

  upsertCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    lease_id: result.lease_id,
    turn_id: result.turn_id,
    guardian_pid: guardianPid.pid,
    guardian_process_started_at: guardianPid.process_started_at,
    updated_at: new Date().toISOString()
  });

  printResult(
    parsed,
    { ...result, guardian_pid: guardianPid.pid },
    () => `Takeover succeeded. Guardian ${guardianPid.pid} is holding the lease.`
  );
}

function handleReleaseCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const session = requireLeaseSession(identity, contextPath);
  const handoff = requireHandoff(parsed);
  const result = runtime.commands.releaseStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    handoff
  });

  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );

  printResult(parsed, result, () => {
    const target = result.reserved_for ? ` to ${result.reserved_for}` : "";
    return `Released${target}.`;
  });
}

function handlePassCommand(runtime: Runtime, parsed: ParsedCommand): void {
  const identity = deriveCliIdentity(parsed);
  const contextPath = parsed.positionals[1] ?? process.cwd();
  const session = requireLeaseSession(identity, contextPath);
  const handoff = requireHandoff(parsed);
  const target = parsed.positionals[0];

  if (!target) {
    const result = runtime.commands.releaseStick(identity, {
      room_id: session.room_id,
      lease_id: session.lease_id as string,
      expected_turn_id: session.turn_id as number,
      handoff
    });

    clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
    stopGuardian(
      session.guardian_pid,
      session.guardian_process_started_at ?? null
    );
    printResult(parsed, result, () => {
      const reserved = result.reserved_for ? ` to ${result.reserved_for}` : "";
      return `Passed${reserved}.`;
    });
    return;
  }

  const result = runtime.commands.passStick(identity, {
    room_id: session.room_id,
    lease_id: session.lease_id as string,
    expected_turn_id: session.turn_id as number,
    to_agent_id: target,
    handoff
  });

  clearCliSessionLease(resolveCliSessionPath(), identity.agent_id, session.room_id);
  stopGuardian(
    session.guardian_pid,
    session.guardian_process_started_at ?? null
  );

  printResult(parsed, result, () => `Passed to ${result.reserved_for}.`);
}

function handleWhoAmICommand(parsed: ParsedCommand): void {
  const resolved = resolveCliIdentity(parsed);
  const result = {
    agent_id: resolved.identity.agent_id,
    process_metadata: resolved.identity.process_metadata,
    source: resolved.source,
    detail: resolved.detail
  };

  printResult(parsed, result, () => {
    if (!hasOption(parsed, "explain")) {
      return resolved.identity.agent_id;
    }

    return [
      resolved.identity.agent_id,
      `source: ${resolved.source}`,
      `session_kind: ${resolved.identity.process_metadata.session_kind}`,
      `detail: ${resolved.detail}`
    ].join("\n");
  });
}

async function runGuardCommand(parsed: ParsedCommand): Promise<void> {
  const identity = deriveHumanCliIdentity({
    agentId: requireStringOption(parsed, "agent"),
    displayName: requireStringOption(parsed, "agent").replace(/^human:/, ""),
    sessionKind: "human_guardian"
  });
  const runtime = createRuntime();

  try {
    const joined = runtime.commands.joinPath(identity, {
      context_path: requireStringOption(parsed, "context-path")
    });

    const heartbeatInput = {
      room_id: requireStringOption(parsed, "room-id"),
      lease_id: requireStringOption(parsed, "lease-id"),
      expected_turn_id: parseRequiredInteger(parsed, "turn-id")
    };

    const intervalMs = joined.policy.heartbeatIntervalMs;

    process.stdout.write(`${GUARD_READY}\n`);
    const timer = setInterval(() => {
      try {
        runtime.commands.heartbeat(identity, heartbeatInput);
      } catch (error) {
        if (isProtocolError(error) && STALE_GUARD_ERRORS.has(error.code)) {
          process.exit(0);
        }
        process.exit(1);
      }
    }, intervalMs);

    const exit = () => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on("SIGINT", exit);
    process.on("SIGTERM", exit);

    await new Promise<void>(() => undefined);
  } finally {
    runtime.close();
  }
}

function deriveCliIdentity(parsed: ParsedCommand): DerivedIdentity {
  return resolveCliIdentity(parsed).identity;
}

function resolveCliIdentity(
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

function resolveSessionForReads(
  runtime: Runtime,
  parsed: ParsedCommand,
  identity: DerivedIdentity
): CliSession {
  const contextPath = parsed.positionals[0] ?? process.cwd();
  const resolvedPath = resolveContextPath(contextPath);
  const sessionPath = resolveCliSessionPath();
  const existing = findCliSessionForContextPath(
    sessionPath,
    identity.agent_id,
    contextPath
  );
  if (existing) {
    return existing;
  }

  const rooms = runtime.commands.listRooms({ context_path: contextPath }).rooms;
  const room = pickDeepestRoom(rooms);
  if (!room) {
    throw new Error("No room found for this path. Run `tt join` first.");
  }

  const session = {
    agent_id: identity.agent_id,
    room_id: room.room_id,
    canonical_path: room.canonical_path,
    workspace_root: resolvedPath.workspace_root,
    updated_at: new Date().toISOString()
  };
  upsertCliSession(sessionPath, session);
  return session;
}

function requireLeaseSession(identity: DerivedIdentity, contextPath: string): CliSession {
  const session = findCliSessionForContextPath(
    resolveCliSessionPath(),
    identity.agent_id,
    contextPath
  );

  if (!session?.lease_id || session.turn_id === null || session.turn_id === undefined) {
    throw new Error("No active lease for this path. Run `tt wait` or `tt takeover` first.");
  }

  return session;
}

function upsertSessionFromJoin(identity: DerivedIdentity, joined: {
  room_id: string;
  canonical_path: string;
  workspace_root: string;
}): void {
  upsertCliSession(resolveCliSessionPath(), {
    agent_id: identity.agent_id,
    room_id: joined.room_id,
    canonical_path: joined.canonical_path,
    workspace_root: joined.workspace_root,
    updated_at: new Date().toISOString()
  });
}

function parseCommand(argv: string[]): ParsedCommand {
  const [name = "", ...rest] = argv;
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, true);
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  return { name, positionals, options };
}

function hasOption(parsed: ParsedCommand, key: string): boolean {
  return parsed.options.has(key);
}

function getStringOption(
  parsed: ParsedCommand,
  key: string
): string | undefined {
  const value = parsed.options.get(key);
  return typeof value === "string" ? value : undefined;
}

function requireStringOption(parsed: ParsedCommand, key: string): string {
  const value = getStringOption(parsed, key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function parseOptionalInteger(
  parsed: ParsedCommand,
  key: string
): number | undefined {
  const value = getStringOption(parsed, key);
  if (!value) {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`--${key} must be an integer.`);
  }
  return parsedValue;
}

function parseRequiredInteger(parsed: ParsedCommand, key: string): number {
  const value = parseOptionalInteger(parsed, key);
  if (value === undefined) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function parseWaitTimeout(parsed: ParsedCommand): number | undefined {
  const value = getStringOption(parsed, "timeout");
  if (!value) {
    return undefined;
  }
  return parseDurationMs(value);
}

const DEFAULT_CLI_HANDOFF_STATUS =
  "(human handoff — no structured status provided)";
const DEFAULT_CLI_HANDOFF_NEXT_ACTION =
  "(no explicit guidance — proceed as previously established)";

function requireHandoff(parsed: ParsedCommand): Handoff {
  return {
    status: getStringOption(parsed, "status") ?? DEFAULT_CLI_HANDOFF_STATUS,
    next_action:
      getStringOption(parsed, "next-action") ?? DEFAULT_CLI_HANDOFF_NEXT_ACTION
  };
}

function parseDurationMs(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10) * 1000;
  }

  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new Error("Timeout values must be bare seconds or use ms/s/m/h suffixes.");
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
}

function pickDeepestRoom(rooms: PathRoom[]): PathRoom | null {
  if (rooms.length === 0) {
    return null;
  }

  return rooms
    .slice()
    .sort((left, right) => right.canonical_path.length - left.canonical_path.length)[0];
}

async function spawnGuardian(input: {
  agentId: string;
  canonicalPath: string;
  roomId: string;
  leaseId: string;
  turnId: number;
}): Promise<{ pid: number; process_started_at: string | null }> {
  const self = resolveSelfSpawn();
  const child = spawn(
    self.command,
    [
      ...self.args,
      "guard",
      "--agent",
      input.agentId,
      "--context-path",
      input.canonicalPath,
      "--room-id",
      input.roomId,
      "--lease-id",
      input.leaseId,
      "--turn-id",
      String(input.turnId)
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  return await new Promise<{ pid: number; process_started_at: string | null }>(
    (resolve, reject) => {
      const inspector = createSystemProcessInspector();
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        reject(new Error("Guardian did not signal readiness in time."));
      }, 3_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes(GUARD_READY)) {
        return;
      }

      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
        if (!child.pid) {
          reject(new Error("Guardian started without a PID."));
          return;
        }
        resolve({
          pid: child.pid,
          process_started_at: inspector.inspect(child.pid)?.startTime ?? null
        });
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Guardian exited before readiness (code ${code ?? "unknown"}): ${stderr.trim()}`
          )
        );
      });
    });
}

function resolveSelfSpawn(): { command: string; args: string[] } {
  const scriptPath = fileURLToPath(import.meta.url);
  if (scriptPath.endsWith(".ts")) {
    const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    if (fs.existsSync(tsxBin)) {
      return { command: tsxBin, args: [scriptPath] };
    }
  }

  return { command: process.execPath, args: [scriptPath] };
}

function stopGuardian(
  guardianPid?: number | null,
  guardianProcessStartedAt?: string | null
): void {
  if (!guardianPid) {
    return;
  }

  terminateKnownProcess(
    {
      pid: guardianPid,
      process_started_at: guardianProcessStartedAt ?? null
    },
    {
      inspector: createSystemProcessInspector()
    }
  );
}

function formatWaitResult(result: {
  status: string;
  reason?: string;
  current_owner?: string;
  reserved_for?: string;
  turn_id?: number;
  lease_expires_at?: string;
  claim_expires_at?: string;
}): string {
  switch (result.status) {
    case "not_yet": {
      const parts: string[] = ["Not your turn yet."];
      if (result.current_owner) {
        const deadline = result.lease_expires_at
          ? ` (lease expires ${result.lease_expires_at})`
          : "";
        parts.push(
          `${result.current_owner} holds turn ${result.turn_id ?? "?"}${deadline}.`
        );
      } else if (result.reserved_for) {
        const deadline = result.claim_expires_at
          ? ` (claim expires ${result.claim_expires_at})`
          : "";
        parts.push(
          `Turn ${result.turn_id ?? "?"} is reserved for ${result.reserved_for}${deadline}.`
        );
      }
      return parts.join(" ");
    }
    case "closed":
      return "The room is closed.";
    case "takeover_available":
      return `Takeover available: ${result.reason ?? "unknown"}.`;
    case "your_turn":
      return result.reason === "already_owner"
        ? "Already holding the stick."
        : "Your turn.";
    default:
      return result.status;
  }
}

function printResult(
  parsed: ParsedCommand,
  result: unknown,
  renderText: () => string
): void {
  if (hasOption(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderText()}\n`);
}

async function runInstallCommand(parsed: ParsedCommand): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const actions = harnesses.map((harness) => planInstall(harness));

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action)));
  reportInstallResults(results, "install");
}

async function runUninstallCommand(parsed: ParsedCommand): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const actions = harnesses.map((harness) => planUninstall(harness));

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action)));
  reportInstallResults(results, "uninstall");
}

async function runInstallSkillCommand(parsed: ParsedCommand): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  normalizeBooleanFlag(parsed, "copy");
  normalizeBooleanFlag(parsed, "link");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const link = resolveSkillInstallLinkMode(parsed);
  const actions = harnesses.map((harness) =>
    planSkillInstall(harness, { link })
  );

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action)));
  reportInstallResults(results, "install");
}

async function runUninstallSkillCommand(parsed: ParsedCommand): Promise<void> {
  normalizeBooleanFlag(parsed, "print");
  const harnesses = selectHarnesses(parsed);
  const dryRun = hasOption(parsed, "print");
  const actions = harnesses.map((harness) => planSkillUninstall(harness));

  if (dryRun) {
    for (const action of actions) {
      printActionPlan(action);
    }
    return;
  }

  const results = await Promise.all(actions.map((action) => runAction(action)));
  reportInstallResults(results, "uninstall");
}

function normalizeBooleanFlag(parsed: ParsedCommand, key: string): void {
  const value = parsed.options.get(key);
  if (typeof value === "string") {
    parsed.positionals.unshift(value);
    parsed.options.set(key, true);
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

function selectHarnesses(parsed: ParsedCommand): HarnessId[] {
  if (hasOption(parsed, "all")) {
    const detected = SUPPORTED_HARNESSES.filter((harness) => detectHarness(harness).detected);
    if (detected.length === 0) {
      throw new Error(
        `No supported harnesses detected. Install one of: ${SUPPORTED_HARNESSES.join(", ")}, or pass harnesses explicitly.`
      );
    }
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
  if (action.kind === "exec") {
    process.stdout.write(`[${action.harness}] ${action.description}\n`);
    return;
  }
  process.stdout.write(`[${action.harness}] ${action.description}\n`);
}

function reportInstallResults(results: InstallResult[], mode: "install" | "uninstall"): void {
  let anyFailed = false;
  for (const result of results) {
    const status = result.ok ? "ok" : "FAIL";
    process.stdout.write(`[${result.harness}] ${status}: ${result.message}\n`);
    if (!result.ok) anyFailed = true;
  }
  if (anyFailed) {
    throw new Error(`${mode} completed with failures.`);
  }
}

function printHelp(): void {
  process.stdout.write(`Usage: tt <command> [options]

Commands:
  tt whoami [--explain]
  tt list [path]
  tt join [path] [--force-new]
  tt wait [path] [--timeout 30s]
  tt try [path]
  tt state [path]
  tt events [path] [--after N] [--limit N]
  tt release [path] --status TEXT --next-action TEXT
  tt pass [target] [path] --status TEXT --next-action TEXT
  tt takeover [path] --reason TEXT
  tt mcp
  tt install <harness...> | --all [--print]
  tt uninstall <harness...> | --all [--print]
  tt install-skill <harness...> | --all [--print] [--copy] [--link]
  tt uninstall-skill <harness...> | --all [--print]

Harnesses: ${SUPPORTED_HARNESSES.join(", ")}

Common options:
  --agent ID   Override the default human identity
  --json       Print JSON instead of text
`);
}

function isDirectExecution(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }

  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  await runCli().catch((error) => {
    const message = isProtocolError(error)
      ? JSON.stringify(error.toJSON(), null, 2)
      : error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
