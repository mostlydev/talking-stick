import {
  deriveHarnessCliIdentity,
  deriveHumanCliIdentity,
  type DerivedIdentity
} from "../index.js";
import { resolveDatabasePath } from "../db.js";
import { resolveDataDir } from "../config.js";
import { openSqlite } from "../sqlite.js";
import { ProtocolError } from "../errors.js";
import { readSupervisedSession } from "../supervisor-process-evidence.js";
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
    | "harness_cli_env_detection"
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

    assertSupervisedConversation(harnessIdentity, env);

    // An existing membership keeps its ID through the rename so pending
    // deliveries, leases and recovery can still reach that conversation.
    if (harnessIdentity.process_metadata.harness_name === "antigravity") {
      harnessIdentity.agent_id = existingAntigravityMember(harnessIdentity, env);
    }

    if (env.TT_HARNESS_EXPORT === "1" || env.TT_HARNESS_EXPORT?.toLowerCase() === "true") {
      return {
        identity: harnessIdentity,
        source: "harness_cli_exported_detection",
        detail:
          "Resolved as harness CLI because TT_HARNESS_EXPORT enabled harness-aware detection."
      };
    }

    return {
      identity: harnessIdentity,
      source: "harness_cli_env_detection",
      detail:
        "Resolved as harness CLI from known harness environment variables."
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

/**
 * A supervised worker process can run conversations its supervisor did not
 * start, such as Codex's memory consolidation thread. They inherit the
 * worker's environment, so without this they would join as a second member,
 * take the stick and share the worker's wake endpoint. Once the supervisor
 * has bound the worker's own conversation, every other one is refused.
 */
function assertSupervisedConversation(identity: DerivedIdentity, env: NodeJS.ProcessEnv): void {
  const bound = readSupervisedSession(env);
  const harness = identity.process_metadata.harness_name;
  if (!bound || bound.harness !== harness) return;
  const session = identity.process_metadata.harness_session_id;
  if (bound.session !== null && session === `harness:${bound.session}`) return;
  throw new ProtocolError("not_worker_session", bound.session === null
    ? `This ${harness} worker's own conversation is not set up yet, so no conversation in its process can use rooms. Try again once the supervisor has started it.`
    : `This ${harness} conversation is not the one the supervisor runs for this worker; it may be an internal memory, summary or sub-agent thread. ` +
      "Only the worker's own conversation is a room member. This one cannot join, wait, take the stick or send room messages, " +
      "and it needs no stick to edit its own files.", { reason: session ?? "no session" });
}

function existingAntigravityMember(identity: DerivedIdentity, env: NodeJS.ProcessEnv): string {
  const { harness_session_id, harness_host_id } = identity.process_metadata;
  if (!harness_session_id || !harness_host_id) return identity.agent_id;
  const legacyId = identity.agent_id.replace(/^agy:/, "antigravity:");
  try {
    const db = openSqlite(resolveDatabasePath({ dataDir: resolveDataDir({ env }) }), { readonly: true, timeout: 500 });
    try {
      const legacy = db.prepare(`SELECT 1 FROM room_members
        WHERE agent_id = ? AND harness_name = 'antigravity' AND harness_session_id = ? AND harness_host_id = ?
        UNION ALL SELECT 1 FROM lost_room_members
        WHERE agent_id = ? AND harness_name = 'antigravity' AND session_id = ? AND host_id = ?
        LIMIT 1`).get(legacyId, harness_session_id, harness_host_id, legacyId, harness_session_id, harness_host_id);
      if (legacy) return legacyId;
    } finally {
      db.close();
    }
  } catch {
    // Fresh installs have no room database until the first join.
  }
  return identity.agent_id;
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
