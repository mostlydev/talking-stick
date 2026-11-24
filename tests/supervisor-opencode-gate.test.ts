import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthModeError, type WorkerSpec } from "../src/supervisor/adapter.js";
import { builtinAdapters } from "../src/supervisor/adapters/index.js";
import {
  OPENCODE_RESTRICTED_PERMISSION_REPLY,
  OPENCODE_STOCK_OAUTH_PROVIDERS,
  openCodePermissionEnv,
  parseOpenCodeMajorVersion,
  parseOpenCodeModelRef,
  readOpenCodeServerGateSurface,
  readRedactedOpenCodeAuth,
  readRedactedOpenCodeConfig,
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
      { id: "github-copilot", name: "GitHub Copilot", connections: [{ type: "credential", id: "cred_3", label: "OAuth", method: "oauth" }] },
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
        settings: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.anthropic.baseURL }
      },
      {
        id: "openai",
        integrationID: "openai",
        activation: "auto",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.package,
        settings: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS.openai.baseURL, compaction: true, transport: "ws" }
      },
      {
        id: "github-copilot",
        integrationID: "github-copilot",
        activation: "auto",
        package: OPENCODE_STOCK_OAUTH_PROVIDERS["github-copilot"].package,
        settings: { baseURL: OPENCODE_STOCK_OAUTH_PROVIDERS["github-copilot"].baseURL }
      }
    ],
    defaultModel: { id: "claude-sonnet-4-6", providerID: "anthropic" },
    models: [
      { id: "claude-sonnet-4-6", providerID: "anthropic" },
      { id: "gpt-5.3-codex", providerID: "openai" },
      { id: "claude-sonnet-5", providerID: "github-copilot" }
    ],
    configDocuments: [],
    ...overrides
  };
}

describe("OpenCode V2 executable and environment guards", () => {
  test("does not publicly register opencode in builtinAdapters yet", () => {
    expect(builtinAdapters().opencode).toBeUndefined();
  });

  test("parses v1 and v2 version outputs and skips v1 shims shadowing v2 on PATH", () => {
    expect(parseOpenCodeMajorVersion("1.3.3")).toBe(1);
    expect(parseOpenCodeMajorVersion("opencode v2.4.1\n")).toBe(2);
    expect(parseOpenCodeMajorVersion("unknown")).toBeNull();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-oc-bin-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const v1Dir = path.join(root, "v1");
    const v2Dir = path.join(root, "v2");
    fs.mkdirSync(v1Dir);
    fs.mkdirSync(v2Dir);
    const v1Bin = path.join(v1Dir, "opencode");
    const v2Bin = path.join(v2Dir, "opencode");
    fs.writeFileSync(v1Bin, "#!/bin/sh\necho 1.3.3\n", { mode: 0o755 });
    fs.writeFileSync(v2Bin, "#!/bin/sh\necho opencode v2.4.1\n", { mode: 0o755 });

    const realV1 = fs.realpathSync(v1Bin);
    const realV2 = fs.realpathSync(v2Bin);
    const fakeExec = (file: string) => file === realV1 ? "1.3.3\n" : "opencode v2.4.1\n";

    expect(resolveOpenCodeV2Executable({ PATH: `${v1Dir}${path.delimiter}${v2Dir}` }, fakeExec)).toBe(realV2);
    expect(() => resolveOpenCodeV2Executable({ PATH: v1Dir }, fakeExec)).toThrow(/OpenCode v2 or newer is required/);
    expect(() => resolveOpenCodeV2Executable({ OPENCODE_EXECUTABLE: v1Bin }, fakeExec)).toThrow(/v2 or newer/);
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

  test("maps bypassPermissions vs default permission modes cleanly", () => {
    expect(openCodePermissionEnv({ harness: "opencode", mode: "bypassPermissions" })).toEqual({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" })
    });
    expect(openCodePermissionEnv({ harness: "opencode", mode: "default" })).toEqual({});
    expect(OPENCODE_RESTRICTED_PERMISSION_REPLY).toBe("reject");
    expect(() => openCodePermissionEnv({ harness: "claude", mode: "default" })).toThrow(/OpenCode permissions/);
  });
});

describe("OpenCode V2 fail-closed subscription and override gate", () => {
  test("admits stock OAuth routes for anthropic, openai, and github-copilot", () => {
    const surface = stockSurface();
    expect(verifyOpenCodeSubscriptionRoute(surface)).toEqual({
      providerID: "anthropic", modelID: "claude-sonnet-4-6", integrationID: "anthropic"
    });
    expect(verifyOpenCodeSubscriptionRoute(surface, "openai/gpt-5.3-codex")).toEqual({
      providerID: "openai", modelID: "gpt-5.3-codex", integrationID: "openai"
    });
    expect(verifyOpenCodeSubscriptionRoute(surface, "github-copilot/claude-sonnet-5")).toEqual({
      providerID: "github-copilot", modelID: "claude-sonnet-5", integrationID: "github-copilot"
    });
  });

  test("allows benign permission-only config documents (including OPENCODE_CONFIG_CONTENT bypass)", () => {
    const surface = stockSurface({
      configDocuments: [
        { type: "directory", path: "/tmp/home/.config/opencode" },
        { type: "document", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }
      ]
    });
    expect(verifyOpenCodeSubscriptionRoute(surface).providerID).toBe("anthropic");
  });

  test("rejects unauthenticated profiles as auth_required, never silently allowing free/default models", () => {
    const empty = stockSurface({
      integrations: [],
      providers: [],
      defaultModel: { id: "tidepool-alpha-free", providerID: "opencode" },
      models: [{ id: "tidepool-alpha-free", providerID: "opencode" }]
    });
    expect(() => verifyOpenCodeSubscriptionRoute(empty)).toThrow(AuthModeError);
    try { verifyOpenCodeSubscriptionRoute(empty); } catch (e) { expect((e as AuthModeError).reason).toBe("auth_required"); }

    const noDefault = stockSurface({ integrations: [], providers: [], defaultModel: null, models: [] });
    try { verifyOpenCodeSubscriptionRoute(noDefault); } catch (e) { expect((e as AuthModeError).reason).toBe("auth_required"); }
  });

  test("rejects API-key defaults (openrouter), ambiguous mixed providers (opencode), and unsupported providers", () => {
    const openrouterDefault = stockSurface({
      defaultModel: { id: "radixark/daisyrose-27b", providerID: "openrouter" }
    });
    try { verifyOpenCodeSubscriptionRoute(openrouterDefault); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }

    try { verifyOpenCodeSubscriptionRoute(stockSurface(), "opencode/tidepool-alpha-free"); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }

    expect(() => parseOpenCodeModelRef("no-slash")).toThrow(AuthModeError);
  });

  test("rejects mixed oauth + key or env connections on a stock provider (fails closed on ambiguous credential)", () => {
    const mixed = stockSurface({
      integrations: [
        {
          id: "anthropic",
          connections: [
            { type: "credential", id: "cred_oauth", method: "oauth" },
            { type: "credential", id: "cred_key", method: "key" }
          ]
        }
      ]
    });
    try { verifyOpenCodeSubscriptionRoute(mixed); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }

    const envConn = stockSurface({
      integrations: [
        {
          id: "anthropic",
          connections: [
            { type: "credential", id: "cred_oauth", method: "oauth" },
            { type: "env", id: "ANTHROPIC_API_KEY" }
          ]
        }
      ]
    });
    try { verifyOpenCodeSubscriptionRoute(envConn); expect.unreachable(); }
    catch (e) { expect((e as AuthModeError).reason).toBe("wrong_auth_mode"); }
  });

  test("rejects provider package, baseURL, header, body, and apiKey overrides in provider metadata", () => {
    const cases: Array<[string, Partial<OpenCodeGateSurface>]> = [
      ["custom package", { providers: [{ ...stockSurface().providers[0], package: "aisdk:@evil/pkg" }] }],
      ["custom baseURL", { providers: [{ ...stockSurface().providers[0], settings: { baseURL: "https://proxy.example/v1" } }] }],
      ["provider headers", { providers: [{ ...stockSurface().providers[0], headers: { "x-custom": "***" } }] }],
      ["provider body", { providers: [{ ...stockSurface().providers[0], body: { extra: true } }] }],
      ["provider apiKey setting", { providers: [{ ...stockSurface().providers[0], settings: { baseURL: "https://api.anthropic.com/v1", apiKey: "***" } }] }],
      ["provider tls override", { providers: [{ ...stockSurface().providers[0], settings: { tls: { rejectUnauthorized: false } } }] }],
      ["disabled provider", { providers: [{ ...stockSurface().providers[0], activation: "disabled" }] }],
      ["foreign integrationID", { providers: [{ ...stockSurface().providers[0], integrationID: "openrouter" }] }],
      ["model headers", { models: [{ id: "claude-sonnet-4-6", providerID: "anthropic", headers: { "x-m": "***" } }] }],
      ["model baseURL", { models: [{ id: "claude-sonnet-4-6", providerID: "anthropic", settings: { baseURL: "https://m.example" } }] }],
      ["model package", { models: [{ id: "claude-sonnet-4-6", providerID: "anthropic", package: "aisdk:@other/pkg" }] }],
      ["missing model from catalog", { models: [{ id: "other-model", providerID: "anthropic" }] }]
    ];
    for (const [label, patch] of cases) {
      expect(() => verifyOpenCodeSubscriptionRoute(stockSurface(patch)), label).toThrow(AuthModeError);
    }
  });

  test("rejects project/user config document overrides even when provider metadata looks stock", () => {
    const docCases: Array<[string, Record<string, unknown>]> = [
      ["redacted apiKey", { providers: { anthropic: { settings: { apiKey: "***" } } } }],
      ["custom baseURL", { providers: { anthropic: { settings: { baseURL: "https://proxy.test/v1" } } } }],
      ["custom package", { providers: { anthropic: { package: "aisdk:@evil/pkg" } } }],
      ["custom npm", { providers: { anthropic: { npm: "@evil/pkg" } } }],
      ["provider headers", { providers: { anthropic: { headers: { "x-auth": "***" } } } }],
      ["model headers", { providers: { anthropic: { models: { "claude-sonnet-4-6": { headers: { "x-m": "***" } } } } } }],
      ["model baseURL", { providers: { anthropic: { models: { "claude-sonnet-4-6": { settings: { baseURL: "https://m.test" } } } } } }]
    ];
    for (const [label, info] of docCases) {
      const surface = stockSurface({ configDocuments: [{ type: "document", path: "/proj/opencode.json", info }] });
      expect(() => verifyOpenCodeSubscriptionRoute(surface), label).toThrow(AuthModeError);
    }
  });

  test("CLI metadata readers pass --standalone and fail closed on invalid JSON or errors", () => {
    const calls: string[][] = [];
    const exec = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "auth" ? JSON.stringify([{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }])
        : JSON.stringify([{ type: "directory", path: "/tmp" }]);
    };
    expect(readRedactedOpenCodeAuth("/bin/opencode", "/tmp", {}, exec)).toHaveLength(1);
    expect(readRedactedOpenCodeConfig("/bin/opencode", "/tmp", {}, exec)).toHaveLength(1);
    expect(calls).toEqual([
      ["auth", "list", "--standalone", "--format", "json"],
      ["debug", "config", "--standalone"]
    ]);
    expect(() => readRedactedOpenCodeAuth("/bin/opencode", "/tmp", {}, () => "{bad")).toThrow(AuthModeError);
    expect(() => readRedactedOpenCodeConfig("/bin/opencode", "/tmp", {}, () => { throw new Error("boom"); })).toThrow(AuthModeError);
  });

  test("readOpenCodeServerGateSurface queries the localhost API and redacts config secrets on arrival", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/api/integration")) {
        return new Response(JSON.stringify({ data: [{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }] }));
      }
      if (url.includes("/api/provider")) {
        return new Response(JSON.stringify({ data: [stockSurface().providers[0]] }));
      }
      if (url.includes("/api/model/default")) {
        return new Response(JSON.stringify({ data: { id: "claude-sonnet-4-6", providerID: "anthropic" } }));
      }
      if (url.includes("/api/model?")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6", providerID: "anthropic" }] }));
      }
      if (url.includes("/api/config")) {
        return new Response(JSON.stringify([{
          type: "document",
          path: "/proj/opencode.json",
          info: { providers: { anthropic: { settings: { apiKey: "sk-live-secret-never-keep" }, headers: { Authorization: "Bearer secret" } } } }
        }]));
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const surface = await readOpenCodeServerGateSurface({
      baseUrl: "http://127.0.0.1:12345",
      authHeader: "Basic dGVzdA==",
      directory: "/proj",
      fetchImpl: fakeFetch
    });
    expect(urls.some((u) => u.includes("/api/credential"))).toBe(false);
    expect(JSON.stringify(surface)).not.toContain("sk-live-secret-never-keep");
    expect(JSON.stringify(surface)).not.toContain("Bearer secret");
    expect(() => verifyOpenCodeSubscriptionRoute(surface)).toThrow(AuthModeError);
  });
});

// Live isolated verification against local OpenCode v2 binary when installed (zero real user data, zero model calls).
const localV2 = (() => {
  try {
    return resolveOpenCodeV2Executable({
      PATH: `${path.join(os.homedir(), ".opencode", "bin")}${path.delimiter}${process.env.PATH ?? ""}`
    });
  } catch {
    return null;
  }
})();

test.skipIf(!localV2 || process.platform === "win32")("live isolated OpenCode v2 serve --stdio fails closed on unauthenticated profile and project overrides", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tt-oc-v2-live-"));
  const home = path.join(work, "home");
  const proj = path.join(work, "proj");
  const tmpdir = path.join(work, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(tmpdir, { recursive: true });
  execFileSync("git", ["-C", proj, "init", "-q"]);
  fs.writeFileSync(path.join(proj, "opencode.json"), JSON.stringify({
    model: "anthropic/claude-sonnet-4-6",
    provider: {
      anthropic: {
        options: { baseURL: "https://proxy.example.test/v1", apiKey: "sk-test-fake" }
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
    cwd: proj, env, detached: true, stdio: ["pipe", "pipe", "pipe"]
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
  const authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

  const surface = await readOpenCodeServerGateSurface({ baseUrl: url, authHeader, directory: proj });
  expect(JSON.stringify(surface)).not.toContain("sk-test-fake");
  expect(surface.configDocuments.some((doc) => Array.isArray(doc.info?.permissions))).toBe(true);
  // Even if an attacker had stock anthropic OAuth, the project opencode.json override is caught!
  const withSyntheticOAuth: OpenCodeGateSurface = {
    ...surface,
    integrations: [{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }],
    providers: [stockSurface().providers[0]],
    defaultModel: { id: "claude-sonnet-4-6", providerID: "anthropic" },
    models: [{ id: "claude-sonnet-4-6", providerID: "anthropic" }]
  };
  expect(() => verifyOpenCodeSubscriptionRoute(withSyntheticOAuth)).toThrow(AuthModeError);
  // And the actual unauthenticated isolated surface fails closed as auth_required!
  try {
    verifyOpenCodeSubscriptionRoute(surface);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AuthModeError);
    expect((error as AuthModeError).reason).toBe("auth_required");
  }
});
