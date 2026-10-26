// A deterministic stand-in for `grok agent --no-leader stdio`. It records
// argv, environment markers and every stdin line, and speaks the proven
// JSON-RPC subset: initialize, session/new, session/list, and notifications.
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const mode = process.env.FIXTURE_MODE ?? "";
const trace = (value) => { if (process.env.FIXTURE_TRACE) fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + "\n"); };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const home = process.env.GROK_HOME ?? "";
trace({
  argv: process.argv.slice(2),
  env: {
    TT_ROOM: process.env.TT_ROOM ?? null,
    GROK_AGENT: process.env.GROK_AGENT ?? null,
    GROK_SESSION_ID: process.env.GROK_SESSION_ID ?? null,
    TALKING_STICK_DATA_DIR: process.env.TALKING_STICK_DATA_DIR ?? null,
    TT_SUPERVISOR_ENDPOINT: process.env.TT_SUPERVISOR_ENDPOINT ?? null,
    TT_SUPERVISOR_TOKEN: process.env.TT_SUPERVISOR_TOKEN ?? null,
    GROK_HOME: home || null,
    HOME: process.env.HOME ?? null,
  },
  homeFiles: home && fs.existsSync(home) ? fs.readdirSync(home) : [],
  configCopied: home ? fs.existsSync(path.join(home, "config.toml")) : false,
});
const respond = (id, result) => out({ jsonrpc: "2.0", id, result });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  trace(message);
  if (!message.method) return;
  if (mode === "malformed" && message.method === "initialize") {
    process.stdout.write("not-json\n");
    return;
  }
  if (mode === "hang-init" && message.method === "initialize") return;
  if (mode === "auth" && message.method === "initialize") {
    out({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "not logged in" } });
    return;
  }
  if (message.method === "initialize") {
    out({ jsonrpc: "2.0", method: "session/update", params: { phase: "init" } });
    respond(message.id, { protocolVersion: 1 });
    return;
  }
  if (message.method === "session/new") {
    out({ jsonrpc: "2.0", method: "session/update", params: { phase: "new" } });
    if (mode === "no-session") { respond(message.id, {}); return; }
    respond(message.id, { sessionId: "grok-session-1" });
    if (mode === "server-request") {
      out({ jsonrpc: "2.0", id: 900, method: "fs/readTextFile", params: { path: "secret" } });
    }
    return;
  }
  if (message.method === "session/list") {
    respond(message.id, mode === "missing-session" ? { sessions: [] } : mode === "wrong-session" ? { sessions: [{ sessionId: "some-other-session" }] } : { sessions: [{ sessionId: "grok-session-1" }] });
  }
}).on("close", () => process.exit(0));
