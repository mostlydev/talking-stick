import { TalkingStickService } from "../../src/index.js";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  roomId: string;
  agentId: string;
  startAt: number;
  nowIso?: string;
  includeEvents?: boolean;
  afterEventSeq?: number;
  autoClaim?: boolean;
  maxWaitMs?: number;
};

const delayMs = Math.max(0, input.startAt - Date.now());
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const nowIso = input.nowIso;
const service = new TalkingStickService({
  dbPath: input.dbPath,
  now: nowIso ? () => new Date(nowIso) : undefined,
  policy: {
    waitForTurnMaxWaitMs: 0
  }
});

try {
  const result = await service.waitForTurn({
    agent_id: input.agentId,
    room_id: input.roomId,
    max_wait_ms: input.maxWaitMs ?? 0,
    auto_claim: input.autoClaim,
    include_events: input.includeEvents,
    after_event_seq: input.afterEventSeq
  });

  process.stdout.write(
    JSON.stringify({
      status: result.status,
      reason: "reason" in result ? result.reason : undefined,
      events: result.events?.map((event) => ({
        event_type: event.event_type,
        to_agent_id: event.to_agent_id,
        body: event.payload?.body
      }))
    })
  );
} finally {
  service.close();
}
