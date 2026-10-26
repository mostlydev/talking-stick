const readline = require("node:readline");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.env.FIXTURE_MODE;
let thread = process.env.FIXTURE_UNICODE ? "owned-界" : "owned-thread";
let turn = null, counter = 0, approval = false, unloaded = false;
// "two-approvals" raises requests 1 and 2 together; each reply resolves only its own.
const pendingPair = new Set();
const output = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => output({ id, result });
const notify = (method, params) => output({ method, params: { threadId: thread, ...params } });
const trace = value => { if (process.env.FIXTURE_TRACE) fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + "\n"); };
const complete = status => { if (turn) notify("turn/completed", { turn: { id: turn, status } }); turn = null; };
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const m = JSON.parse(line);
  trace(m);
  if (!m.method) {
    if (m.id === 0 && approval) { approval = false; notify("serverRequest/resolved", { requestId: 0 }); complete("completed"); }
    if (pendingPair.delete(m.id)) {
      notify("serverRequest/resolved", { requestId: m.id });
      if (!pendingPair.size) complete("completed");
    }
    return;
  }
  if (m.method === "initialize") {
    if (mode === "hang-init") return;
    if (mode === "overflow") return process.stdout.write("x".repeat(300000) + "\n");
    if (mode === "malformed") return process.stdout.write("not-json\n");
    if (mode === "stderr") process.stderr.write("diagnostic".repeat(40000));
    return reply(m.id, { userAgent: "codex-fixture" });
  }
  if (m.method === "initialized") return;
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (m.method === "thread/resume" && mode === "unload-fail") return output({ id: m.id, error: { code: -32600, message: "no rollout found" } });
    if (m.params.threadId === "missing") return output({ id: m.id, error: { code: -32600, message: "no rollout found" } });
    thread = m.params.threadId || thread;
    unloaded = false;
    reply(m.id, { thread: { id: thread, status: { type: m.method === "thread/resume" && mode === "unload-stays-unloaded" ? "notLoaded" : "idle" } }, approvalPolicy: mode === "unsafe" ? "never" : m.params.approvalPolicy,
      sandbox: { type: m.params.sandbox === "read-only" ? "readOnly" : "workspaceWrite", networkAccess: false,
        writableRoots: m.params.config["sandbox_workspace_write.writable_roots"] || [] } });
    if (m.method === "thread/start" && mode === "unsupported") setTimeout(() => output({ id: 9,
      method: "item/tool/requestUserInput", params: { threadId: thread } }), 5);
    return;
  }
  if (m.method === "account/read") return reply(m.id, { account: mode === "no-auth" ? null : { type: "apiKey" }, requiresOpenaiAuth: true });
  if (m.method === "thread/read") return reply(m.id, { thread: { id: thread, status: { type: unloaded ? "notLoaded" : turn ? "active" : "idle" } } });
  if (m.method === "turn/start") {
    if (mode === "no-reply") return;
    turn = `turn-${++counter}`;
    const id = turn, text = m.params.input[0].text;
    notify("turn/started", { turn: { id, status: "inProgress" } });
    if (text === "fast") complete("completed");
    reply(m.id, { turn: { id, status: "inProgress" } });
    if (text === "two-approvals") {
      for (const id of [1, 2]) {
        pendingPair.add(id);
        output({ id, method: "item/commandExecution/requestApproval", params: { threadId: thread,
          turnId: turn, command: `synthetic harmless command ${id}`, availableDecisions: ["accept", "decline", "cancel"] } });
      }
    } else if (text === "approval") {
      approval = true;
      output({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: thread,
        turnId: turn, command: "synthetic harmless command", availableDecisions: ["accept", "decline", "cancel"] } });
    } else if (text === "unload" || text === "busy-unload") {
      if (text === "unload") complete("completed");
      unloaded = true;
      notify(mode === "closed" ? "thread/closed" : "thread/status/changed", { status: { type: "notLoaded" } });
    } else if (text !== "busy" && text !== "fast") setTimeout(() => complete("completed"), 5);
    return;
  }
  if (m.method === "turn/steer") {
    const id = turn;
    if (m.params.input[0].text === "finish-before-reply") complete("completed");
    return reply(m.id, { turnId: id });
  }
  if (m.method === "turn/interrupt") {
    reply(m.id, {});
    if (mode === "unconfirmed-interrupt") return;
    if (approval) { approval = false; notify("serverRequest/resolved", { requestId: 0 }); }
    return complete("interrupted");
  }
  output({ id: m.id, error: { code: -32601, message: "Unsupported fixture request" } });
});
if (mode === "grandchild") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: "ignore" });
  trace({ grandchild: child.pid });
}
input.on("close", () => process.exit(0));
