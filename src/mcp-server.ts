import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isProtocolError } from "./errors.js";
import { deriveMcpHarnessIdentity, type DerivedIdentity } from "./identity.js";
import {
  createSystemProcessInspector,
  type ProcessInspector
} from "./process-utils.js";
import { TalkingStickCommands } from "./commands.js";
import { TalkingStickService } from "./service.js";

const handoffSchema = z
  .object({
    status: z.string(),
    next_action: z.string(),
    artifacts: z
      .array(
        z.object({
          path: z.string(),
          lines: z.array(z.number().int()).length(2).optional(),
          role: z.enum(["examine", "review", "edit", "context", "output"]),
          note: z.string().optional()
        })
      )
      .optional(),
    open_questions: z.array(z.string()).optional(),
    do_not: z.array(z.string()).optional()
  })
  .passthrough();

export function createMcpServer(
  service = new TalkingStickService()
): McpServer {
  const commands = new TalkingStickCommands(service);
  const resolveConnectionIdentity = createConnectionIdentityResolver();
  const server = new McpServer({
    name: "talking-stick",
    version: "0.1.0-alpha"
  });

  server.registerTool(
    "list_rooms",
    {
      title: "List Rooms",
      description: "List talking-stick rooms, optionally scoped to a path.",
      inputSchema: {
        context_path: z.string().optional()
      }
    },
    async (input) => toolJson(() => service.listRooms(input))
  );

  server.registerTool(
    "join_path",
    {
      title: "Join Path",
      description: "Join the room resolved from an invocation context path.",
      inputSchema: {
        context_path: z.string().min(1),
        force_new: z.boolean().optional(),
        agent_id_override: z.string().min(1).optional()
      }
    },
    async (input, extra) =>
      toolJson(() =>
        commands.joinPath(
          resolveConnectionIdentity(extra.sessionId, input.agent_id_override),
          {
            context_path: input.context_path,
            force_new: input.force_new
          }
        )
      )
  );

  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait For Turn",
      description:
        "Poll until the caller can claim the stick or takeover is available.",
      inputSchema: {
        room_id: z.string().min(1),
        cursor: z.string().optional(),
        max_wait_ms: z.number().int().nonnegative().optional()
      }
    },
    async (input, extra) =>
      toolJson(() =>
        commands.waitForTurn(
          resolveConnectionIdentity(extra.sessionId),
          input
        )
      )
  );

  server.registerTool(
    "heartbeat",
    {
      title: "Heartbeat",
      description: "Renew the current owner's lease.",
      inputSchema: ownerMutationSchema()
    },
    async (input, extra) =>
      toolJson(() =>
        commands.heartbeat(
          resolveConnectionIdentity(extra.sessionId),
          input
        )
      )
  );

  server.registerTool(
    "release_stick",
    {
      title: "Release Stick",
      description: "Release the stick to the next active member in sequence.",
      inputSchema: {
        ...ownerMutationSchema(),
        handoff: handoffSchema
      }
    },
    async (input, extra) =>
      toolJson(() =>
        commands.releaseStick(
          resolveConnectionIdentity(extra.sessionId),
          input
        )
      )
  );

  server.registerTool(
    "pass_stick",
    {
      title: "Pass Stick",
      description: "Pass the stick to a specific active member.",
      inputSchema: {
        ...ownerMutationSchema(),
        to_agent_id: z.string().min(1),
        handoff: handoffSchema
      }
    },
    async (input, extra) =>
      toolJson(() =>
        commands.passStick(
          resolveConnectionIdentity(extra.sessionId),
          input
        )
      )
  );

  server.registerTool(
    "takeover_stick",
    {
      title: "Takeover Stick",
      description:
        "Explicitly take over after claim timeout or owner lease timeout.",
      inputSchema: {
        room_id: z.string().min(1),
        expected_turn_id: z.number().int().nonnegative(),
        reason: z.string().min(1)
      }
    },
    async (input, extra) =>
      toolJson(() =>
        commands.takeoverStick(
          resolveConnectionIdentity(extra.sessionId),
          input
        )
      )
  );

  server.registerTool(
    "get_room_state",
    {
      title: "Get Room State",
      description: "Read the current projected room state and membership.",
      inputSchema: {
        room_id: z.string().min(1)
      }
    },
    async (input) => toolJson(() => service.getRoomState(input))
  );

  server.registerTool(
    "get_room_events",
    {
      title: "Get Room Events",
      description: "Read the append-only event log for a room.",
      inputSchema: {
        room_id: z.string().min(1),
        after_event_seq: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional()
      }
    },
    async (input) => toolJson(() => service.getRoomEvents(input))
  );

  return server;
}

export function createConnectionIdentityResolver(options: {
  inspector?: ProcessInspector;
} = {}): (sessionId: string | undefined, override?: string) => DerivedIdentity {
  const inspector =
    options.inspector ?? createSystemProcessInspector({ cacheTtlMs: 60_000 });
  const connectionOverrides = new Map<string, string>();
  const connectionIdentities = new Map<string, DerivedIdentity>();

  return (sessionId, override) => {
    const key = sessionId ?? "__stdio__";
    if (override) {
      connectionOverrides.set(key, override);
      connectionIdentities.delete(key);
    }

    const cached = connectionIdentities.get(key);
    if (cached) {
      return cached;
    }

    const identity = deriveMcpHarnessIdentity({
      sessionId,
      agentId: connectionOverrides.get(key),
      inspector
    });
    connectionIdentities.set(key, identity);
    return identity;
  };
}

export async function runStdioServer(): Promise<void> {
  const service = new TalkingStickService();
  const server = createMcpServer(service);

  process.on("exit", () => service.close());
  await server.connect(new StdioServerTransport());
}

function ownerMutationSchema() {
  return {
    room_id: z.string().min(1),
    lease_id: z.string().min(1),
    expected_turn_id: z.number().int().nonnegative()
  };
}

async function toolJson(fn: () => unknown | Promise<unknown>) {
  try {
    const result = await fn();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    if (isProtocolError(error)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(error.toJSON(), null, 2)
          }
        ]
      };
    }

    throw error;
  }
}
