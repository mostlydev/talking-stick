// A stand-in for `agy --input-format stream-json --output-format stream-json`.
// It emits init, then one result for each user event. It never expects a
// control response. A control response is traced so a test can fail on it.
const readline = require("node:readline");
const fs = require("node:fs");
const trace = (value) => { if (process.env.FIXTURE_TRACE) fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + "\n"); };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const conversation = process.env.FIXTURE_CONVERSATION
  ?? (process.argv.includes("--conversation") ? process.argv[process.argv.indexOf("--conversation") + 1] : "conv-1");
trace({ argv: process.argv.slice(2), env: {
  TT_ROOM: process.env.TT_ROOM ?? null,
  ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID ?? null,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "set" : null,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? "set" : null,
}});
out({ event: "init", conversation_id: conversation, init: { cwd: process.cwd(), tools: ["ask_permission"], permission_mode: "request-review" } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  trace(message);
  if (message.event === "control_response" || message.event === "control_request") return;
  if (message.event !== "user") return;
  const id = message.message?.content ?? "";
  out({ event: "step_update", step_update: { conversation_id: conversation, step_index: 0, state: "DONE", step_type: "user_input" } });
  out({ event: "result", result: { conversation_id: conversation, status: "SUCCESS", response: `${id}\n`, num_turns: 1 } });
});
