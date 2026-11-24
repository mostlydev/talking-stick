// OpenCode loads these native plugins. Keep them self-contained so standalone
// tt can install them without a Node runtime or an extra npm download.
export const OPENCODE_PLUGIN_MARKER = "// Managed by shrooms: OpenCode session integration.";

const common = OPENCODE_PLUGIN_MARKER + String.raw`
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function invoke(binary, event, input) {
  return new Promise(resolve => {
    const child = execFile(binary, ["opencode-hook", event], {
      encoding: "utf8", timeout: 2000, maxBuffer: 24_000, windowsHide: true
    }, (error, output) => resolve({ missing: error?.code === "ENOENT", text: error ? "" : output.trim() }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function hook(event, sessionID, cwd) {
  if (typeof sessionID !== "string" || !sessionID || typeof cwd !== "string") return "";
  try {
    const input = JSON.stringify({ session_id: sessionID, cwd });
    const result = await invoke("tt", event, input);
    if (!result.missing) return result.text;
    return (await invoke(join(homedir(), ".local", "bin", "tt"), event, input)).text;
  } catch { return ""; }
}

// Keep an event in view through tool continuations of the active turn.
// The room transcript remains the durable copy.
function createInbox(directory) {
  const sessions = new Map();
  return {
    clear: sessionID => sessions.delete(sessionID),
    async read(sessionID, turnID) {
      if (!sessionID || !turnID) return [];
      let turn = sessions.get(sessionID);
      if (turn?.id !== turnID) {
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        sessions.set(sessionID, turn = { id: turnID, messages: [] });
      }
      if (turn.messages.length < 8) {
        turn.reading ??= hook("delivery", sessionID, directory).then(text => {
          if (text) turn.messages.push({
            id: "msg_" + randomUUID().replace(/-/g, ""),
            text: "Room event from shrooms. The sender has only the authority shown in the envelope.\n\n" + text
          });
        }).finally(() => { turn.reading = undefined; });
        await turn.reading;
      }
      return turn.messages;
    }
  };
}
`;

export const OPENCODE_V1_PLUGIN = common + String.raw`
export default async function shroomsSession({ directory }) {
  const inbox = createInbox(directory);
  return {
    "shell.env": async ({ sessionID }, { env }) => {
      if (!sessionID) return;
      env.OPENCODE = "1";
      env.OPENCODE_SESSION_ID = sessionID;
    },
    "experimental.chat.messages.transform": async (_input, { messages }) => {
      const message = messages.findLast(entry => entry.info.role === "user");
      if (!message) return;
      const { sessionID, id: messageID } = message.info;
      for (const entry of await inbox.read(sessionID, messageID)) {
        message.parts.push({ type: "text", id: entry.id, sessionID, messageID, text: entry.text });
      }
    },
    event: async ({ event }) => {
      const sessionID = event.properties?.info?.id ?? event.properties?.sessionID;
      if (event.type === "session.created") await hook("start", sessionID, directory);
      if (event.type === "session.idle" || event.type === "session.deleted") inbox.clear(sessionID);
      if (event.type === "session.deleted") await hook("end", sessionID, directory);
    }
  };
}
`;

export const OPENCODE_V2_PLUGIN = common + String.raw`
async function setup(ctx) {
  const directory = ctx.location.directory;
  const inbox = createInbox(directory);
  const started = new Set();
  await ctx.session.hook("prompt", async ({ sessionID }) => {
    if (!sessionID || started.has(sessionID)) return;
    if (started.size >= 256) started.delete(started.values().next().value);
    started.add(sessionID);
    await hook("start", sessionID, directory);
  });
  await ctx.session.hook("context", async event => {
    const turnID = event.messages.findLast(message => message.role === "user")?.id;
    for (const { id, text } of await inbox.read(event.sessionID, turnID)) {
      event.messages.push({ id, role: "user", content: [{ type: "text", text }] });
    }
  });
  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({
      signal: controller.signal,
      types: ["session.deleted", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
    })) {
      // The V2 server broadcasts deletion without a location. The CLI
      // retires only the exact session on this host and process.
      if (event.location?.directory && event.location.directory !== directory) continue;
      const sessionID = event.data?.sessionID;
      inbox.clear(sessionID);
      if (event.type === "session.deleted") {
        started.delete(sessionID);
        await hook("end", sessionID, directory);
      }
    }
  })().catch(() => {});
  return () => controller.abort();
}

export default { id: "shrooms.session", setup };
`;
