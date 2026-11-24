// A stand-in for `opencode serve --stdio`: one announced loopback URL, Basic
// auth with OPENCODE_SERVER_PASSWORD, the session, prompt, interrupt and
// permission routes, and a server-sent event stream. It exits on stdin EOF.
import fs from "node:fs";
import http from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const log = process.env.FAKE_OPENCODE_LOG;
const existing = new Set((process.env.FAKE_OPENCODE_EXISTING ?? "").split(",").filter(Boolean));
const sessions = new Map([...existing].map((id) => [id, { id, location: { directory: process.env.FAKE_OPENCODE_EXISTING_DIR ?? process.cwd() } }]));
const clients = new Set();
let inbox = 0;
let running = null;
const record = (entry) => { if (log) fs.appendFileSync(log, JSON.stringify(entry) + "\n"); };
record({ argv: process.argv.slice(2) });

const emit = (type, data) => {
  const frame = `data: ${JSON.stringify(process.env.FAKE_OPENCODE_WRAP ? { event: { type, data } } : { type, data })}\n\n`;
  for (const response of clients) response.write(frame);
};
const later = (fn) => setTimeout(fn, 10);
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
    if (request.method === "POST" && url.pathname === "/api/session") {
      const id = "ses_fake1";
      const { location, model } = JSON.parse(body || "{}");
      sessions.set(id, { id, location, ...(model && !process.env.FAKE_OPENCODE_IGNORE_MODEL ? { model } : {}) });
      return json(response, 200, { data: { id } });
    }
    const [, , sessionID, action, requestID, reply] = parts;
    if (parts[0] !== "api" || parts[1] !== "session" || !sessions.has(sessionID)) return json(response, 404, { error: "not found" });
    if (request.method === "GET" && !action) return json(response, 200, { data: sessions.get(sessionID) });
    if (request.method === "POST" && action === "prompt") {
      const { text } = JSON.parse(body);
      const id = `inbox_${++inbox}`;
      json(response, 200, { data: { id, sessionID, type: "user", time: { created: 1 }, payload: { text }, delivery: "queue" } });
      later(() => {
        emit("session.inbox.delivered", { sessionID, inboxID: id });
        emit("session.execution.started", { sessionID });
        running = sessionID;
        if (text.includes("ask")) emit("permission.asked", { id: "per_1", sessionID, action: "bash", resources: ["ls"], message: "Run ls" });
        else if (!text.includes("hang")) later(() => { running = null; emit("session.execution.succeeded", { sessionID }); });
      });
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
        running = null;
        emit("session.execution.succeeded", { sessionID });
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
