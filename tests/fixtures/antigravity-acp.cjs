const readline = require("node:readline");
const fs = require("node:fs");
const trace = value => fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(value) + "\n");
const send = body => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
const sessionId = "fixture-conversation";
let pending;
trace({ argv: process.argv.slice(2) });

readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  trace(message);
  const reply = result => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({ protocolVersion: 1 });
      break;
    case "session/new":
      reply({ sessionId });
      break;
    case "session/resume":
      reply({ sessionId: message.params.sessionId === sessionId ? sessionId : "wrong-conversation" });
      break;
    case "session/list":
      reply({ sessions: [{ sessionId }] });
      break;
    case "session/prompt": {
      pending = message.id;
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk" } } });
      switch (message.params.prompt[0].text) {
        case "wait":
          break;
        case "permission":
        case "oversized permission":
          send({ id: "perm", method: "session/request_permission", params: { sessionId,
            toolCall: { title: "echo hello", extra: message.params.prompt[0].text === "oversized permission" ? "x".repeat(140_000) : "" }
          } });
          break;
        default:
          reply({ stopReason: "end_turn" });
          pending = undefined;
      }
      break;
    }
    case "session/cancel":
      send({ id: pending, result: { stopReason: "cancelled" } });
      pending = undefined;
      break;
    default:
      if (message.id === "perm" && message.result?.outcome?.outcome === "cancelled") {
        send({ id: pending, result: { stopReason: "end_turn" } });
        pending = undefined;
      }
  }
});
