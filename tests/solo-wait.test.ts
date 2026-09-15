import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/service.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-solo-"));
  const service = new TalkingStickService({
    dbPath: path.join(root, "state.sqlite")
  });
  cleanups.push(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const joined = service.joinPath({
    agent_id: "claude:solo",
    context_path: root
  });
  const input = {
    agent_id: "claude:solo",
    room_id: joined.room_id,
    max_wait_ms: 0,
    allow_solo_claim: false,
    include_events: true,
    after_event_seq: 0
  };
  return { root, service, input };
}

test("solo listening never acquires a lease, explicit claim does, release does not reclaim or replay self events", async () => {
  const { service, input } = setup();
  expect(await service.waitForTurn(input)).toMatchObject({
    status: "not_yet",
    reason: "solo_room",
    events: []
  });
  const turn = await service.waitForTurn({ ...input, allow_solo_claim: true });
  expect(turn.status).toBe("your_turn");
  if (turn.status !== "your_turn") throw new Error("Expected ownership");
  service.releaseStick({
    agent_id: input.agent_id,
    room_id: input.room_id,
    lease_id: turn.lease_id,
    expected_turn_id: turn.turn_id,
    handoff: { status: "Done", next_action: "Discuss follow-up" }
  });
  expect(await service.waitForTurn(input)).toMatchObject({
    status: "not_yet",
    reason: "solo_room",
    events: []
  });
  expect(
    service
      .getRoomEvents({ room_id: input.room_id, include_all: true })
      .some((event) => event.event_type === "claim")
  ).toBe(true);
});

test("a peer joining allows normal claims and incoming messages survive self-event filtering", async () => {
  const { root, service, input } = setup();
  service.joinPath({ agent_id: "codex:peer", context_path: root });
  service.sendMessage({
    agent_id: "codex:peer",
    room_id: input.room_id,
    body: "Ready",
    to_agent_id: input.agent_id
  });
  const result = await service.waitForTurn(input);
  expect(result.status).toBe("your_turn");
  expect(result.events?.some((event) => event.payload?.body === "Ready")).toBe(
    true
  );
});
