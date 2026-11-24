// OpenCode loads this plugin only inside a supervised generation. The plugin
// compares the native request's bearer with OpenCode's active OAuth credential
// in the same process. No credential values leave OpenCode.
export const OPENCODE_REQUEST_GUARD_ID = "shrooms.worker-request-guard";

export function renderOpenCodeRequestGuard(allowedProviders: readonly string[]): string {
  return `const allowed = new Set(${JSON.stringify(allowedProviders)});
const endpoints = {
  anthropic: { "api.anthropic.com": "/v1/messages" },
  openai: { "api.openai.com": "/v1/responses", "chatgpt.com": "/backend-api/codex/responses" }
};

export default {
  id: ${JSON.stringify(OPENCODE_REQUEST_GUARD_ID)},
  async setup(ctx) {
    async function requireOAuth(event, websocket) {
      try {
        const providerID = event.model?.providerID;
        if (!allowed.has(providerID)) throw new Error();
        const url = new URL(websocket ? event.url : event.request.url);
        const paths = endpoints[providerID];
        if (url.protocol !== (websocket ? "wss:" : "https:") ||
            url.port || url.username || url.password ||
            !Object.hasOwn(paths, url.hostname) || paths[url.hostname] !== url.pathname) throw new Error();

        const headers = new Headers(websocket ? event.headers : event.request.headers);
        if (headers.has("x-api-key") || headers.has("api-key") || headers.has("proxy-authorization")) throw new Error();
        const connection = await ctx.integration.connection.active(providerID);
        if (connection?.type !== "credential" || connection.method !== "oauth") throw new Error();
        const credential = await ctx.integration.connection.resolve(connection);
        if (credential?.type !== "oauth" || !credential.access ||
            headers.get("authorization") !== "Bearer " + credential.access) throw new Error();
      } catch {
        throw new Error("OpenCode worker refused a request outside its verified OAuth route.");
      }
    }

    const http = await ctx.session.hook("http.request", (event) => requireOAuth(event, false));
    const ws = await ctx.session.hook("experimental.ws.handshake", (event) => requireOAuth(event, true));
    return () => { http?.dispose?.(); ws?.dispose?.(); };
  }
};
`;
}

export async function openCodeRequestGuardActive(input: {
  url: string;
  authorization: string;
  cwd: string;
  pluginDir: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const query = new URLSearchParams({ "location[directory]": input.cwd });
  const response = await fetch(`${input.url}/api/plugin?${query}`, {
    headers: { Authorization: input.authorization, Accept: "application/json" },
    redirect: "error",
    signal: input.signal
  });
  if (!response.ok) return false;
  const report = await response.json() as {
    location?: { directory?: string };
    data?: Array<{ id?: string; source?: { type?: string; path?: string }; state?: { status?: string } }>;
  };
  if (report.location?.directory !== input.cwd || !Array.isArray(report.data)) return false;
  const isGuard = (plugin: typeof report.data[number]) => plugin.id === OPENCODE_REQUEST_GUARD_ID &&
    plugin.source?.type === "local" && plugin.source.path === input.pluginDir && plugin.state?.status === "active";
  // Policy-denied plugins are absent from the native report. A listed
  // third-party plugin may still be starting and register a later hook.
  return report.data.filter(isGuard).length === 1 &&
    report.data.every((plugin) => isGuard(plugin) || plugin.source?.type === "builtin");
}
