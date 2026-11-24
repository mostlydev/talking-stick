// A stand-in for `opencode serve --stdio`: one announced loopback URL, Basic
// auth with OPENCODE_SERVER_PASSWORD, the session, prompt, interrupt, model
// and permission routes, and a server-sent event stream. It exits on stdin EOF.
//
// Prompt text steers it: "ask" raises a permission request, "child-ask" raises
// one from a subagent conversation, "foreign-ask" one from an unrelated
// conversation, "hang" keeps the turn running, "hang-post" never answers the
// prompt, "cancel" cancels the admitted item, "nodeliver" never delivers it,
// and "stray" first emits work in the conversation that no prompt started.
// FAKE_OPENCODE_EARLY sends a prompt's events before its response.
import fs from "node:fs";
import http from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const log = process.env.FAKE_OPENCODE_LOG;
const sessions = new Map();
for (const id of (process.env.FAKE_OPENCODE_EXISTING ?? "").split(",").filter(Boolean)) {
  const model = process.env.FAKE_OPENCODE_EXISTING_MODEL ? JSON.parse(process.env.FAKE_OPENCODE_EXISTING_MODEL) : undefined;
  sessions.set(id, { id, location: { directory: process.env.FAKE_OPENCODE_EXISTING_DIR ?? process.cwd() }, ...(model ? { model } : {}) });
}
const clients = new Set();
let inbox = 0;
let running = null;
let catalogReads = 0;
const model = {
  providerID: "anthropic", id: "claude-sonnet",
  package: "@opencode/ai/providers/anthropic", settings: { baseURL: "https://api.anthropic.com/v1" }
};
const record = (entry) => { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\n"); };
record({ argv: process.argv.slice(2) });
if (process.env.FAKE_OPENCODE_STOCK) {
  const file = process.env.OPENCODE_CONFIG;
  record({ policyFile: file, policy: JSON.parse(fs.readFileSync(file, "utf8")), mode: fs.statSync(file).mode & 0o777 });
}

const emit = (type, data) => {
  const frame = `data: ${JSON.stringify(process.env.FAKE_OPENCODE_WRAP ? { event: { type, data } } : { type, data })}\n\n`;
  for (const response of clients) response.write(frame);
};
const later = (fn, ms = 10) => setTimeout(fn, ms);
const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};

const server = http.createServer((request, response) => {
  const authorized = request.headers.authorization === "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://127.0.0.1");
    record({ method: request.method, path: url.pathname, authorized, body: body ? JSON.parse(body) : null });
    if (!authorized) return json(response, 401, { error: "unauthorized" });
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && url.pathname === "/api/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": connected\n\n");
      clients.add(response);
      response.on("close", () => clients.delete(response));
      return;
    }
    if (process.env.FAKE_OPENCODE_STOCK && request.method === "GET") {
      const location = { directory: url.searchParams.get("location[directory]") };
      if (url.pathname === "/api/integration") {
        const data = catalogReads++ === 0 ? [] : [{ id: "anthropic", connections: [{ type: "credential", method: "oauth" }] }];
        return json(response, 200, { location, data });
      }
      if (url.pathname === "/api/provider") return json(response, 200, {
        location, data: [{ ...model, id: "anthropic", integrationID: "anthropic", activation: "auto" }]
      });
      if (url.pathname === "/api/model/default") return json(response, 200, { location, data: model });
      if (url.pathname === "/api/model") return json(response, 200, { location, data: [model] });
      if (url.pathname === "/api/config") {
        const foreignAction = process.env.FAKE_OPENCODE_FOREIGN_RULE;
        return json(response, 200, foreignAction ? [{ type: "document",
          info: { policies: [{ action: foreignAction, resource: "*", effect: "allow" }] }
        }] : []);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/session") {
      const id = "ses_fake1";
      const { location, model } = JSON.parse(body || "{}");
      sessions.set(id, { id, location, ...(model && !process.env.FAKE_OPENCODE_IGNORE_MODEL ? { model } : {}) });
      return json(response, 200, { data: { id } });
    }
    const [, , sessionID, action, requestID, reply] = parts;
    if (parts[0] !== "api" || parts[1] !== "session" || !sessions.has(sessionID)) return json(response, 404, { error: "not found" });
    if (request.method === "GET" && !action) {
      if (process.env.FAKE_OPENCODE_REDIRECT) {
        response.writeHead(307, { Location: "http://127.0.0.1:1/elsewhere" });
        return response.end();
      }
      const slow = process.env.FAKE_OPENCODE_SLOW_CHILD && sessions.get(sessionID)?.parentID;
      if (slow) return later(() => json(response, 200, { data: sessions.get(sessionID) }), 200);
      return json(response, 200, { data: sessions.get(sessionID) });
    }
    if (request.method === "POST" && action === "model") {
      sessions.get(sessionID).model = JSON.parse(body);
      return json(response, 200, { data: sessions.get(sessionID) });
    }
    if (request.method === "POST" && action === "prompt") {
      const { text } = JSON.parse(body);
      if (text.includes("hang-post")) return; // admitted, perhaps, but never answered
      const id = `inbox_${++inbox}`;
      const respond = () => json(response, 200, { data: { id, sessionID, type: "user", time: { created: 1 }, payload: { text }, delivery: "queue" } });
      if (text.includes("cancel")) { respond(); later(() => emit("session.inbox.cancelled", { sessionID, inboxID: id })); return; }
      if (text.includes("nodeliver")) { respond(); return; }
      const run = (early) => {
        emit("session.inbox.delivered", { sessionID, inboxID: id });
        emit("session.execution.started", { sessionID });
        running = sessionID;
        if (text.includes("child-ask")) {
          sessions.set("ses_grandchild", { id: "ses_grandchild", parentID: "ses_child" });
          sessions.set("ses_child", { id: "ses_child", parentID: sessionID });
          const asked = { id: "per_child", sessionID: "ses_grandchild", action: "bash", resources: ["ls"], message: "Subagent runs ls" };
          emit("permission.asked", asked);
          emit("permission.asked", asked); // the same request, repeated before any lookup finishes
          emit("permission.replied", { sessionID: "ses_other", requestID: "per_child", reply: "once" });
          if (text.includes("late")) { running = null; emit("session.execution.succeeded", { sessionID }); }
        } else if (text.includes("foreign-ask")) {
          sessions.set("ses_foreign", { id: "ses_foreign" });
          const asked = { id: "per_foreign", sessionID: "ses_foreign", action: "bash", resources: ["rm"], message: "Foreign" };
          emit("permission.asked", asked);
          later(() => emit("permission.asked", asked), 80); // repeated after it was refused
        } else if (text.includes("ask")) emit("permission.asked", { id: "per_1", sessionID, action: "bash", resources: ["ls"],
          message: text.includes("oversized-ask") ? "x".repeat(140 * 1024) : text.includes("invisible-ask") ? "Run\u202Els" : "Run ls" });
        else if (!text.includes("hang")) {
          const succeed = () => { running = null; emit("session.execution.succeeded", { sessionID }); };
          if (early) succeed(); else later(succeed);
        }
      };
      if (text.includes("stray")) {
        emit("session.execution.started", { sessionID });
        emit("permission.asked", { id: "per_stray", sessionID, action: "bash", resources: ["rm"], message: "Stray" });
        emit("session.execution.succeeded", { sessionID });
      }
      if (process.env.FAKE_OPENCODE_EARLY) { run(true); later(respond, 60); }
      else { respond(); later(() => run(false)); }
      return;
    }
    if (request.method === "POST" && action === "interrupt") {
      const interrupted = running === sessionID;
      json(response, 200, { interrupted });
      if (interrupted) later(() => { running = null; emit("session.execution.interrupted", { sessionID, reason: "user" }); });
      return;
    }
    if (request.method === "POST" && action === "permission" && reply === "reply") {
      response.writeHead(204);
      response.end();
      later(() => {
        emit("permission.replied", { sessionID, requestID, reply: JSON.parse(body).decision });
        if (["per_1", "per_child", "per_foreign"].includes(requestID) && running) {
          const root = running;
          running = null;
          emit("session.execution.succeeded", { sessionID: root });
        }
      });
      return;
    }
    json(response, 404, { error: "not found" });
  });
});

server.listen(0, "127.0.0.1", () => {
  const announced = process.env.FAKE_OPENCODE_URL ?? `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(JSON.stringify({ url: announced }) + "\n");
});
process.stdin.resume();
process.stdin.on("end", () => { for (const client of clients) client.end(); server.close(); process.exit(0); });
