import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AuthModeError, WorkerExecutableError, type WorkerSpec } from "../adapter.js";

// Fail-closed subscription, provider, model, and permission gate for OpenCode V2
// supervised workers. Every check inspects only redacted metadata or structural
// keys and never logs, copies, or returns secret values.

export interface StockOpenCodeOAuthProvider {
  readonly id: "anthropic" | "openai" | "github-copilot";
  readonly integrationID: "anthropic" | "openai" | "github-copilot";
  readonly package: string;
  readonly baseURL: string;
}

/**
 * Stock OpenCode V2 providers that support OAuth subscriptions without an
 * ambiguous API-key/free-tier default. Both `package` and `baseURL` must match
 * the built-in route exactly so project or user config cannot silently redirect
 * traffic to a proxy or custom SDK package.
 */
export const OPENCODE_STOCK_OAUTH_PROVIDERS: Readonly<Record<StockOpenCodeOAuthProvider["id"], StockOpenCodeOAuthProvider>> = {
  anthropic: {
    id: "anthropic",
    integrationID: "anthropic",
    package: "@opencode/ai/providers/anthropic",
    baseURL: "https://api.anthropic.com/v1"
  },
  openai: {
    id: "openai",
    integrationID: "openai",
    package: "@opencode/ai/providers/openai/responses",
    baseURL: "https://api.openai.com/v1"
  },
  "github-copilot": {
    id: "github-copilot",
    integrationID: "github-copilot",
    package: "@opencode/ai/providers/openai/responses",
    baseURL: "https://api.githubcopilot.com"
  }
};

/** Non-routing Provider.Settings / Model.Settings keys observed on stock V2 providers. */
const SAFE_PROVIDER_SETTING_KEYS = new Set([
  "baseURL", "timeout", "headerTimeout", "chunkTimeout", "compaction", "cache", "transport", "encoding"
]);
const SAFE_MODEL_SETTING_KEYS = new Set(["compaction", "cache", "encoding"]);

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

export interface OpenCodeProviderInfo {
  id: string;
  canonical?: string;
  integrationID?: string;
  activation?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface OpenCodeModelInfo {
  id: string;
  modelID?: string;
  providerID: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface OpenCodeConfigDocument {
  type: string;
  path?: string;
  info?: Record<string, unknown>;
}

export interface OpenCodeGateSurface {
  /** Redacted integrations (from `GET /api/integration` or `opencode auth list --standalone --format json`). */
  integrations: readonly OpenCodeIntegrationInfo[];
  /** Provider catalog for the worker directory (from `GET /api/provider?directory=<cwd>`). */
  providers: readonly OpenCodeProviderInfo[];
  /** Resolved default model for the worker directory (from `GET /api/model/default?directory=<cwd>`), or null. */
  defaultModel: OpenCodeModelInfo | null;
  /** Optional model catalog (from `GET /api/model?directory=<cwd>`) to verify explicit `spec.model` overrides. */
  models?: readonly OpenCodeModelInfo[];
  /** Redacted config sources (from `opencode debug config --standalone` in cwd). */
  configDocuments: readonly OpenCodeConfigDocument[];
}

export interface VerifiedOpenCodeRoute {
  providerID: StockOpenCodeOAuthProvider["id"];
  modelID: string;
  integrationID: StockOpenCodeOAuthProvider["integrationID"];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasOwnEntries(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length > 0;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isStockProviderId(value: string): value is StockOpenCodeOAuthProvider["id"] {
  return Object.prototype.hasOwnProperty.call(OPENCODE_STOCK_OAUTH_PROVIDERS, value);
}

/** Parses an OpenCode `--version` line and returns its major version, or null if unrecognizable. */
export function parseOpenCodeMajorVersion(output: string): number | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)\b/.exec(output.trim());
  return match ? Number(match[1]) : null;
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
  let sawV1 = false;
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
    const major = parseOpenCodeMajorVersion(versionOut);
    if (major !== null && major >= 2) return real;
    if (major !== null && major < 2) {
      sawV1 = true;
      if (explicit) {
        throw new WorkerExecutableError("OPENCODE_EXECUTABLE", "OPENCODE_EXECUTABLE must point to OpenCode v2 or newer.");
      }
    }
  }
  throw new WorkerExecutableError(
    "OPENCODE_EXECUTABLE",
    sawV1
      ? "OpenCode v2 or newer is required for headless workers (only v1 was found on PATH). Set OPENCODE_EXECUTABLE to your v2 binary."
      : "Cannot find an OpenCode v2 executable. Set OPENCODE_EXECUTABLE to its absolute path."
  );
}

/**
 * Permission env overlay for an OpenCode V2 worker.
 * - `bypassPermissions`: sets `OPENCODE_CONFIG_CONTENT` to `{"permission":"allow"}`
 *   so interactive `ask` prompts are auto-approved without mutating user config
 *   files on disk (hard `deny` rules in user config remain in force).
 * - `default` (`--restricted`): injects nothing; user/project rules govern and
 *   any remaining permission requests are rejected via `OPENCODE_RESTRICTED_PERMISSION_REPLY`.
 */
export function openCodePermissionEnv(permissions: WorkerSpec["permissions"]): Record<string, string> {
  if (permissions.harness !== "opencode") {
    throw new Error("OpenCode needs explicit OpenCode permissions.");
  }
  if (permissions.mode === "bypassPermissions") {
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }) };
  }
  return {};
}

/** Parses `provider/model` into `{ providerID, modelID }`, rejecting malformed specs. */
export function parseOpenCodeModelRef(model: string): { providerID: string; modelID: string } {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new AuthModeError("wrong_auth_mode", "OpenCode worker model must be written as <provider>/<model>.");
  }
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

function assertCleanProviderSettings(
  settings: Record<string, unknown> | undefined,
  stock: StockOpenCodeOAuthProvider
): void {
  if (!settings) return;
  for (const [key, value] of Object.entries(settings)) {
    if (!SAFE_PROVIDER_SETTING_KEYS.has(key)) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode provider ${stock.id} has a custom setting (${key}); supervised workers require the stock OAuth route.`
      );
    }
    if (key === "baseURL" && value !== undefined && value !== null) {
      if (typeof value !== "string" || normalizeUrl(value) !== normalizeUrl(stock.baseURL)) {
        throw new AuthModeError(
          "wrong_auth_mode",
          `OpenCode provider ${stock.id} overrides its endpoint URL; supervised workers require the stock OAuth endpoint.`
        );
      }
    }
  }
}

function assertCleanModelSettings(
  settings: Record<string, unknown> | undefined,
  providerID: string
): void {
  if (!settings) return;
  for (const key of Object.keys(settings)) {
    if (!SAFE_MODEL_SETTING_KEYS.has(key)) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `Selected OpenCode model on ${providerID} overrides ${key}; supervised workers require stock model settings.`
      );
    }
  }
}

const SAFE_CONFIG_PROVIDER_KEYS = new Set([
  "name", "activation", "package", "integrationID", "settings", "options", "models", "whitelist", "blacklist"
]);
const SAFE_CONFIG_MODEL_KEYS = new Set([
  "name", "disabled", "package", "settings", "options", "variants"
]);

function assertCleanConfigDocuments(
  documents: readonly OpenCodeConfigDocument[],
  stock: StockOpenCodeOAuthProvider,
  modelID: string
): void {
  for (const doc of documents) {
    if (doc.type !== "document") continue;
    const info = asRecord(doc.info);
    if (!info) continue;
    const providers = asRecord(info.providers) ?? asRecord(info.provider);
    if (!providers) continue;
    const entry = asRecord(providers[stock.id]);
    if (!entry) continue;

    for (const key of Object.keys(entry)) {
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
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode configuration rebinds ${stock.id} to another integration.`
      );
    }
    if (entry.package !== undefined && entry.package !== stock.package) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode configuration overrides the package for ${stock.id}; supervised workers require the stock provider.`
      );
    }
    const settings = asRecord(entry.settings) ?? asRecord(entry.options);
    if (settings) assertCleanProviderSettings(settings, stock);

    const models = asRecord(entry.models);
    const modelOverride = models ? asRecord(models[modelID]) : null;
    if (modelOverride) {
      for (const key of Object.keys(modelOverride)) {
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
        throw new AuthModeError(
          "wrong_auth_mode",
          `OpenCode configuration overrides the package for ${stock.id}/${modelID}; supervised workers require the stock provider.`
        );
      }
      const modelSettings = asRecord(modelOverride.settings) ?? asRecord(modelOverride.options);
      if (modelSettings) assertCleanModelSettings(modelSettings, stock.id);
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
  // 1. Resolve target provider/model before touching any model execution path.
  const target = requestedModel !== undefined
    ? parseOpenCodeModelRef(requestedModel)
    : surface.defaultModel
      ? { providerID: surface.defaultModel.providerID, modelID: surface.defaultModel.modelID ?? surface.defaultModel.id }
      : null;

  if (!target || !target.providerID || !target.modelID) {
    const anyConn = surface.integrations.some((integration) => integration.connections.length > 0);
    throw new AuthModeError(
      anyConn ? "wrong_auth_mode" : "auth_required",
      anyConn
        ? "OpenCode has no verifiable default OAuth model; pass --model <provider>/<model> for an OAuth-backed provider."
        : "Sign in to OpenCode with an OAuth subscription (`opencode auth login`) before starting this worker."
    );
  }

  if (!isStockProviderId(target.providerID)) {
    const anyOAuth = surface.integrations.some(
      (integration) => isStockProviderId(integration.id) &&
        integration.connections.length > 0 &&
        integration.connections.every((conn) => conn.type === "credential" && conn.method === "oauth")
    );
    const anyConn = surface.integrations.some((integration) => integration.connections.length > 0);
    throw new AuthModeError(
      anyConn ? "wrong_auth_mode" : "auth_required",
      anyOAuth
        ? `Selected OpenCode provider "${target.providerID}" is not a supported OAuth subscription provider. Select a model on Anthropic, OpenAI, or GitHub Copilot.`
        : anyConn
          ? `OpenCode provider "${target.providerID}" is not a supported OAuth subscription provider; sign in with an OAuth subscription (Anthropic, OpenAI, or GitHub Copilot).`
          : "Sign in to OpenCode with an OAuth subscription (`opencode auth login`) before starting this worker."
    );
  }

  const stock = OPENCODE_STOCK_OAUTH_PROVIDERS[target.providerID];

  // 2. Redacted integration/connection guard: EVERY connection for this
  // integration must be an OAuth credential. Because redacted auth/integration
  // metadata does not identify which single credential is active when multiple
  // methods exist, any mixed (oauth + key) or env/key connection fails closed.
  const integration = surface.integrations.find((entry) => entry.id === stock.integrationID);
  if (!integration || integration.connections.length === 0) {
    throw new AuthModeError(
      "auth_required",
      `OpenCode has no OAuth login for ${stock.id}; run \`opencode auth login\` before starting this worker.`
    );
  }
  const hasNonOAuth = integration.connections.some((conn) => conn.type !== "credential" || conn.method !== "oauth");
  if (hasNonOAuth) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode integration ${stock.id} has non-OAuth credentials or env overrides; supervised workers require unambiguously OAuth-only credentials.`
    );
  }

  // 3. Provider metadata guard (stock integration, package, endpoint, no headers/body/secrets).
  const provider = surface.providers.find((entry) => entry.id === stock.id);
  if (!provider) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode provider ${stock.id} is not available in the resolved provider catalog.`
    );
  }
  if (provider.activation === "disabled") {
    throw new AuthModeError("wrong_auth_mode", `OpenCode provider ${stock.id} is disabled.`);
  }
  if (provider.integrationID !== stock.integrationID) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode provider ${stock.id} does not bind to its stock OAuth integration.`
    );
  }
  if (provider.package !== stock.package) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode provider ${stock.id} uses a non-stock package; supervised workers require the built-in provider.`
    );
  }
  if (hasOwnEntries(provider.headers) || hasOwnEntries(provider.body)) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode provider ${stock.id} defines custom headers or body overrides.`
    );
  }
  assertCleanProviderSettings(provider.settings, stock);

  // 4. Model metadata guard (must exist if catalog provided, and carry no overrides).
  const modelInfo = surface.models
    ? surface.models.find((m) => m.providerID === stock.id && (m.id === target.modelID || m.modelID === target.modelID))
    : surface.defaultModel && surface.defaultModel.providerID === stock.id &&
        (surface.defaultModel.id === target.modelID || surface.defaultModel.modelID === target.modelID)
      ? surface.defaultModel
      : undefined;
  if (surface.models && !modelInfo) {
    throw new AuthModeError(
      "wrong_auth_mode",
      `OpenCode model ${stock.id}/${target.modelID} is not available in the resolved model catalog.`
    );
  }
  if (modelInfo) {
    if (modelInfo.package !== undefined && modelInfo.package !== stock.package) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode model ${stock.id}/${target.modelID} overrides the provider package.`
      );
    }
    if (hasOwnEntries(modelInfo.headers) || hasOwnEntries(modelInfo.body)) {
      throw new AuthModeError(
        "wrong_auth_mode",
        `OpenCode model ${stock.id}/${target.modelID} defines custom headers or body overrides.`
      );
    }
    assertCleanModelSettings(modelInfo.settings, stock.id);
  }

  // 5. Redacted config-document guard (catches project/user opencode.json overrides
  // such as redacted apiKey: "***", custom baseURL, headers, or package).
  assertCleanConfigDocuments(surface.configDocuments, stock, target.modelID);

  return { providerID: stock.id, modelID: target.modelID, integrationID: stock.integrationID };
}

/**
 * Reads OpenCode V2's redacted `debug config --standalone` output for `cwd`.
 * Fails closed with `AuthModeError("wrong_auth_mode", ...)` on CLI or JSON errors.
 */
export function readRedactedOpenCodeConfig(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  exec: OpenCodeExecSync = defaultExecSync
): OpenCodeConfigDocument[] {
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
  return parsed.filter((entry): entry is OpenCodeConfigDocument => {
    const rec = asRecord(entry);
    return rec !== null && typeof rec.type === "string";
  });
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
  return parsed.flatMap((entry): OpenCodeIntegrationInfo[] => {
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
}

/** Strips raw secret/header string values before config documents enter gate checks. */
function redactConfigValue(value: unknown, parentKey?: string): unknown {
  if (typeof value === "string") {
    if (parentKey && /key|secret|token|password|auth|header/i.test(parentKey)) return "***";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactConfigValue(item, parentKey));
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "headers" && asRecord(v)) {
      const redactedHeaders: Record<string, string> = {};
      for (const hk of Object.keys(v as Record<string, unknown>)) redactedHeaders[hk] = "***";
      out[k] = redactedHeaders;
    } else {
      out[k] = redactConfigValue(v, k);
    }
  }
  return out;
}

async function fetchGateJson(
  url: string,
  authHeader: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
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
  }
}

/**
 * Reads all gate surfaces directly from an already-running private
 * `opencode serve --stdio` server over its Basic-authenticated localhost API.
 * Never calls `/api/credential` and redacts config document values on arrival.
 */
export async function readOpenCodeServerGateSurface(
  options: ReadOpenCodeServerGateOptions
): Promise<OpenCodeGateSurface> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const base = options.baseUrl.replace(/\/+$/, "");
  const query = `directory=${encodeURIComponent(options.directory)}`;

  const [integrationsRaw, providersRaw, defaultModelRaw, modelsRaw, configRaw] = await Promise.all([
    fetchGateJson(`${base}/api/integration?${query}`, options.authHeader, fetchImpl, timeoutMs),
    fetchGateJson(`${base}/api/provider?${query}`, options.authHeader, fetchImpl, timeoutMs),
    fetchGateJson(`${base}/api/model/default?${query}`, options.authHeader, fetchImpl, timeoutMs),
    fetchGateJson(`${base}/api/model?${query}`, options.authHeader, fetchImpl, timeoutMs),
    fetchGateJson(`${base}/api/config?${query}`, options.authHeader, fetchImpl, timeoutMs)
  ]);

  const integrationsData = asRecord(integrationsRaw)?.data;
  const providersData = asRecord(providersRaw)?.data;
  const defaultModelData = asRecord(defaultModelRaw)?.data;
  const modelsData = asRecord(modelsRaw)?.data;

  if (!Array.isArray(integrationsData) || !Array.isArray(providersData) || !Array.isArray(modelsData) || !Array.isArray(configRaw)) {
    throw new AuthModeError("wrong_auth_mode", "Unexpected OpenCode server metadata format.");
  }

  const integrations: OpenCodeIntegrationInfo[] = integrationsData.flatMap((entry): OpenCodeIntegrationInfo[] => {
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

  const providers: OpenCodeProviderInfo[] = providersData.flatMap((entry): OpenCodeProviderInfo[] => {
    const rec = asRecord(entry);
    if (!rec || typeof rec.id !== "string") return [];
    return [{
      id: rec.id,
      canonical: typeof rec.canonical === "string" ? rec.canonical : undefined,
      integrationID: typeof rec.integrationID === "string" ? rec.integrationID : undefined,
      activation: typeof rec.activation === "string" ? rec.activation : undefined,
      package: typeof rec.package === "string" ? rec.package : undefined,
      settings: asRecord(redactConfigValue(rec.settings)) ?? undefined,
      headers: asRecord(redactConfigValue(rec.headers, "headers")) ?? undefined,
      body: asRecord(redactConfigValue(rec.body)) ?? undefined
    }];
  });

  const parseModel = (raw: unknown): OpenCodeModelInfo | null => {
    const rec = asRecord(raw);
    if (!rec || typeof rec.id !== "string" || typeof rec.providerID !== "string") return null;
    return {
      id: rec.id,
      modelID: typeof rec.modelID === "string" ? rec.modelID : undefined,
      providerID: rec.providerID,
      package: typeof rec.package === "string" ? rec.package : undefined,
      settings: asRecord(redactConfigValue(rec.settings)) ?? undefined,
      headers: asRecord(redactConfigValue(rec.headers, "headers")) ?? undefined,
      body: asRecord(redactConfigValue(rec.body)) ?? undefined
    };
  };

  const defaultModel = defaultModelData === null || defaultModelData === undefined ? null : parseModel(defaultModelData);
  const models = modelsData.flatMap((entry) => {
    const parsed = parseModel(entry);
    return parsed ? [parsed] : [];
  });

  const configDocuments: OpenCodeConfigDocument[] = configRaw.flatMap((entry): OpenCodeConfigDocument[] => {
    const rec = asRecord(entry);
    if (!rec || typeof rec.type !== "string") return [];
    return [{
      type: rec.type,
      path: typeof rec.path === "string" ? rec.path : undefined,
      info: asRecord(redactConfigValue(rec.info)) ?? undefined
    }];
  });

  return { integrations, providers, defaultModel, models, configDocuments };
}
