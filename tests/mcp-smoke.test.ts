import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createMcpServer,
  type Handoff,
  TalkingStickService
} from "../src/index.js";

const tempRoots: string[] = [];
const openServices: TalkingStickService[] = [];
const openClients: Client[] = [];
const openServers: Array<ReturnType<typeof createMcpServer>> = [];

afterEach(async () => {
  while (openClients.length > 0) {
    await openClients.pop()?.close();
  }

  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }

  while (openServices.length > 0) {
    openServices.pop()?.close();
  }

  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("mcp smoke coverage", () => {
  test("registers the MVP talking-stick tools", async () => {
    const harness = await createMcpHarness();

    const tools = await harness.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_rooms",
      "join_path",
      "wait_for_turn",
      "heartbeat",
      "release_stick",
      "pass_stick",
      "takeover_stick",
      "get_room_state",
      "get_room_events",
      "add_note",
      "list_notes"
    ]);
  });

  test("handoff line ranges use a provider-friendly array schema", async () => {
    const harness = await createMcpHarness();

    const tools = await harness.client.listTools();
    const releaseStick = tools.tools.find((tool) => tool.name === "release_stick");
    expect(releaseStick).toBeDefined();

    const linesSchema = (
      releaseStick as {
        inputSchema: {
          properties?: {
            handoff?: {
              properties?: {
                artifacts?: {
                  items?: {
                    properties?: {
                      lines?: Record<string, unknown>;
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).inputSchema.properties?.handoff?.properties?.artifacts?.items?.properties?.lines;

    expect(linesSchema).toMatchObject({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "integer"
      }
    });
    expect(Array.isArray(linesSchema?.items)).toBe(false);
  });

  test("wait_for_turn schema stays cursor-free", async () => {
    const harness = await createMcpHarness();

    const tools = await harness.client.listTools();
    const waitForTurn = tools.tools.find((tool) => tool.name === "wait_for_turn");
    expect(waitForTurn).toBeDefined();

    const properties = (
      waitForTurn as {
        inputSchema: {
          properties?: Record<string, unknown>;
        };
      }
    ).inputSchema.properties;

    expect(properties).toMatchObject({
      room_id: expect.any(Object),
      max_wait_ms: expect.any(Object)
    });
    expect(properties).not.toHaveProperty("cursor");
  });

  test("two MCP clients can hand off through join_path, wait_for_turn, and release_stick", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mcp-"));
    tempRoots.push(tempRoot);

    const dbPath = path.join(tempRoot, "state", "rooms.sqlite");
    const project = createProject(tempRoot);

    const codex = await createMcpHarness(dbPath);
    const claude = await createMcpHarness(dbPath);

    const codexJoin = parseToolResult(
      await codex.client.callTool({
        name: "join_path",
        arguments: {
          context_path: project,
          agent_id_override: "codex:test"
        }
      })
    );
    const claudeJoin = parseToolResult(
      await claude.client.callTool({
        name: "join_path",
        arguments: {
          context_path: project,
          agent_id_override: "claude:test"
        }
      })
    );

    expect(claudeJoin.room_id).toBe(codexJoin.room_id);
    expect(codexJoin.agent_id).toBe("codex:test");
    expect(claudeJoin.agent_id).toBe("claude:test");

    const codexTurn = parseToolResult(
      await codex.client.callTool({
        name: "wait_for_turn",
        arguments: {
          room_id: codexJoin.room_id,
          max_wait_ms: 0
        }
      })
    );

    expect(codexTurn.status).toBe("your_turn");

    const handoff: Handoff = {
      status: "Implemented the adapter slice.",
      next_action: "Claim the reserved turn and verify the handoff."
    };

    const release = parseToolResult(
      await codex.client.callTool({
        name: "release_stick",
        arguments: {
          room_id: codexJoin.room_id,
          lease_id: codexTurn.lease_id,
          expected_turn_id: codexTurn.turn_id,
          handoff
        }
      })
    );

    expect(release.status).toBe("released");
    expect(release.reserved_for).toBe("claude:test");

    const claudeTurn = parseToolResult(
      await claude.client.callTool({
        name: "wait_for_turn",
        arguments: {
          room_id: claudeJoin.room_id,
          max_wait_ms: 0
        }
      })
    );

    expect(claudeTurn).toMatchObject({
      status: "your_turn",
      from_agent_id: "codex:test",
      reason: "sequence",
      handoff
    });
  });

  test("add_note and list_notes round-trip through the MCP adapter", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mcp-"));
    tempRoots.push(tempRoot);

    const dbPath = path.join(tempRoot, "state", "rooms.sqlite");
    const project = createProject(tempRoot);

    const codex = await createMcpHarness(dbPath);
    const claude = await createMcpHarness(dbPath);

    await codex.client.callTool({
      name: "join_path",
      arguments: {
        context_path: project,
        agent_id_override: "codex:test"
      }
    });
    const claudeJoin = parseToolResult(
      await claude.client.callTool({
        name: "join_path",
        arguments: {
          context_path: project,
          agent_id_override: "claude:test"
        }
      })
    );

    const added = parseToolResult(
      await claude.client.callTool({
        name: "add_note",
        arguments: {
          room_id: claudeJoin.room_id,
          body: "Heads up: service.ts:1400 invariant."
        }
      })
    );

    expect(added.author_agent_id).toBe("claude:test");
    expect(added.turn_id).toBeNull();

    const listed = parseToolResult(
      await codex.client.callTool({
        name: "list_notes",
        arguments: {
          room_id: claudeJoin.room_id
        }
      })
    );

    expect(listed.notes).toHaveLength(1);
    expect(listed.notes[0]).toMatchObject({
      note_id: added.note_id,
      author_agent_id: "claude:test",
      body: "Heads up: service.ts:1400 invariant.",
      turn_id: null
    });
  });
});

async function createMcpHarness(existingDbPath?: string) {
  const tempRoot =
    existingDbPath === undefined
      ? fs.mkdtempSync(path.join(os.tmpdir(), "talking-stick-mcp-"))
      : null;
  if (tempRoot) {
    tempRoots.push(tempRoot);
  }

  const dbPath =
    existingDbPath ?? path.join(tempRoot as string, "state", "rooms.sqlite");
  const service = new TalkingStickService({ dbPath });
  openServices.push(service);

  const server = createMcpServer(service);
  openServers.push(server);

  const client = new Client({
    name: "mcp-smoke-client",
    version: "1.0.0"
  });
  openClients.push(client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { service, server, client, dbPath };
}

function createProject(tempRoot: string): string {
  const project = path.join(tempRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  return fs.realpathSync.native(project);
}

function parseToolResult(result: unknown): any {
  const toolResult = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };

  if (toolResult.isError) {
    throw new Error(
      toolResult.content?.[0]?.text ?? "Unexpected MCP tool error."
    );
  }

  const text = toolResult.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Expected MCP tool result to include JSON text content.");
  }

  return JSON.parse(text);
}
