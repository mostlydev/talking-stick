import { expect, test } from "vitest";
import { renderOpenCodeRequestGuard } from "../src/supervisor/adapters/opencode-request-guard.js";

type RequestGuard = (event: {
  model: { providerID: string; id: string };
  request?: Request;
  url?: URL;
  headers?: Record<string, string>;
}) => Promise<void>;

test("guards the actual HTTP and WebSocket route and the matching OAuth bearer on every call", async () => {
  const source = "data:text/javascript;base64," + Buffer.from(renderOpenCodeRequestGuard(["openai", "anthropic"])).toString("base64");
  const { default: plugin } = await import(/* @vite-ignore */ source);
  const hooks = new Map<string, RequestGuard>();
  let active = { type: "credential", method: "oauth" };
  let credential = { type: "oauth", access: "fixture-oauth" };
  await plugin.setup({
    session: { hook: async (name: string, callback: RequestGuard) => { hooks.set(name, callback); } },
    integration: { connection: { active: async () => active, resolve: async () => credential } }
  });

  const openai = { providerID: "openai", id: "same-model" };
  const anthropic = { providerID: "anthropic", id: "same-model" };
  const headers = { Authorization: "Bearer fixture-oauth" };
  const http = hooks.get("http.request")!;
  const ws = hooks.get("experimental.ws.handshake")!;
  const control = { model: openai, request: new Request("https://api.openai.com/v1/responses", { headers }) };

  await expect(http(control)).resolves.toBeUndefined();
  await expect(http({ model: anthropic, request: new Request("https://api.anthropic.com/v1/messages", { headers }) }))
    .resolves.toBeUndefined();
  await expect(ws({ model: openai, url: new URL("wss://api.openai.com/v1/responses"), headers }))
    .resolves.toBeUndefined();

  const refused = /outside its verified OAuth route/;
  await expect(http({ ...control, request: new Request("https://proxy.invalid/v1/responses", { headers }) })).rejects.toThrow(refused);
  await expect(ws({ model: openai, url: new URL("wss://api.openai.com:1234/v1/responses"), headers })).rejects.toThrow(refused);
  await expect(http({ ...control, request: new Request(control.request, { headers: { ...headers, "x-api-key": "fixture-key" } }) }))
    .rejects.toThrow(refused);
  credential = { type: "oauth", access: "replacement-oauth" };
  await expect(http(control)).rejects.toThrow(refused);
  credential = { type: "oauth", access: "fixture-oauth" };
  active = { type: "credential", method: "key" };
  await expect(http(control)).rejects.toThrow(refused);
});
