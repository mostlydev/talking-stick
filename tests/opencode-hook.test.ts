import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { runOpencodeHookCommand } from "../src/cli/opencode-hook.js";
import { deriveHarnessCliIdentity, type ProcessInspector } from "../src/index.js";
import { planSessionHooks, runAction } from "../src/install.js";
import { TalkingStickService } from "../src/service.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function profile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-opencode-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const inspector: ProcessInspector = {
  inspect: pid => pid === 123 ? { pid, ppid: 1, startTime: "opencode-start", command: "/bin/opencode serve --service" } : null
};

test("one OpenCode server derives distinct conversation identities", () => {
  const identity = (session: string) => deriveHarnessCliIdentity({
    env: { OPENCODE: "1", OPENCODE_SESSION_ID: session, OPENCODE_PID: "123" },
    parentPid: 123, inspector, hostId: "test", username: "local"
  });
  expect(identity("ses_one")?.process_metadata).toMatchObject({
    harness_name: "opencode", harness_session_id: "harness:ses_one", harness_pid: 123
  });
  expect(identity("ses_one")?.agent_id).not.toBe(identity("ses_two")?.agent_id);
});

test("OpenCode delivery and lifecycle match the exact session and server", async () => {
  const root = profile();
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const service = new TalkingStickService({ dataDir: path.join(root, "data"), hostId: "local",
    processLivenessChecker: () => "alive" });
  cleanup.push(() => service.close());
  const room = service.joinPath({ context_path: root, agent_id: "human:op" });
  for (const session of ["one", "two"]) {
    service.joinPath({ context_path: root, agent_id: `opencode:${session}`, process_metadata: {
      harness_name: "opencode", harness_session_id: `harness:${session}`, harness_host_id: "local",
      host_id: "local", harness_pid: 123, harness_process_started_at: "opencode-start"
    } });
  }
  const hook = async (event: string, session_id: string, parentPid = 123, cwd = root) => {
    let output = "";
    await runOpencodeHookCommand(event, { service, inspector, parentPid,
      stdin: JSON.stringify({ cwd, session_id }), stdout: text => { output += text; } });
    return output;
  };
  service.sendMessage({ room_id: room.room_id, agent_id: "human:op", to_agent_id: "opencode:two", body: "Second conversation only." });
  expect(await hook("delivery", "one")).toBe("");
  expect(await hook("delivery", "two", 999)).toBe("");
  const pinnedWorkspace = profile();
  expect(await hook("delivery", "two", 123, pinnedWorkspace)).toContain("Second conversation only.");
  expect(await hook("delivery", "two")).toBe("");
  await hook("end", "one");
  expect(service.db.prepare("SELECT agent_id FROM room_members ORDER BY agent_id").all()).toEqual([
    { agent_id: "human:op" }, { agent_id: "opencode:two" }
  ]);
});

test("OpenCode installer manages both native plugin generations and keeps unrelated files", async () => {
  const root = profile();
  const options = { homeDir: root, env: { XDG_CONFIG_HOME: path.join(root, "custom-config") },
    skipMissing: true, which: () => "/bin/opencode" };
  const plans = (operation: "install" | "uninstall") => planSessionHooks("opencode", operation, options);
  for (const action of plans("install")) {
    expect(action.kind).toBe("file-patch");
    expect((await runAction(action, options)).status).toBe("added");
    expect((await runAction(action, options)).status).toBe("already_present");
  }
  const custom = path.join(root, "custom-config/opencode/plugins/other.js");
  fs.writeFileSync(custom, "// user plugin");
  for (const action of plans("uninstall")) {
    expect((await runAction(action, options)).status).toBe("removed");
  }
  expect(fs.readFileSync(custom, "utf8")).toBe("// user plugin");
  const [foreign] = plans("install");
  if (foreign.kind !== "file-patch") throw new Error("Expected OpenCode plugin action");
  fs.writeFileSync(foreign.filePath, "// foreign plugin");
  expect((await runAction(foreign, options)).status).toBe("failed");
  expect(fs.readFileSync(foreign.filePath, "utf8")).toBe("// foreign plugin");
});
