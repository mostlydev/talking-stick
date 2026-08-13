import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";
import { runClaudeStopHookCommand } from "../src/cli/claude-stop-hook.js";

const roots: string[] = [];
const services: TalkingStickService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const SESSION_ID = "stop-hook-session";

async function setupOwnedRoom() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-stop-hook-"));
  roots.push(tempRoot);
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const canonicalProject = fs.realpathSync.native(project);

  const service = new TalkingStickService({
    dbPath: path.join(tempRoot, "state", "rooms.sqlite"),
    processLivenessChecker: () => "alive",
    receiverLivenessChecker: () => "alive"
  });
  services.push(service);

  const joined = service.joinPath({
    agent_id: "claude:hooked",
    context_path: canonicalProject,
    process_metadata: { harness_session_id: `harness:${SESSION_ID}` }
  });
  const claim = await service.waitForTurn({
    room_id: joined.room_id,
    agent_id: "claude:hooked",
    max_wait_ms: 0,
    process_metadata: { harness_session_id: `harness:${SESSION_ID}` }
  });
  expect(claim.status).toBe("your_turn");
  return { service, project: canonicalProject, joined };
}

interface HookRun {
  exitCode: number | null;
  stderr: string;
}

async function runHook(
  service: TalkingStickService,
  payload: unknown,
  cwd: string
): Promise<HookRun> {
  let exitCode: number | null = null;
  let stderr = "";
  await runClaudeStopHookCommand({
    stdin: typeof payload === "string" ? payload : JSON.stringify(payload),
    cwd,
    service,
    stderr: (text) => {
      stderr += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    }
  });
  return { exitCode, stderr };
}

describe("claude stop hook command", () => {
  test("blocks with exit 2 when the exact session owns the stick", async () => {
    const { service, project } = await setupOwnedRoom();
    const run = await runHook(
      service,
      { session_id: SESSION_ID, cwd: project, stop_hook_active: false },
      project
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("claude:hooked");
    expect(run.stderr).toContain("tt release");
  });

  test("stop_hook_active always exits 0 to avoid block loops", async () => {
    const { service, project } = await setupOwnedRoom();
    const run = await runHook(
      service,
      { session_id: SESSION_ID, cwd: project, stop_hook_active: true },
      project
    );
    expect(run.exitCode).toBeNull();
    expect(run.stderr).toBe("");
  });

  test("other sessions, missing session ids, and rooms without grants pass", async () => {
    const { service, project, joined } = await setupOwnedRoom();

    const otherSession = await runHook(
      service,
      { session_id: "different-session", cwd: project },
      project
    );
    expect(otherSession.exitCode).toBeNull();

    const missingSession = await runHook(service, { cwd: project }, project);
    expect(missingSession.exitCode).toBeNull();

    service.releaseStick({
      room_id: joined.room_id,
      agent_id: "claude:hooked",
      lease_id: service.getRoomState({ room_id: joined.room_id }).room
        .lease_id as string,
      expected_turn_id: 1,
      handoff: { status: "done", next_action: "none" },
      process_metadata: { harness_session_id: `harness:${SESSION_ID}` }
    });
    const released = await runHook(
      service,
      { session_id: SESSION_ID, cwd: project },
      project
    );
    expect(released.exitCode).toBeNull();
  });

  test("malformed payloads and unavailable state fail open", async () => {
    const { service, project } = await setupOwnedRoom();

    const garbage = await runHook(service, "{ not json", project);
    expect(garbage.exitCode).toBeNull();

    const empty = await runHook(service, "", project);
    expect(empty.exitCode).toBeNull();

    const throwing = {
      inspectStopGuard() {
        throw new Error("db unavailable");
      }
    } as unknown as TalkingStickService;
    let exitCode: number | null = null;
    await runClaudeStopHookCommand({
      stdin: JSON.stringify({ session_id: SESSION_ID, cwd: project }),
      cwd: project,
      service: throwing,
      stderr: () => {},
      setExitCode: (code) => {
        exitCode = code;
      }
    });
    expect(exitCode).toBeNull();
  });
});
