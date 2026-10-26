// A deterministic stand-in for `claude -p` in stream-json mode, for adapter
// tests. It records its argv, environment markers and every input line.
const readline = require("node:readline");
const fs = require("node:fs");
const mode = process.env.FIXTURE_MODE ?? "";
const trace = (value) => { if (process.env.FIXTURE_TRACE) fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + "\n"); };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
trace({ argv: process.argv.slice(2), env: { CLAUDECODE: process.env.CLAUDECODE ?? null, TT_ROOM: process.env.TT_ROOM ?? null,
  TALKING_STICK_DATA_DIR: process.env.TALKING_STICK_DATA_DIR ?? null, TT_SUPERVISOR_ENDPOINT: process.env.TT_SUPERVISOR_ENDPOINT ?? null } });
let busy = false;
let pendingTool = null;
const result = (subtype, extra = {}) => { busy = false; out({ type: "result", subtype, is_error: subtype !== "success", ...extra }); };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  trace(message);
  if (message.type === "control_request") {
    if (message.request.subtype === "initialize") {
      if (mode === "hang-init") return;
      return out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { pid: process.pid } } });
    }
    if (message.request.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (busy) result("error_during_execution");
      return;
    }
    return;
  }
  if (message.type === "control_response") {
    if (pendingTool && message.response.request_id === pendingTool) {
      pendingTool = null;
      out({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
      return result("success", { result: "DONE" });
    }
    return;
  }
  if (message.type !== "user") return;
  busy = true;
  out({ type: "system", subtype: "init", session_id: "fixture" });
  if (mode === "approval" || mode === "cancel") {
    pendingTool = "perm-1";
    out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash",
      input: { command: "touch x", description: "Create x" } } });
    if (mode === "cancel") {
      out({ type: "control_cancel_request", request_id: "perm-1" });
      pendingTool = null;
      result("error_during_execution");
    }
    return;
  }
  if (mode === "unsupported") {
    out({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "x" } });
  }
  if (mode === "auth") return result("error_during_execution", { result: "Invalid API key · Please run /login" });
  if (mode === "slow") return;
  out({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
  result("success", { result: "ok" });
});
