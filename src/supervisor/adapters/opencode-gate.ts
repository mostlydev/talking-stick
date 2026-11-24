import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AuthModeError, WorkerExecutableError, type WorkerSpec } from "../adapter.js";

// Fail-closed subscription, provider, model, and permission gate for OpenCode V2
// supervised workers.
//
// Security note on surfaces:
// - `GET /api/integration` and `opencode auth list --standalone --format json`
//   are redacted by OpenCode (connection methods only, never credential values).
// - `GET /api/config` returns literal configuration documents over localhost
//   Basic-authenticated HTTP before parsing; this module projects only
//   structural keys and non-secret routing fields (`package`, `integrationID`,
//   `activation`, `disabled`, `baseURL`) and discards all other values
//   immediately (it never reads `/api/credential` and never echoes values in
//   errors or returned surfaces).

export interface StockOpenCodeOAuthProvider {
  readonly id: "anthropic" | "openai";
  readonly integrationID: "anthropic" | "openai";
  readonly package: string;
  readonly baseURL: string;
  /** Exact built-in header names observed on stock catalog models (still forbidden in user/project config). */
  readonly stockModelHeaderKeys: ReadonlySet<string>;
  /** Exact built-in body keys observed on stock catalog models (still forbidden in user/project config). */
  readonly stockModelBodyKeys: ReadonlySet<string>;
}

/**
 * Stock OpenCode V2 providers whose provider and model catalogs have been
 * verified end-to-end on OAuth subscriptions. GitHub Copilot is intentionally
 * deferred from this first slice because its models span multiple SDK packages
 * and tier-specific endpoints (`api.individual.githubcopilot.com`, `/v1`).
 */
export const OPENCODE_STOCK_OAUTH_PROVIDERS: Readonly<Record<StockOpenCodeOAuthProvider["id"], StockOpenCodeOAuthProvider>> = {
  anthropic: {
    id: "anthropic",
    integrationID: "anthropic",
    package: "@opencode/ai/providers/anthropic",
    baseURL: "https://api.anthropic.com/v1",
    stockModelHeaderKeys: new Set(["anthropic-beta"]),
    stockModelBodyKeys: new Set(["speed"])
  },
  openai: {
    id: "openai",
    integrationID: "openai",
    package: "@opencode/ai/providers/openai/responses",
    baseURL: "https://api.openai.com/v1",
    stockModelHeaderKeys: new Set(),
    stockModelBodyKeys: new Set(["service_tier"])
  }
};

/** Non-routing Provider.Settings / Model.Settings keys observed on stock V2 providers and models. */
const SAFE_PROVIDER_SETTING_KEYS = new Set([
  "baseURL", "timeout", "headerTimeout", "chunkTimeout", "compaction", "cache", "transport", "encoding"
]);
const SAFE_MODEL_SETTING_KEYS = new Set(["baseURL", "compaction", "cache", "encoding"]);

const SAFE_CONFIG_PROVIDER_KEYS = new Set([
  "name", "activation", "package", "integrationID", "settings", "options", "models", "whitelist", "blacklist"
]);
// Configured variants are refused until custom variant routing/header/body
// inspection is supported (V2 merges variant headers and body into requests).
const SAFE_CONFIG_MODEL_KEYS = new Set([
  "name", "disabled", "package", "settings", "options"
]);

/** Exact V2 Permission.Reply decision used for restricted workers. */
export const OPENCODE_RESTRICTED_PERMISSION_REPLY = "reject" as const;

export interface OpenCodeConnectionInfo {
  type?: string;
  id?: string;
  label?: string;
  method?: string;
}

export interface OpenCodeIntegrationInfo {
  id: string;
  name?: string;
  connections: OpenCodeConnectionInfo[];
}

/** Structural projection of `Provider.Info` (no secret/arbitrary setting values). */
export interface OpenCodeProviderInfo {
  id: string;
  canonical?: string;
  integrationID?: string;
  activation?: string;
  package?: string;
  settingKeys: string[];
  baseURL: string | null;
  headerKeys: string[];
  bodyKeys: string[];
}

/** Structural projection of `Model.Info` (no secret/arbitrary setting values). */
export interface OpenCodeModelInfo {
  /** Exact catalog identifier used by OpenCode (`id`), distinct from upstream `modelID` on variants like `*-fast`. */
  id: string;
  modelID?: string;
  providerID: string;
  package?: string;
  settingKeys: string[];
  baseURL: string | null;
  headerKeys: string[];
  bodyKeys: string[];
}

export interface OpenCodeConfigModelOverride {
  keys: string[];
  disabled?: boolean;
  package?: string;
  settingKeys: string[];
  /** Every baseURL declared across settings and options (null marks a non-string value). */
  baseURLs: Array<string | null>;
}

/** Structural projection of one provider entry inside a config document (zero secret values retained). */
export interface OpenCodeConfigProviderOverride {
  providerID: string;
  keys: string[];
  activation?: string;
  integrationID?: string;
  package?: string;
  settingKeys: string[];
  /** Every baseURL declared across settings and options (null marks a non-string value). */
  baseURLs: Array<string | null>;
  models: Record<string, OpenCodeConfigModelOverride>;
}

export interface OpenCodeGateSurface {
  /** Redacted integrations (from `GET /api/integration` or `opencode auth list --standalone --format json`). */
  integrations: readonly OpenCodeIntegrationInfo[];
  /** Projected provider catalog for the target directory (from `GET /api/provider?location[directory]=<cwd>`). */
  providers: readonly OpenCodeProviderInfo[];
  /** Resolved default model for the target directory (from `GET /api/model/default?location[directory]=<cwd>`), or null. */
  defaultModel: OpenCodeModelInfo | null;
  /** Projected model catalog for the target directory (from `GET /api/model?location[directory]=<cwd>`). */
  models: readonly OpenCodeModelInfo[];
  /** Projected provider/model overrides across all resolved config documents (no secret values retained). */
  configOverrides: readonly OpenCodeConfigProviderOverride[];
  /** Whether any resolved config document declared V2 `permissions` rules. */
  hasConfigPermissions?: boolean;
  /** Resources explicitly allowed by higher-level native provider policies. */
  allowedPolicyResources: readonly string[];
}

export interface OpenCodeModelRef {
  providerID: string;
  /** Exact catalog model `id` matching OpenCode V2 `Model.Ref`. */
  id: string;
}

export interface VerifiedOpenCodeRoute {
  providerID: StockOpenCodeOAuthProvider["id"];
  /** Exact catalog model `id` (never substituted with upstream `modelID`), matching OpenCode V2 `Model.Ref`. */
  id: string;
  integrationID: StockOpenCodeOAuthProvider["integrationID"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function canonicalDir(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function isStockProviderId(value: string): value is StockOpenCodeOAuthProvider["id"] {
  return Object.prototype.hasOwnProperty.call(OPENCODE_STOCK_OAUTH_PROVIDERS, value);
}

export interface OpenCodeVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parses an OpenCode `--version` line into semver parts, or null if unrecognizable. */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)\b/.exec(output.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

/** OpenCode 2.4+ is the tested floor for direct V2 `serve --stdio` supervision. */
export function isSupportedOpenCodeVersion(version: OpenCodeVersion | null): boolean {
  return version !== null && (version.major > 2 || (version.major === 2 && version.minor >= 4));
}

export type OpenCodeExecSync = (file: string, args: readonly string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => string;

const defaultExecSync: OpenCodeExecSync = (file, args, options) => execFileSync(file, [...args], {
  cwd: options.cwd,
  env: options.env,
  encoding: "utf8",
  timeout: options.timeoutMs,
  stdio: ["ignore", "pipe", "pipe"]
});

/**
 * Resolves an OpenCode v2+ native executable. Skips version-manager shims and
 * v1.x binaries (such as an older pnpm `opencode-ai@1.3.3` shadowing v2 on PATH).
 */
export function resolveOpenCodeV2Executable(
  env: NodeJS.ProcessEnv,
  exec: OpenCodeExecSync = defaultExecSync
): string {
  const explicit = env.OPENCODE_EXECUTABLE;
  if (explicit && !path.isAbsolute(explicit)) {
    throw new WorkerExecutableError("OPENCODE_EXECUTABLE", "OPENCODE_EXECUTABLE must be an absolute executable path.");
  }
  const candidates = explicit
    ? [explicit]
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "opencode"));
  let sawOlder = false;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let real: string;
    try {
      real = fs.realpathSync(candidate);
      if (seen.has(real)) continue;
      seen.add(real);
      if (["mise", "asdf"].includes(path.basename(real)) || !fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
    } catch {
      continue;
    }
    let versionOut: string;
    try {
      versionOut = exec(real, ["--version"], { env, timeoutMs: 5_000 });
    } catch {
      if (explicit) {
        throw new WorkerExecutableError("OPENCODE_EXECUTABLE", "Cannot verify OPENCODE_EXECUTABLE version.");
      }
      continue;
    }
    const version = parseOpenCodeVersion(versionOut);
    if (isSupportedOpenCodeVersion(version)) return real;
    if (version !== null) {
      sawOlder = true;
      if (explicit) {
        throw new WorkerExecutableError("OPENCODE_EXECUTABLE", "OPENCODE_EXECUTABLE must point to OpenCode 2.4 or newer.");
      }
    }
  }
  throw new WorkerExecutableError(
    "OPENCODE_EXECUTABLE",
    sawOlder
      ? "OpenCode 2.4 or newer is required for headless workers (only an older version was found on PATH). Set OPENCODE_EXECUTABLE to your 2.4+ binary."
      : "Cannot find an OpenCode 2.4+ executable. Set OPENCODE_EXECUTABLE to its absolute path."
  );
}

/**
 * Permission env overlay for an OpenCode V2 worker using the native V2 plural
 * `permissions` rule schema.
 * - `bypassPermissions`: sets `OPENCODE_CONFIG_CONTENT` to
 *   `{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}` so
 *   interactive `ask` prompts are auto-approved without mutating user config
 *   files on disk while hard `deny` rules in user/project policy remain in force.
 * - `default` (`--restricted`): injects nothing; user/project rules govern and
 *   any remaining permission requests are rejected via `OPENCODE_RESTRICTED_PERMISSION_REPLY`.
 */
export function openCodePermissionEnv(permissions: WorkerSpec["permissions"]): Record<string, string> {
  if (permissions.harness !== "opencode") {
    throw new Error("OpenCode needs explicit OpenCode permissions.");
  }
  if (permissions.mode === "bypassPermissions") {
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permissions: [{ action: "*", resource: "*", effect: "allow" }]
      })
    };
  }
  return {};
}

/** Parses `<provider>/<id>` into OpenCode V2 `Model.Ref` (`{ providerID, id }`), rejecting malformed specs. */
export function parseOpenCodeModelRef(model: string): OpenCodeModelRef {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new AuthModeError("wrong_auth_mode", "OpenCode worker model must be written as <provider>/<model>.");
  }
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Projects a raw `Provider.Info` record into non-secret structural metadata only. */
export function projectOpenCodeProvider(raw: unknown): OpenCodeProviderInfo | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec.id !== "string") return null;
  const settings = asRecord(rec.settings);
  const headers = asRecord(rec.headers);
  const body = asRecord(rec.body);
  return {
    id: rec.id,
    canonical: typeof rec.canonical === "string" ? rec.canonical : undefined,
    integrationID: typeof rec.integrationID === "string" ? rec.integrationID : undefined,
    activation: typeof rec.activation === "string" ? rec.activation : undefined,
    package: typeof rec.package === "string" ? rec.package : undefined,
    settingKeys: settings ? Object.keys(settings) : [],
    baseURL: settings && typeof settings.baseURL === "string" ? settings.baseURL : null,
    headerKeys: headers ? Object.keys(headers) : [],
    bodyKeys: body ? Object.keys(body) : []
  };
}

/** Projects a raw `Model.Info` record into non-secret structural metadata only. */
export function projectOpenCodeModel(raw: unknown): OpenCodeModelInfo | null {
  const rec = asRecord(raw);
  if (!rec || typeof rec.id !== "string" || typeof rec.providerID !== "string") return null;
  const settings = asRecord(rec.settings);
  const headers = asRecord(rec.headers);
  const body = asRecord(rec.body);
  return {
    id: rec.id,
    modelID: typeof rec.modelID === "string" ? rec.modelID : undefined,
    providerID: rec.providerID,
    package: typeof rec.package === "string" ? rec.package : undefined,
    settingKeys: settings ? Object.keys(settings) : [],
    baseURL: settings && typeof settings.baseURL === "string" ? settings.baseURL : null,
    headerKeys: headers ? Object.keys(headers) : [],
    bodyKeys: body ? Object.keys(body) : []
  };
}

/**
 * Projects raw OpenCode config documents (from `GET /api/config` or `debug config`)
 * into strictly non-secret provider/model structural overrides. Secret values
 * (`apiKey`, header values, body payloads, unknown setting values) are discarded
 * immediately and never retained on the returned projection.
 */
function mergeConfigSettings(entry: Record<string, unknown>): {
  settingKeys: string[];
  baseURLs: Array<string | null>;
} {
  const keys = new Set<string>();
  const baseURLs: Array<string | null> = [];
  for (const field of ["settings", "options"] as const) {
    if (!(field in entry) || entry[field] === undefined) continue;
    const rec = asRecord(entry[field]);
    if (!rec) {
      keys.add(`invalid:${field}`);
      continue;
    }
    for (const key of Object.keys(rec)) keys.add(key);
    if ("baseURL" in rec && rec.baseURL !== undefined) {
      baseURLs.push(typeof rec.baseURL === "string" ? rec.baseURL : null);
    }
  }
  return { settingKeys: [...keys], baseURLs };
}

export function projectOpenCodeConfigDocuments(rawDocuments: readonly unknown[]): {
  overrides: OpenCodeConfigProviderOverride[];
  hasPermissions: boolean;
  allowedPolicyResources: string[];
} {
  const overrides: OpenCodeConfigProviderOverride[] = [];
  let hasPermissions = false;
  const allowedPolicyResources = new Set<string>();

  for (const rawDoc of rawDocuments) {
    const doc = asRecord(rawDoc);
    if (!doc || doc.type !== "document") continue;
    const info = asRecord(doc.info);
    if (!info) continue;
    if (Array.isArray(info.permissions) && info.permissions.length > 0) hasPermissions = true;
    for (const policies of [info.policies, asRecord(info.experimental)?.policies]) {
      if (!Array.isArray(policies)) continue;
      for (const rawRule of policies) {
        const rule = asRecord(rawRule);
        if (rule?.effect === "allow" && ["provider.use", "integration.use", "*"].includes(String(rule.action))) {
          allowedPolicyResources.add(typeof rule.resource === "string" ? rule.resource : "*");
        }
      }
    }

    for (const providersField of ["providers", "provider"] as const) {
      const providers = asRecord(info[providersField]);
      if (!providers) continue;
      for (const [providerID, rawEntry] of Object.entries(providers)) {
        const entry = asRecord(rawEntry);
        if (!entry) continue;
        const { settingKeys, baseURLs } = mergeConfigSettings(entry);
        const rawModels = asRecord(entry.models);
        const models: Record<string, OpenCodeConfigModelOverride> = {};
        if (rawModels) {
          for (const [modelKey, rawModelEntry] of Object.entries(rawModels)) {
            const modelEntry = asRecord(rawModelEntry);
            if (!modelEntry) continue;
            const mergedModel = mergeConfigSettings(modelEntry);
            models[modelKey] = {
              keys: Object.keys(modelEntry),
              disabled: typeof modelEntry.disabled === "boolean" ? modelEntry.disabled : undefined,
              package: typeof modelEntry.package === "string" ? modelEntry.package : undefined,
              settingKeys: mergedModel.settingKeys,
              baseURLs: mergedModel.baseURLs
            };
          }
        }
        overrides.push({
          providerID,
          keys: Object.keys(entry),
          activation: typeof entry.activation === "string" ? entry.activation : undefined,
          integrationID: typeof entry.integrationID === "string" ? entry.integrationID : undefined,
          package: typeof entry.package === "string" ? entry.package : undefined,
          settingKeys,
          baseURLs,
          models
        });
      }
    }
  }
  return { overrides, hasPermissions, allowedPolicyResources: [...allowedPolicyResources] };
}

function assertStockEndpoint(
  baseURL: string | null,
  stock: StockOpenCodeOAuthProvider,
  subject: string
): void {
  if (!baseURL || normalizeUrl(baseURL) !== normalizeUrl(stock.baseURL)) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `${subject} does not match the stock OAuth endpoint URL; supervised workers require the stock route.`
    );
  }
}

function assertCleanConfigOverrides(
  overrides: readonly OpenCodeConfigProviderOverride[],
  stock: StockOpenCodeOAuthProvider,
  modelID: string
): void {
  for (const entry of overrides) {
    if (entry.providerID !== stock.id) continue;
    for (const key of entry.keys) {
      if (!SAFE_CONFIG_PROVIDER_KEYS.has(key)) {
        throw new AuthModeError(
          "wrong_auth_mode",
          `OpenCode configuration overrides ${key} for ${stock.id}; supervised workers require the stock provider.`
        );
      }
    }
    if (entry.activation === "disabled") {
      throw new AuthModeError("wrong_auth_mode", `OpenCode configuration disables ${stock.id}.`);
    }
    if (entry.integrationID !== undefined && entry.integrationID !== stock.integrationID) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode configuration rebinds ${stock.id} to another integration.`);
    }
    if (entry.package !== undefined && entry.package !== stock.package) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode configuration overrides the package for ${stock.id}.`);
    }
    for (const settingKey of entry.settingKeys) {
      if (!SAFE_PROVIDER_SETTING_KEYS.has(settingKey)) {
        throw new AuthModeError(
          "wrong_auth_mode",
          `OpenCode configuration sets custom setting (${settingKey}) for ${stock.id}; supervised workers require the stock OAuth route.`
        );
      }
    }
    if (entry.baseURLs.length > 1) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode configuration sets conflicting baseURL fields for ${stock.id}; refusing ambiguous route.`
      );
    }
    for (const url of entry.baseURLs) {
      assertStockEndpoint(url, stock, `OpenCode configuration for ${stock.id}`);
    }

    const modelOverride = entry.models[modelID];
    if (modelOverride) {
      for (const key of modelOverride.keys) {
        if (!SAFE_CONFIG_MODEL_KEYS.has(key)) {
          throw new AuthModeError(
            "wrong_auth_mode",
            `OpenCode configuration overrides ${key} for ${stock.id}/${modelID}; supervised workers require stock model settings.`
          );
        }
      }
      if (modelOverride.disabled === true) {
        throw new AuthModeError("wrong_auth_mode", `OpenCode configuration disables ${stock.id}/${modelID}.`);
      }
      if (modelOverride.package !== undefined && modelOverride.package !== stock.package) {
        throw new AuthModeError("wrong_auth_mode", `OpenCode configuration overrides the package for ${stock.id}/${modelID}.`);
      }
      for (const settingKey of modelOverride.settingKeys) {
        if (!SAFE_MODEL_SETTING_KEYS.has(settingKey)) {
          throw new AuthModeError(
            "wrong_auth_mode",
            `OpenCode configuration sets custom model setting (${settingKey}) for ${stock.id}/${modelID}.`
          );
        }
      }
      if (modelOverride.baseURLs.length > 1) {
        throw new AuthModeError(
          "wrong_auth_mode",
          `OpenCode configuration sets conflicting model baseURL fields for ${stock.id}/${modelID}; refusing ambiguous route.`
        );
      }
      for (const url of modelOverride.baseURLs) {
        assertStockEndpoint(url, stock, `OpenCode model configuration for ${stock.id}/${modelID}`);
      }
    }
  }
}

/**
 * Verifies that the selected OpenCode V2 provider and model run strictly on an
 * unambiguously OAuth-backed stock provider route with no secret, endpoint,
 * package, header, or body overrides. Fails closed with `AuthModeError` before
 * any prompt may be sent.
 */
export function verifyOpenCodeSubscriptionRoute(
  surface: OpenCodeGateSurface,
  requestedModel?: string
): VerifiedOpenCodeRoute {
  // 1. Resolve target provider and exact catalog model `id`.
  const target = requestedModel !== undefined
    ? parseOpenCodeModelRef(requestedModel)
    : surface.defaultModel
      ? { providerID: surface.defaultModel.providerID, id: surface.defaultModel.id }
      : null;

  if (!target || !target.providerID || !target.id) {
    const anyConn = surface.integrations.some((integration) => integration.connections.length > 0);
    throw new AuthModeError(
      anyConn ? "wrong_auth_mode" : "auth_required",
      anyConn
        ? "OpenCode has no verifiable default OAuth model; pass --model <provider>/<model> for an OAuth-backed provider."
        : "Sign in to OpenCode with an OAuth subscription (`opencode auth login`) before starting this worker."
    );
  }

  if (!isStockProviderId(target.providerID)) {
    const anyConn = surface.integrations.some((integration) => integration.connections.length > 0);
    throw new AuthModeError(
      anyConn ? "wrong_auth_mode" : "auth_required",
      anyConn
        ? `OpenCode provider "${target.providerID}" is not a verified stock OAuth subscription provider (supported: anthropic, openai).`
        : "Sign in to OpenCode with an OAuth subscription (`opencode auth login`) before starting this worker."
    );
  }

  const stock = OPENCODE_STOCK_OAUTH_PROVIDERS[target.providerID];

  // 2. Redacted integration/connection guard: require exactly one matching
  // integration and require EVERY connection on it to be an OAuth credential.
  const matchingIntegrations = surface.integrations.filter((entry) => entry.id === stock.integrationID);
  if (matchingIntegrations.length === 0) {
    throw new AuthModeError(
      "auth_required",
      `OpenCode has no OAuth login for ${stock.id}; run \`opencode auth login\` before starting this worker.`
    );
  }
  if (matchingIntegrations.length > 1) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode returned duplicate integration entries for ${stock.id}; refusing ambiguous auth state.`
    );
  }
  const integration = matchingIntegrations[0];
  if (integration.connections.length === 0) {
    throw new AuthModeError(
      "auth_required",
      `OpenCode has no OAuth login for ${stock.id}; run \`opencode auth login\` before starting this worker.`
    );
  }
  if (integration.connections.some((conn) => conn.type !== "credential" || conn.method !== "oauth")) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode integration ${stock.id} has non-OAuth credentials or env overrides; supervised workers require unambiguously OAuth-only credentials.`
    );
  }

  // 3. Provider metadata guard: require exactly one stock provider entry with
  // exact stock integrationID, package, required stock baseURL, and no custom
  // settings/headers/body.
  const matchingProviders = surface.providers.filter((entry) => entry.id === stock.id);
  if (matchingProviders.length !== 1) {
    throw new AuthModeError(
      "wrong_auth_mode",
      matchingProviders.length === 0
        ? `OpenCode provider ${stock.id} is not available in the resolved provider catalog.`
        : `OpenCode returned duplicate provider entries for ${stock.id}; refusing ambiguous route.`
    );
  }
  const provider = matchingProviders[0];
  if (provider.activation === "disabled") {
    throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} is disabled.`);
  }
  if (provider.integrationID !== stock.integrationID) {
    throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} does not bind to its stock OAuth integration.`);
  }
  if (provider.package !== stock.package) {
    throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} uses a non-stock package.`);
  }
  if (provider.headerKeys.length > 0 || provider.bodyKeys.length > 0) {
    throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} defines custom headers or body overrides.`);
  }
  for (const key of provider.settingKeys) {
    if (!SAFE_PROVIDER_SETTING_KEYS.has(key)) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} has custom setting (${key}).`);
    }
  }
  assertStockEndpoint(provider.baseURL, stock, `OpenCode provider ${stock.id}`);

  // 4. Model metadata guard: require exact `id` match (never fuzzy `modelID`
  // fallback) and exactly one row in the catalog, with required stock package,
  // required stock baseURL, and only stock-verified header/body/setting keys.
  const matchingModels = surface.models.filter((m) => m.providerID === stock.id && m.id === target.id);
  if (matchingModels.length !== 1) {
    throw new AuthModeError(
      "wrong_auth_mode",
      matchingModels.length === 0
        ? `OpenCode model ${stock.id}/${target.id} is not in the resolved model catalog.`
        : `OpenCode returned duplicate catalog entries for ${stock.id}/${target.id}; refusing ambiguous model.`
    );
  }
  const model = matchingModels[0];
  if (model.package !== stock.package) {
    throw new AuthModeError("wrong_auth_mode", `OpenCode model ${stock.id}/${target.id} uses a non-stock package.`);
  }
  for (const key of model.settingKeys) {
    if (!SAFE_MODEL_SETTING_KEYS.has(key)) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode model ${stock.id}/${target.id} defines custom setting (${key}).`);
    }
  }
  assertStockEndpoint(model.baseURL, stock, `OpenCode model ${stock.id}/${target.id}`);
  for (const key of model.headerKeys) {
    if (!stock.stockModelHeaderKeys.has(key)) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode model ${stock.id}/${target.id} defines non-stock header (${key}).`);
    }
  }
  for (const key of model.bodyKeys) {
    if (!stock.stockModelBodyKeys.has(key)) {
      throw new AuthModeError("wrong_auth_mode", `OpenCode model ${stock.id}/${target.id} defines non-stock body key (${key}).`);
    }
  }

  // 5. Projected config-document override guard (forbids any project/user
  // opencode.json apiKey, custom baseURL, package, headers, or body overrides).
  assertCleanConfigOverrides(surface.configOverrides, stock, target.id);

  return { providerID: stock.id, id: model.id, integrationID: stock.integrationID };
}

/**
 * Reads OpenCode V2's server-redacted `debug config --standalone` output for
 * `cwd` and projects only non-secret provider/model override metadata.
 */
export function readRedactedOpenCodeConfigOverrides(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  exec: OpenCodeExecSync = defaultExecSync
): { overrides: OpenCodeConfigProviderOverride[]; hasPermissions: boolean } {
  let raw: string;
  try {
    raw = exec(executable, ["debug", "config", "--standalone"], { cwd, env, timeoutMs: 10_000 });
  } catch {
    throw new AuthModeError("wrong_auth_mode", "Cannot read redacted OpenCode configuration.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthModeError("wrong_auth_mode", "Cannot parse redacted OpenCode configuration.");
  }
  if (!Array.isArray(parsed)) {
    throw new AuthModeError("wrong_auth_mode", "Unexpected OpenCode configuration format.");
  }
  return projectOpenCodeConfigDocuments(parsed);
}

/**
 * Reads OpenCode V2's redacted `auth list --standalone --format json` output.
 * Always passes `--standalone` so it never collides with or starts the background
 * managed service on port 49374.
 */
export function readRedactedOpenCodeAuth(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  exec: OpenCodeExecSync = defaultExecSync
): OpenCodeIntegrationInfo[] {
  let raw: string;
  try {
    raw = exec(executable, ["auth", "list", "--standalone", "--format", "json"], { cwd, env, timeoutMs: 10_000 });
  } catch {
    throw new AuthModeError("wrong_auth_mode", "Cannot read OpenCode authentication metadata.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthModeError("wrong_auth_mode", "Cannot parse OpenCode authentication metadata.");
  }
  if (!Array.isArray(parsed)) {
    throw new AuthModeError("wrong_auth_mode", "Unexpected OpenCode authentication format.");
  }
  return parseIntegrationArray(parsed);
}

function parseIntegrationArray(entries: readonly unknown[]): OpenCodeIntegrationInfo[] {
  return entries.flatMap((entry): OpenCodeIntegrationInfo[] => {
    const rec = asRecord(entry);
    if (!rec || typeof rec.id !== "string" || !Array.isArray(rec.connections)) return [];
    const connections = rec.connections.flatMap((conn): OpenCodeConnectionInfo[] => {
      const c = asRecord(conn);
      if (!c) return [];
      return [{
        type: typeof c.type === "string" ? c.type : undefined,
        id: typeof c.id === "string" ? c.id : undefined,
        label: typeof c.label === "string" ? c.label : undefined,
        method: typeof c.method === "string" ? c.method : undefined
      }];
    });
    return [{ id: rec.id, name: typeof rec.name === "string" ? rec.name : undefined, connections }];
  });
}

export interface ReadOpenCodeServerGateOptions {
  baseUrl: string;
  authHeader: string;
  directory: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function fetchGateJson(
  url: string,
  authHeader: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new AuthModeError("wrong_auth_mode", `Cannot read OpenCode server metadata (HTTP ${response.status}).`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AuthModeError) throw error;
    throw new AuthModeError("wrong_auth_mode", "Cannot verify OpenCode server authentication and provider metadata.");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

function assertResponseLocation(raw: unknown, expectedDirectory: string, endpoint: string): void {
  const location = asRecord(asRecord(raw)?.location);
  const actual = location && typeof location.directory === "string" ? location.directory : null;
  if (!actual || canonicalDir(actual) !== canonicalDir(expectedDirectory)) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode ${endpoint} resolved a different directory than requested; refusing unscoped metadata.`
    );
  }
}

/**
 * Reads all gate surfaces directly from a private Basic-authenticated
 * `opencode serve --stdio` server, scoped via `location[directory]=<dir>`
 * (never bare `directory=`, which OpenCode V2 silently ignores on `/api/config`).
 *
 * Verifies `location.directory` on every location-bearing response, never calls
 * `/api/credential`, and projects `/api/config` into strictly structural
 * provider/model fields immediately upon parsing so raw secret strings are not
 * retained on the returned surface.
 */
export async function readOpenCodeServerGateSurface(
  options: ReadOpenCodeServerGateOptions
): Promise<OpenCodeGateSurface> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const base = options.baseUrl.replace(/\/+$/, "");
  const query = `location%5Bdirectory%5D=${encodeURIComponent(options.directory)}`;

  const [integrationsRaw, providersRaw, defaultModelRaw, modelsRaw, configRaw] = await Promise.all([
    fetchGateJson(`${base}/api/integration?${query}`, options.authHeader, fetchImpl, timeoutMs, options.signal),
    fetchGateJson(`${base}/api/provider?${query}`, options.authHeader, fetchImpl, timeoutMs, options.signal),
    fetchGateJson(`${base}/api/model/default?${query}`, options.authHeader, fetchImpl, timeoutMs, options.signal),
    fetchGateJson(`${base}/api/model?${query}`, options.authHeader, fetchImpl, timeoutMs, options.signal),
    fetchGateJson(`${base}/api/config?${query}`, options.authHeader, fetchImpl, timeoutMs, options.signal)
  ]);

  assertResponseLocation(integrationsRaw, options.directory, "/api/integration");
  assertResponseLocation(providersRaw, options.directory, "/api/provider");
  assertResponseLocation(defaultModelRaw, options.directory, "/api/model/default");
  assertResponseLocation(modelsRaw, options.directory, "/api/model");

  const integrationsData = asRecord(integrationsRaw)?.data;
  const providersData = asRecord(providersRaw)?.data;
  const defaultModelData = asRecord(defaultModelRaw)?.data;
  const modelsData = asRecord(modelsRaw)?.data;

  if (!Array.isArray(integrationsData) || !Array.isArray(providersData) || !Array.isArray(modelsData) || !Array.isArray(configRaw)) {
    throw new AuthModeError("wrong_auth_mode", "Unexpected OpenCode server metadata format.");
  }

  const integrations = parseIntegrationArray(integrationsData);
  const providers = providersData.flatMap((entry) => {
    const projected = projectOpenCodeProvider(entry);
    return projected ? [projected] : [];
  });
  const defaultModel = defaultModelData === null || defaultModelData === undefined ? null : projectOpenCodeModel(defaultModelData);
  const models = modelsData.flatMap((entry) => {
    const projected = projectOpenCodeModel(entry);
    return projected ? [projected] : [];
  });
  const { overrides: configOverrides, hasPermissions: hasConfigPermissions, allowedPolicyResources } =
    projectOpenCodeConfigDocuments(configRaw);

  return { integrations, providers, defaultModel, models, configOverrides, hasConfigPermissions, allowedPolicyResources };
}
