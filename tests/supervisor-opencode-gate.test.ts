import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthModeError, type WorkerSpec } from "../src/supervisor/adapter.js";
import { decideOpenCodeRoute } from "../src/supervisor/adapters/opencode.js";
import { builtinAdapters } from "../src/supervisor/adapters/index.js";
import {
  OPENCODE_RESTRICTED_PERMISSION_REPLY,
  OPENCODE_STOCK_OAUTH_PROVIDERS,
  isSupportedOpenCodeVersion,
  openCodePermissionEnv,
  parseOpenCodeVersion,
  parseOpenCodeModelRef,
  projectOpenCodeConfigDocuments,
  projectOpenCodeModel,
  projectOpenCodeProvider,
  readOpenCodeServerGateSurface,
  readRedactedOpenCodeAuth,
  readRedactedOpenCodeConfigOverrides,
  resolveOpenCodeV2Executable,
  verifyOpenCodeSubscriptionRoute,
  type OpenCodeGateSurface
} from "../src/supervisor/adapters/opencode-gate.js";
import { isModelCredential, workerEnvironment } from "../src/supervisor/adapters/process.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function stockSurface(overrides: Partial<OpenCodeGateSurface> = {}): OpenCodeGateSurface {
  return {
    integrations: [
      { id: "anthropic", name: "Anthropic", connections: [{ type: "credential", id: "cred_1", label: "OAuth", method: "oauth" }] },
      { id: "openai", name: "OpenAI", connections: [{ type: "credential", id: "cred_2", label: "OAuth", method: "oauth" }] },
      { id: "opencode", name: "OpenCode", connections: [
        { type: "credential", id: "cred_4", label: "Default", method: "oauth" },
        { type: "credential", id: "cred_5", label: "API key", method: "key" }
      ] },
      { id: "openrouter", name: "OpenRouter", connections: [{ type: "credential", id: "cred_6", label: "API key", method: "key" }] }
    ],
    providers: [
      {
        id: "anthropic",
        integrationID: "anthropic",
        activation: "auto",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.package,
        settingKeys: ["baseURL"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL,
        headerKeys: [],
        bodyKeys: []
      },
      {
        id: "openai",
        integrationID: "openai",
        activation: "auto",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.package,
        settingKeys: ["baseURL", "compaction", "transport"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.baseURL,
        headerKeys: [],
        bodyKeys: []
      }
    ],
    defaultModel: {
      id: "claude-sonnet-4-6",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      package: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.package,
      settingKeys: ["baseURL"],
      baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL,
      headerKeys: [],
      bodyKeys: []
    },
    models: [
      {
        id: "claude-sonnet-4-6",
        modelID: "claude-sonnet-4-6",
        providerID: "anthropic",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.package,
        settingKeys: ["baseURL"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL,
        headerKeys: [],
        bodyKeys: []
      },
      {
        id: "claude-opus-5",
        modelID: "claude-opus-5",
        providerID: "anthropic",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.package,
        settingKeys: ["baseURL"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL,
        headerKeys: [],
        bodyKeys: []
      },
      {
        id: "claude-opus-5-fast",
        modelID: "claude-opus-5",
        providerID: "anthropic",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.package,
        settingKeys: ["baseURL"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL,
        headerKeys: ["anthropic-beta"],
        bodyKeys: ["speed"]
      },
      {
        id: "gpt-6.2-sol-fast",
        modelID: "gpt-6.2-sol",
        providerID: "openai",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.package,
        settingKeys: ["baseURL", "compaction"],
        baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.baseURL,
        headerKeys: [],
        bodyKeys: ["service_tier"]
      }
    ],
    configOverrides: [],
    allowedPolicyResources: [],
    ...overrides
  };
}

describe("OpenCode V2 executable and environment guards", () => {
  test("registers the OpenCode headless adapter", () => {
    expect(builtinAdapters().opencode?.harness).toBe("opencode");
  });

  test("enforces OpenCode 2.4+ floor and skips older shims shadowing 2.4+ on PATH", () => {
    expect(parseOpenCodeVersion("1.3.3")).toEqual({ major: 1, minor: 3, patch: 3 });
    expect(parseOpenCodeVersion("opencode v2.4.1\n")).toEqual({ major: 2, minor: 4, patch: 1 });
    expect(parseOpenCodeVersion("unknown")).toBeNull();
    expect(isSupportedOpenCodeVersion(parseOpenCodeVersion("1.3.3"))).toBe(false);
    expect(isSupportedOpenCodeVersion(parseOpenCodeVersion("opencode v2.3.9"))).toBe(false);
    expect(isSupportedOpenCodeVersion(parseOpenCodeVersion("opencode v2.4.0"))).toBe(true);
    expect(isSupportedOpenCodeVersion(parseOpenCodeVersion("opencode v3.0.0"))).toBe(true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-oc-bin-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const v1Dir = path.join(root, "v1");
    const v23Dir = path.join(root, "v23");
    const v24Dir = path.join(root, "v24");
    for (const d of [v1Dir, v23Dir, v24Dir]) fs.mkdirSync(d);
    const v1Bin = path.join(v1Dir, "opencode");
    const v23Bin = path.join(v23Dir, "opencode");
    const v24Bin = path.join(v24Dir, "opencode");
    for (const b of [v1Bin, v23Bin, v24Bin]) fs.writeFileSync(b, "#!/bin/sh\n", { mode: 0o755 });

    const realV1 = fs.realpathSync(v1Bin);
    const realV23 = fs.realpathSync(v23Bin);
    const realV24 = fs.realpathSync(v24Bin);
    const fakeExec = (file: string) =>
      file === realV1 ? "1.3.3\n" : file === realV23 ? "opencode v2.3.9\n" : "opencode v2.4.1\n";

    expect(resolveOpenCodeV2Executable({ PATH: [v1Dir, v23Dir, v24Dir].join(path.delimiter) }, fakeExec)).toBe(realV24);
    expect(() => resolveOpenCodeV2Executable({ PATH: [v1Dir, v23Dir].join(path.delimiter) }, fakeExec)).toThrow(/OpenCode 2\.4 or newer/);
    expect(() => resolveOpenCodeV2Executable({ OPENCODE_EXECUTABLE: v23Bin }, fakeExec)).toThrow(/2\.4 or newer/);
    expect(() => resolveOpenCodeV2Executable({ OPENCODE_EXECUTABLE: "opencode" }, fakeExec)).toThrow(/absolute/);
  });

  test("refuses OpenCode API keys, config overrides, server URL, and password in worker env", () => {
    for (const name of [
      "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR",
      "OPENCODE_SERVER_URL", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_PASSWORD"
    ]) {
      expect(isModelCredential(name)).toBe(true);
      const spec: WorkerSpec = {
        worker_id: "oc1", harness: "opencode", cwd: "/tmp",
        permissions: { harness: "opencode", mode: "default" },
        env: [{ name, from: "literal", value: "x" }]
      };
      expect(() => workerEnvironment(spec, {})).toThrow(/API key or another provider/);
    }
    const idSpec: WorkerSpec = {
      worker_id: "oc1", harness: "opencode", cwd: "/tmp",
      permissions: { harness: "opencode", mode: "default" },
      env: [{ name: "OPENCODE_SESSION_ID", from: "literal", value: "ses_1" }]
    };
    expect(() => workerEnvironment(idSpec, {})).toThrow(/identity marker/);
  });

  test("maps bypassPermissions to V2 plural permissions schema and default to empty overlay", () => {
    expect(openCodePermissionEnv({ harness: "opencode", mode: "bypassPermissions" })).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permissions: [{ action: "*", resource: "*", effect: "allow" }]
      })
    });
    expect(openCodePermissionEnv({ harness: "opencode", mode: "default" })).toEqual({});
    expect(OPENCODE_RESTRICTED_PERMISSION_REPLY).toBe("reject");
    expect(() => openCodePermissionEnv({ harness: "claude", mode: "default" })).toThrow(/OpenCode permissions/);
  });
});

describe("OpenCode V2 fail-closed subscription and override gate", () => {
  test("admits stock OAuth routes for anthropic and openai including fast variants with exact id match", () => {
    const surface = stockSurface();
    expect(verifyOpenCodeSubscriptionRoute(surface)).toEqual({
      providerID: "anthropic", id: "claude-sonnet-4-6", integrationID: "anthropic"
    });
    expect(verifyOpenCodeSubscriptionRoute(surface, "anthropic/claude-opus-5")).toEqual({
      providerID: "anthropic", id: "claude-opus-5", integrationID: "anthropic"
    });
    expect(verifyOpenCodeSubscriptionRoute(surface, "anthropic/claude-opus-5-fast")).toEqual({
      providerID: "anthropic", id: "claude-opus-5-fast", integrationID: "anthropic"
    });
    expect(verifyOpenCodeSubscriptionRoute(surface, "openai/gpt-6.2-sol-fast")).toEqual({
      providerID: "openai", id: "gpt-6.2-sol-fast", integrationID: "openai"
    });
  });

  test("requires exact id match (never fuzzy modelID match) and rejects duplicate provider/model/integration rows", () => {
    // Only gpt-6.2-sol-fast (id) has modelID === "gpt-6.2-sol"; requesting openai/gpt-6.2-sol must fail!
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface(), "openai/gpt-6.2-sol")).toThrow(AuthModeError);

    const dupModel = stockSurface({
      models: [...stockSurface().models, { ...stockSurface().models[0] }]
    });
    expect(() => verifyOpenCodeSubscriptionRoute(dupModel, "anthropic/claude-sonnet-4-6")).toThrow(/duplicate/);

    const dupProvider = stockSurface({
      providers: [...stockSurface().providers, { ...stockSurface().providers[0] }]
    });
    expect(() => verifyOpenCodeSubscriptionRoute(dupProvider)).toThrow(/duplicate/);

    const dupIntegration = stockSurface({
      integrations: [...stockSurface().integrations, { ...stockSurface().integrations[0] }]
    });
    expect(() => verifyOpenCodeSubscriptionRoute(dupIntegration)).toThrow(/duplicate/);
  });

  test("rejects unverified providers (github-copilot deferred, openrouter, opencode) and unauthenticated profiles", () => {
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface(), "github-copilot/claude-sonnet-5")).toThrow(AuthModeError);
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface(), "opencode/tidepool-alpha-free")).toThrow(AuthModeError);
    const openrouterDefault = stockSurface({
      defaultModel: { ...stockSurface().defaultModel!, id: "radixark/daisyrose-27b", providerID: "openrouter" }
    });
    try { verifyOpenCodeSubscriptionRoute(openrouterDefault); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }

    const empty = stockSurface({ integrations: [], providers: [], defaultModel: null, models: [] });
    try { verifyOpenCodeSubscriptionRoute(empty); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("auth_required"); }

    expect(() => parseOpenCodeModelRef("no-slash")).toThrow(AuthModeError);
  });

  test("rejects mixed oauth + key or env connections on a stock provider", () => {
    const mixed = stockSurface({
      integrations: [{
        id: "anthropic",
        connections: [
          { type: "credential", id: "cred_oauth", method: "oauth" },
          { type: "credential", id: "cred_key", method: "key" }
        ]
      }]
    });
    try { verifyOpenCodeSubscriptionRoute(mixed); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }

    const envConn = stockSurface({
      integrations: [{
        id: "anthropic",
        connections: [
          { type: "credential", id: "cred_oauth", method: "oauth" },
          { type: "env", id: "ANTHROPIC_API_KEY" }
        ]
      }]
    });
    try { verifyOpenCodeSubscriptionRoute(envConn); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }
  });

  test("fails closed when provider or model baseURL is absent or overridden, or when non-stock headers/body/package appear", () => {
    const base = stockSurface();
    const cases: Array<[string, Partial<OpenCodeGateSurface>]> = [
      ["missing provider baseURL", { providers: [{ ...base.providers[0], settingKeys: [], baseURL: null }] }],
      ["custom provider baseURL", { providers: [{ ...base.providers[0], baseURL: "https://proxy.example/v1" }] }],
      ["custom provider package", { providers: [{ ...base.providers[0], package: "aisdk:@evil/pkg" }] }],
      ["provider headers", { providers: [{ ...base.providers[0], headerKeys: ["x-custom"] }] }],
      ["provider body", { providers: [{ ...base.providers[0], bodyKeys: ["extra"] }] }],
      ["provider apiKey setting", { providers: [{ ...base.providers[0], settingKeys: ["baseURL", "apiKey"] }] }],
      ["provider tls setting", { providers: [{ ...base.providers[0], settingKeys: ["baseURL", "tls"] }] }],
      ["disabled provider", { providers: [{ ...base.providers[0], activation: "disabled" }] }],
      ["foreign integrationID", { providers: [{ ...base.providers[0], integrationID: "openrouter" }] }],
      ["missing model baseURL", { models: [{ ...base.models[0], settingKeys: [], baseURL: null }] }],
      ["custom model baseURL", { models: [{ ...base.models[0], baseURL: "https://m.example/v1" }] }],
      ["custom model package", { models: [{ ...base.models[0], package: "aisdk:@other/pkg" }] }],
      ["non-stock model header", { models: [{ ...base.models[0], headerKeys: ["x-custom-auth"] }] }],
      ["non-stock model body", { models: [{ ...base.models[0], bodyKeys: ["custom_route"] }] }],
      ["model apiKey setting", { models: [{ ...base.models[0], settingKeys: ["baseURL", "apiKey"] }] }]
    ];
    for (const [label, patch] of cases) {
      expect(() => verifyOpenCodeSubscriptionRoute(stockSurface(patch)), label).toThrow(AuthModeError);
    }
  });

  test("projectOpenCodeConfigDocuments projects strictly structural fields (never retains raw secrets) and gate rejects overrides", () => {
    const projected = projectOpenCodeConfigDocuments([
      { type: "directory", path: "/home/.config/opencode" },
      { type: "document", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } },
      {
        type: "document",
        path: "/proj/opencode.json",
        info: {
          providers: {
            anthropic: {
              settings: { apiKey: "sk-secret-never-retained", baseURL: "https://proxy.test/v1" },
              headers: { Authorization: "Bearer secret-header" },
              models: { "claude-sonnet-4-6": { headers: { "x-m": "secret-m" } } }
            }
          }
        }
      }
    ]);
    expect(projected.hasPermissions).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("sk-secret-never-retained");
    expect(JSON.stringify(projected)).not.toContain("secret-header");
    expect(JSON.stringify(projected)).not.toContain("secret-m");
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: projected.overrides }))).toThrow(AuthModeError);

    // Configured model variants (which merge headers and body into requests) must fail closed
    const variantOverride = projectOpenCodeConfigDocuments([
      {
        type: "document",
        path: "/proj/opencode.json",
        info: {
          providers: {
            anthropic: {
              models: {
                "claude-sonnet-4-6": {
                  variants: {
                    high: {
                      headers: { Authorization: "Bearer variant-secret" },
                      body: { routing: "proxy" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    ]);
    expect(JSON.stringify(variantOverride)).not.toContain("variant-secret");
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: variantOverride.overrides }))).toThrow(/variants/);

    // Provider-level settings + options mix must inspect BOTH (never short-circuit on settings)
    const providerMix = projectOpenCodeConfigDocuments([
      {
        type: "document",
        path: "/proj/opencode.json",
        info: {
          providers: {},
          provider: {
            anthropic: {
              settings: { timeout: 1000 },
              options: { apiKey: "sk-hidden-in-options", baseURL: "https://proxy.example/v1" }
            }
          }
        }
      }
    ]);
    expect(JSON.stringify(providerMix)).not.toContain("sk-hidden-in-options");
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: providerMix.overrides }))).toThrow(AuthModeError);

    // Provider-level settings + options both setting baseURL (even stock) must fail closed as ambiguous
    const providerDualBase = projectOpenCodeConfigDocuments([
      {
        type: "document",
        info: {
          providers: {
            anthropic: {
              settings: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL },
              options: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL }
            }
          }
        }
      }
    ]);
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: providerDualBase.overrides }))).toThrow(/conflicting baseURL/);

    // Model-level settings + options mix must inspect BOTH
    const modelMix = projectOpenCodeConfigDocuments([
      {
        type: "document",
        info: {
          providers: {
            anthropic: {
              models: {
                "claude-sonnet-4-6": {
                  settings: { cache: true },
                  options: { baseURL: "https://model-proxy.example/v1", apiKey: "sk-model-hidden" }
                }
              }
            }
          }
        }
      }
    ]);
    expect(JSON.stringify(modelMix)).not.toContain("sk-model-hidden");
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: modelMix.overrides }))).toThrow(AuthModeError);

    // Model-level settings + options both setting baseURL must fail closed
    const modelDualBase = projectOpenCodeConfigDocuments([
      {
        type: "document",
        info: {
          providers: {
            anthropic: {
              models: {
                "claude-sonnet-4-6": {
                  settings: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL },
                  options: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL }
                }
              }
            }
          }
        }
      }
    ]);
    expect(() => verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: modelDualBase.overrides }))).toThrow(/conflicting model baseURL/);

    // Benign permission-only document passes cleanly
    const benign = projectOpenCodeConfigDocuments([
      { type: "document", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }
    ]);
    expect(benign.hasPermissions).toBe(true);
    expect(verifyOpenCodeSubscriptionRoute(stockSurface({ configOverrides: benign.overrides })).providerID).toBe("anthropic");
  });

  test("CLI metadata readers pass --standalone and fail closed on errors", () => {
    const calls: string[][] = [];
    const exec = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "auth"
        ? JSON.stringify([{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }])
        : JSON.stringify([{ type: "document", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }]);
    };
    expect(readRedactedOpenCodeAuth("/bin/opencode", "/tmp", {}, exec)).toHaveLength(1);
    expect(readRedactedOpenCodeConfigOverrides("/bin/opencode", "/tmp", {}, exec).hasPermissions).toBe(true);
    expect(calls).toEqual([
      ["auth", "list", "--standalone", "--format", "json"],
      ["debug", "config", "--standalone"]
    ]);
    expect(() => readRedactedOpenCodeAuth("/bin/opencode", "/tmp", {}, () => "{bad")).toThrow(AuthModeError);
    expect(() => readRedactedOpenCodeConfigOverrides("/bin/opencode", "/tmp", {}, () => { throw new Error("boom"); })).toThrow(AuthModeError);
  });

  test("readOpenCodeServerGateSurface scopes every request with location[directory], enforces redirect:error, and rejects location mismatch", async () => {
    const urls: string[] = [];
    const redirects: Array<string | undefined> = [];
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-oc-loc-"));
    cleanup.push(() => fs.rmSync(targetDir, { recursive: true, force: true }));
    const makeFetch = (returnedDir: string) => (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      redirects.push(init?.redirect);
      if (url.includes("/api/integration")) {
        return new Response(JSON.stringify({ location: { directory: returnedDir }, data: [{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }] }));
      }
      if (url.includes("/api/provider")) {
        return new Response(JSON.stringify({ location: { directory: returnedDir }, data: [] }));
      }
      if (url.includes("/api/model/default")) {
        return new Response(JSON.stringify({ location: { directory: returnedDir }, data: null }));
      }
      if (url.includes("/api/model?")) {
        return new Response(JSON.stringify({ location: { directory: returnedDir }, data: [] }));
      }
      if (url.includes("/api/config")) {
        return new Response(JSON.stringify([{
          type: "document",
          info: { providers: { anthropic: { settings: { apiKey: "sk-live-secret-never-keep" } } } }
        }]));
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const surface = await readOpenCodeServerGateSurface({
      baseUrl: "http://127.0.0.1:12345",
      authHeader: "Basic dGVzdA==",
      directory: targetDir,
      fetchImpl: makeFetch(targetDir)
    });
    expect(urls.every((u) => u.includes(`location%5Bdirectory%5D=${encodeURIComponent(targetDir)}`))).toBe(true);
    expect(redirects.every((r) => r === "error")).toBe(true);
    expect(urls.some((u) => u.includes("/api/credential"))).toBe(false);
    expect(JSON.stringify(surface)).not.toContain("sk-live-secret-never-keep");

    await expect(readOpenCodeServerGateSurface({
      baseUrl: "http://127.0.0.1:12345",
      authHeader: "Basic dGVzdA==",
      directory: targetDir,
      fetchImpl: makeFetch("/some/other/directory")
    })).rejects.toThrow(/different directory/);
  });
});

// Live OpenCode V2 tests when a local v2 binary is installed (zero model calls, zero secret reads).
const localV2 = (() => {
  try {
    return resolveOpenCodeV2Executable({
      PATH: `${path.join(os.homedir(), ".opencode", "bin")}${path.delimiter}${process.env.PATH ?? ""}`
    });
  } catch {
    return null;
  }
})();

test.skipIf(!localV2 || process.platform === "win32")(
  "live two-directory OpenCode v2 serve --stdio scopes location[directory], enforces Basic auth, parses V2 permissions, and catches targetDir overrides",
  async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "tt-oc-v2-twodir-"));
    const home = path.join(work, "home");
    const serverDir = path.join(work, "server-cwd");
    const targetDir = path.join(work, "target-dir");
    const tmpdir = path.join(work, "tmp");
    for (const d of [home, serverDir, targetDir, tmpdir]) fs.mkdirSync(d, { recursive: true });
    execFileSync("git", ["-C", serverDir, "init", "-q"]);
    execFileSync("git", ["-C", targetDir, "init", "-q"]);

    // serverDir stays completely clean; ONLY targetDir has an override + ask/deny rules!
    fs.writeFileSync(path.join(targetDir, "opencode.json"), JSON.stringify({
      model: "anthropic/claude-sonnet-4-6",
      permissions: [
        { action: "shell", resource: "*", effect: "ask" },
        { action: "tool.use", resource: "bash", effect: "deny" }
      ],
      provider: {
        anthropic: {
          options: { baseURL: "https://proxy.example.test/v1", apiKey: "sk-target-only-secret" }
        }
      }
    }));

    const password = "live-gate-test-pass";
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(localV2!)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      TMPDIR: tmpdir,
      OPENCODE_PASSWORD: password,
      ...openCodePermissionEnv({ harness: "opencode", mode: "bypassPermissions" })
    };

    const srv = spawn(localV2!, ["serve", "--stdio", "--port", "0"], {
      cwd: serverDir, env, detached: true, stdio: ["pipe", "pipe", "pipe"]
    });
    cleanup.push(async () => {
      try { process.kill(-srv.pid!, "SIGTERM"); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      try { process.kill(-srv.pid!, "SIGKILL"); } catch {}
      fs.rmSync(work, { recursive: true, force: true });
    });

    const firstLine = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("timeout waiting for serve --stdio")), 8_000);
      srv.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
      });
    });
    const { url } = JSON.parse(firstLine) as { url: string };

    // Unauthenticated request must fail closed (401)
    const unauth = await fetch(`${url}/api/config`);
    expect(unauth.status).toBe(401);

    const authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const surface = await readOpenCodeServerGateSurface({ baseUrl: url, authHeader, directory: targetDir });

    // Confirm raw secret was projected out and V2 plural permissions were parsed
    expect(JSON.stringify(surface)).not.toContain("sk-target-only-secret");
    expect(surface.hasConfigPermissions).toBe(true);
    // Confirm targetDir's override was observed despite server running in clean serverDir!
    expect(surface.configOverrides.some((o) => o.providerID === "anthropic" && o.settingKeys.includes("apiKey"))).toBe(true);

    // Even with synthetic stock OAuth metadata, targetDir's project override fails closed
    const withSyntheticOAuth: OpenCodeGateSurface = {
      ...surface,
      integrations: stockSurface().integrations.slice(0, 1),
      providers: stockSurface().providers.slice(0, 1),
      defaultModel: stockSurface().defaultModel,
      models: stockSurface().models
    };
    expect(() => verifyOpenCodeSubscriptionRoute(withSyntheticOAuth)).toThrow(AuthModeError);

    // And the actual unauthenticated isolated surface fails closed as auth_required
    try { verifyOpenCodeSubscriptionRoute(surface); expect.unreachable(); }
    catch (error) { expect((error as AuthModeError).reason).toBe("auth_required"); }
  }
);

// Explicit opt-in live catalog test (set TT_TEST_OPENCODE_LIVE_CATALOG=1 when a
// local OpenCode 2.4+ service with stock Anthropic/OpenAI catalogs is running).
// Fails hard on CLI/query errors or empty catalogs rather than silently passing.
test.skipIf(process.env.TT_TEST_OPENCODE_LIVE_CATALOG !== "1" || !localV2 || process.platform === "win32")(
  "opt-in live positive metadata check against actual stock provider/model catalog",
  () => {
    const loc = `location[directory]=${os.homedir()}`;
    const rawProviders = JSON.parse(execFileSync(localV2!, ["api", "provider.list", "--param", loc], { encoding: "utf8", timeout: 6_000 })) as { data?: unknown[] };
    const rawModels = JSON.parse(execFileSync(localV2!, ["api", "model.list", "--param", loc], { encoding: "utf8", timeout: 6_000 })) as { data?: unknown[] };
    const providers = (rawProviders.data ?? []).map(projectOpenCodeProvider).filter((p): p is NonNullable<typeof p> => p !== null);
    const models = (rawModels.data ?? []).map(projectOpenCodeModel).filter((m): m is NonNullable<typeof m> => m !== null);

    const anthropicModels = models.filter((m) => m.providerID === "anthropic");
    const openaiModels = models.filter((m) => m.providerID === "openai");
    expect(providers.some((p) => p.id === "anthropic")).toBe(true);
    expect(providers.some((p) => p.id === "openai")).toBe(true);
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(openaiModels.length).toBeGreaterThan(0);

    const surface: OpenCodeGateSurface = {
      integrations: [
        { id: "anthropic", connections: [{ type: "credential", method: "oauth" }] },
        { id: "openai", connections: [{ type: "credential", method: "oauth" }] }
      ],
      providers,
      defaultModel: anthropicModels[0],
      models,
      configOverrides: [],
      allowedPolicyResources: []
    };

    for (const model of [...anthropicModels, ...openaiModels]) {
      expect(verifyOpenCodeSubscriptionRoute(surface, `${model.providerID}/${model.id}`)).toEqual({
        providerID: model.providerID,
        id: model.id,
        integrationID: model.providerID
      });
    }
    const variant = [...anthropicModels, ...openaiModels].find((m) => m.modelID && m.id !== m.modelID);
    expect(variant).toBeDefined();
    expect(verifyOpenCodeSubscriptionRoute(surface, `${variant!.providerID}/${variant!.id}`).id).toBe(variant!.id);
  }
);

describe("OpenCode adapter route decision", () => {
  test("rejects policy allows outside the worker's providers", () => {
    for (const resource of ["*", "openrouter", "openai"]) {
      expect(() => decideOpenCodeRoute(stockSurface({ allowedPolicyResources: [resource] }), ["anthropic"]))
        .toThrow(/configuration allows another model provider/);
    }
  });

  test("waits for integrations and a catalog restricted to the named provider", () => {
    expect(decideOpenCodeRoute(stockSurface({ integrations: [], models: [] }), ["anthropic"])).toBeNull();
    expect(decideOpenCodeRoute(stockSurface(), ["anthropic"], "anthropic/claude-sonnet-4-6")).toBeNull();
    const surface = stockSurface({ models: stockSurface().models.filter((model) => model.providerID === "anthropic") });
    expect(decideOpenCodeRoute(surface, ["anthropic"], "anthropic/claude-sonnet-4-6"))
      .toMatchObject({ providerID: "anthropic", id: "claude-sonnet-4-6" });
  });

  test("checks every selectable route and reports an authenticated provider's API-key mode", () => {
    const original = stockSurface();
    const models = original.models.filter((model) => ["anthropic", "openai"].includes(model.providerID));
    const unsafeModel = { ...models[0], id: "alternate", baseURL: "https://example.invalid" };
    expect(() => decideOpenCodeRoute(stockSurface({ models: [...models, unsafeModel] }), ["anthropic", "openai"]))
      .toThrow(/stock OAuth endpoint/);
    const integrations = original.integrations.map((integration) => integration.id === "openai"
      ? { ...integration, connections: [{ type: "credential", method: "key" }] } : integration);
    expect(() => decideOpenCodeRoute(stockSurface({ models, integrations }), ["anthropic", "openai"]))
      .toThrow(/non-OAuth/);
  });

  test("reports a loaded but signed-out profile as auth_required", () => {
    const surface = stockSurface({ integrations: [{ id: "anthropic", connections: [] }], models: [], defaultModel: null });
    expect(() => decideOpenCodeRoute(surface, ["anthropic"])).toThrow(expect.objectContaining({ reason: "auth_required" }));
  });
});
