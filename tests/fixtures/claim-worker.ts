import { TalkingStickService } from "../../src/index.js";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  roomId: string;
  agentId: string;
  startAt: number;
};

const delayMs = Math.max(0, input.startAt - Date.now());
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const service = new TalkingStickService({
  dbPath: input.dbPath,
  policy: {
    waitForTurnMaxWaitMs: 0
  }
});

try {
  const result = await service.waitForTurn({
    agent_id: input.agentId,
    room_id: input.roomId,
    max_wait_ms: 0
  });

  process.stdout.write(JSON.stringify({ status: result.status }));
} finally {
  service.close();
}
