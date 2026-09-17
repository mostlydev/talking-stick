import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { TalkingStickCommands } from "../src/commands.js";
import { deriveHumanCliIdentity } from "../src/identity.js";
import { TalkingStickService, type TalkingStickServiceOptions, type ProcessLiveness } from "../src/service.js";
import type { ProcessMetadata, RoomEvent } from "../src/types.js";
import {
  agentColor,
  chatDayLabel,
  formatChatTime,
  startsChatConversation,
  buildNameResolver,
  formatChatStatus,
  formatDuration,
  formatChatEvent,
  parseChatInput,
  resolveChatRecipient,
  resolveChatRecipients,
  sanitizeChatText
} from "../src/cli/chat-format.js";
import { chatInlineEnabled, chatTerminalCapable, createChatIdentity, runChatSession } from "../src/cli/chat.js";
import { parseCommand } from "../src/cli/parser.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("chat input parsing", () => {
  test("plain text broadcasts and @name directs", () => {
    expect(parseChatInput("hello all")).toEqual({
      kind: "send",
      to: [],
      body: "hello all",
      interrupt: false
    });
    expect(parseChatInput("@codex please rebase")).toEqual({
      kind: "send",
      to: ["codex"],
      body: "please rebase",
      interrupt: false
    });
    expect(parseChatInput("@codex, hello")).toMatchObject({
      to: ["codex"],
      body: "hello"
    });
    expect(parseChatInput("/to claude:1234 look")).toMatchObject({
      kind: "send",
      to: ["claude:1234"],
      body: "look"
    });
  });

  test("mentions anywhere in the message add recipients", () => {
    expect(parseChatInput("@claude @codex, review this")).toEqual({
      kind: "send",
      to: ["claude", "codex"],
      body: "review this",
      interrupt: false
    });
    expect(parseChatInput("hey @codex and @Claude: can you check this?")).toEqual({
      kind: "send",
      to: ["codex", "claude"],
      body: "hey @codex and @Claude: can you check this?",
      interrupt: false
    });
    expect(parseChatInput("(@codex) ping @codex again")).toMatchObject({ to: ["codex"] });
    expect(parseChatInput("mail ops@example.com about it")).toMatchObject({ to: [], body: "mail ops@example.com about it" });
    expect(parseChatInput("run `git log @codex` please")).toMatchObject({ to: [] });
    expect(parseChatInput("/to @claude also @codex look")).toMatchObject({ to: ["claude", "codex"], body: "also @codex look" });
    expect(parseChatInput("@claude@codex hello")).toMatchObject({ kind: "error" });
    expect(parseChatInput("meet @ 5pm")).toMatchObject({ to: [], body: "meet @ 5pm", interrupt: false });
  });

  test("!@ marks an interrupt, for named agents or on its own", () => {
    expect(parseChatInput("!@codex stop now")).toEqual({
      kind: "send",
      to: ["codex"],
      body: "stop now",
      interrupt: true
    });
    expect(parseChatInput("!@codex !@claude, stop")).toMatchObject({ to: ["codex", "claude"], body: "stop", interrupt: true });
    expect(parseChatInput("!@codex @claude stop")).toMatchObject({ to: ["codex", "claude"], interrupt: true });
    expect(parseChatInput("!@everyone stop")).toEqual({
      kind: "send",
      to: ["everyone"],
      body: "stop",
      interrupt: true
    });
    expect(parseChatInput("!@ stop")).toMatchObject({ to: [], body: "stop", interrupt: true });
    expect(parseChatInput("please stop !@codex")).toMatchObject({ to: ["codex"], interrupt: true });
    expect(parseChatInput("!@")).toMatchObject({ kind: "error" });
    expect(parseChatInput("wow!@codex")).toMatchObject({ to: [], interrupt: false });
    expect(parseChatInput("!important")).toMatchObject({ to: [], body: "!important", interrupt: false });
    expect(parseChatInput("!@claude!@codex hi")).toMatchObject({ kind: "error" });
  });

  test("interrupts, commands, escapes, and errors", () => {
    expect(parseChatInput("/interrupt @codex stop now")).toEqual({
      kind: "send",
      to: ["codex"],
      body: "stop now",
      interrupt: true
    });
    expect(parseChatInput("/interrupt @codex @claude stop")).toMatchObject({ to: ["codex", "claude"], interrupt: true });
    expect(parseChatInput("/interrupt stop everyone")).toMatchObject({
      to: [],
      interrupt: true
    });
    expect(parseChatInput("/WHO")).toEqual({
      kind: "command",
      name: "who",
      args: ""
    });
    expect(parseChatInput("//etc/hosts is fine")).toMatchObject({
      kind: "send",
      body: "/etc/hosts is fine"
    });
    expect(parseChatInput("   ")).toEqual({ kind: "empty" });
    expect(parseChatInput("@codex")).toMatchObject({ kind: "error" });
    expect(parseChatInput("@codex @claude")).toMatchObject({ kind: "error" });
    expect(parseChatInput("@, hello")).toMatchObject({ kind: "error" });
    expect(parseChatInput("/to")).toMatchObject({ kind: "error" });
  });
});

describe("chat rendering", () => {
  test("strips terminal escape and control sequences from untrusted text", () => {
    expect(
      sanitizeChatText("ok\u001b[2J\u001b]0;pwned\u0007 done\u0008\r\nnext")
    ).toBe("ok done\nnext");
  });

  test("uses short harness names unless two sessions share a harness", () => {
    const unique = buildNameResolver(
      ["codex:aa", "claude:bb", "human:op"],
      "human:op"
    );
    expect(unique("codex:aa")).toBe("codex");
    expect(unique("human:op")).toBe("you");

    const shared = buildNameResolver(["claude:aa", "claude:bb"], "human:op");
    expect(shared("claude:aa")).toBe("claude:aa");
  });

  test("formats messages, directed messages, and stick events as readable lines", () => {
    const context = {
      self_agent_id: "human:op",
      name_of: buildNameResolver(
        ["codex:aa", "claude:bb", "human:op"],
        "human:op"
      ),
      color: false,
      show_turn_events: true
    };

    const created_at = new Date(2026, 8, 14, 9, 5).toISOString();
    expect(
      formatChatEvent(
        event({
          event_type: "message_sent",
          from_agent_id: "codex:aa",
          created_at,
          payload: { body: "hi\nthere", delivery_hint: "normal" }
        }),
        context
      )
    ).toBe("codex  09:05\n  hi\n  there");
    expect(
      formatChatEvent(
        event({
          event_type: "message_sent",
          from_agent_id: "claude:bb",
          to_agent_id: "human:op",
          created_at,
          payload: { body: "done?", delivery_hint: "interrupt" }
        }),
        context
      )
    ).toBe("claude → you ‼ interrupt  09:05\n  done?");
    expect(
      formatChatEvent(
        event({
          event_type: "release",
          from_agent_id: "codex:aa",
          created_at,
          handoff: { status: "Tests pass\nmore", next_action: "review" }
        }),
        context
      )
    ).toBe("· codex released the stick: Tests pass  09:05");
    expect(
      formatChatEvent(
        event({
          event_type: "claim",
          to_agent_id: "claude:bb",
          turn_id: 3,
          created_at
        }),
        { ...context, show_turn_events: false }
      )
    ).toBeNull();
  });

  test("dates older activity and dims the entire historical message", () => {
    const now = new Date(2026, 8, 15, 10, 0);
    const yesterday = new Date(2026, 8, 14, 9, 5).toISOString();
    const context = { self_agent_id: "human:op", name_of: () => "codex", color: true, show_turn_events: false, now };
    const text = formatChatEvent(event({ event_type: "message_sent", from_agent_id: "codex:aa", created_at: yesterday,
      payload: { body: "old message", delivery_hint: "normal" } }), context)!;
    expect(text).toBe("\u001b[2;90mcodex  Yesterday at 09:05\u001b[0m\n\u001b[2;90m  old message\u001b[0m");
    expect(chatDayLabel(new Date(2026, 8, 13).toISOString(), now)).toBe("2026-09-13");
    expect(formatChatTime(now.toISOString(), now)).toBe("10:00");
    expect(formatChatTime("invalid", now)).toBe("--:--");
    expect(formatChatEvent(event({ event_type: "claim", created_at: yesterday }), context)).toBeNull();
  });

  test("a join after four quiet hours separates conversations without declaring agents dead", () => {
    const before = event({ created_at: "2026-09-15T08:00:00Z" });
    expect(startsChatConversation(before, event({ event_type: "join", created_at: "2026-09-15T12:00:00Z" }))).toBe(true);
    expect(startsChatConversation(before, event({ event_type: "join", created_at: "2026-09-15T11:59:59Z" }))).toBe(false);
    expect(startsChatConversation(before, event({ event_type: "message_sent", created_at: "2026-09-15T12:00:00Z" }))).toBe(false);
  });

  test("colors each member by harness so names stay recognizable", () => {
    expect(agentColor("claude:aa")).toBe(agentColor("claude:bb"));
    expect(agentColor("codex:aa")).not.toBe(agentColor("claude:aa"));
    expect(agentColor("human:op:chat:1234")).toBe(agentColor("human:other"));

    const line = formatChatEvent(
      event({
        event_type: "message_sent",
        from_agent_id: "codex:aa",
        payload: { body: "hi", delivery_hint: "normal" }
      }),
      {
        self_agent_id: "human:op",
        name_of: buildNameResolver(["codex:aa"], "human:op"),
        color: true,
        show_turn_events: false
      }
    );
    expect(line).toContain(
      `\u001b[1;38;5;${agentColor("codex:aa")}mcodex\u001b[0m`
    );
  });

  test("resolves prefixes to all matching recipients", () => {
    const members = [
      { agent_id: "codex:aa", display_name: "codex" },
      { agent_id: "claude:bb", display_name: "claude" },
      { agent_id: "claude:cc", display_name: "claude" }
    ] as never;
    expect(resolveChatRecipient("codex", members, "human:op")).toEqual({
      agent_ids: ["codex:aa"]
    });
    expect(resolveChatRecipient("claude:c", members, "human:op")).toEqual({
      agent_ids: ["claude:cc"]
    });
    expect(resolveChatRecipient("CLAUDE", members, "human:op")).toEqual({
      agent_ids: ["claude:bb", "claude:cc"]
    });
    expect(resolveChatRecipient("gemini", members, "human:op")).toHaveProperty(
      "error"
    );
    expect(resolveChatRecipients(["codex", "claude", "claude:c"], members, "human:op")).toEqual({
      agent_ids: ["codex:aa", "claude:bb", "claude:cc"]
    });
    const liveness = [
      { agent_id: "codex:aa", status: "active", session_kind: "harness_cli" },
      { agent_id: "claude:bb", status: "inactive", process_liveness: "alive", session_kind: "harness_cli" },
      { agent_id: "claude:ee", status: "inactive", process_liveness: "gone", session_kind: "harness_cli" },
      { agent_id: "grok:ff", status: "active", process_liveness: "gone", session_kind: "harness_cli" }
    ] as never;
    expect(resolveChatRecipients(["everyone"], liveness, "human:op")).toEqual({ agent_ids: ["codex:aa", "claude:bb"] });
    expect(resolveChatRecipients(["claude"], liveness, "human:op")).toEqual({ agent_ids: ["claude:bb"] });
    expect(resolveChatRecipients(["codex", "grok"], liveness, "human:op")).toMatchObject({
      error: "No room member matches '@grok'. 'grok' only matches agents that have ended: grok:ff.", unmatched: ["grok"]
    });
    expect(resolveChatRecipient("grok", liveness, "human:op")).toEqual({
      error: "'grok' only matches agents that have ended: grok:ff."
    });
    expect(resolveChatRecipients(["everyone"], [
      { agent_id: "codex:aa", status: "active", session_kind: "harness_cli" },
      { agent_id: "claude:bb", status: "active", session_kind: "harness_cli" },
      { agent_id: "gemini:dd", status: "inactive", session_kind: "harness_cli" },
      { agent_id: "human:op:chat:2", status: "active", session_kind: "human_chat" },
      { agent_id: "human:op", status: "active", session_kind: "human_chat" }
    ] as never, "human:op")).toEqual({ agent_ids: ["codex:aa", "claude:bb"] });
    expect(resolveChatRecipients(["codex", "gemini", "grok"], members, "human:op")).toEqual({
      error: "No room member matches '@gemini', '@grok'.",
      unmatched: ["gemini", "grok"]
    });
  });
});

describe("chat status line", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  const member = (overrides: Record<string, unknown>) =>
    ({
      agent_id: "codex:aa",
      session_kind: "harness_cli",
      status: "active",
      last_seen_at: minutesAgo(0),
      standby_transport: null,
      ...overrides
    }) as never;
  const context = (ids: string[]) => ({
    self_agent_id: "human:op:chat:1",
    name_of: buildNameResolver(ids, "human:op:chat:1"),
    color: false,
    show_turn_events: false
  });

  test("summarizes agents with holder first and hides observers", () => {
    const members = [
      member({ agent_id: "gemini:cc", last_seen_at: minutesAgo(90) }),
      member({ agent_id: "claude:bb", last_seen_at: minutesAgo(4) }),
      member({ agent_id: "codex:aa" }),
      member({ agent_id: "grok:dd", status: "inactive" }),
      member({ agent_id: "opencode:ee", standby_transport: "cmux" }),
      member({ agent_id: "human:op:chat:1", session_kind: "human_chat" })
    ];
    const ids = members.map((row: { agent_id: string }) => row.agent_id);

    expect(
      formatChatStatus(
        {
          members,
          owner: "codex:aa",
          owner_since: minutesAgo(12),
          reserved_for: "claude:bb",
          now,
          columns: 200
        },
        context(ids)
      )
    ).toBe(
      "codex holding 12m · claude up next · gemini idle 1h · opencode standby · grok away"
    );
  });

  test("ended agents leave the footer; live silent agents read as idle", () => {
    const members = [
      member({ agent_id: "codex:aa", status: "inactive", process_liveness: "alive", last_seen_at: minutesAgo(180) }),
      member({ agent_id: "claude:bb", status: "inactive", process_liveness: "gone", last_seen_at: minutesAgo(30) }),
      member({ agent_id: "gemini:cc", status: "inactive", process_liveness: "unknown", last_seen_at: minutesAgo(30) }),
      member({ agent_id: "grok:dd", status: "inactive", process_liveness: "unknown", standby_transport: "manual" })
    ];
    const ids = members.map((row: { agent_id: string }) => row.agent_id);
    expect(
      formatChatStatus(
        { members, owner: null, owner_since: null, reserved_for: null, now, columns: 200 },
        context(ids)
      )
    ).toBe("codex idle 3h · gemini away · grok standby");
  });

  test("fits the terminal width and counts what it had to drop", () => {
    const members = ["codex:aa", "claude:bb", "gemini:cc"].map((agent_id) =>
      member({ agent_id })
    );
    const line = formatChatStatus(
      {
        members,
        owner: null,
        owner_since: null,
        reserved_for: null,
        now,
        columns: 36
      },
      context(members.map((row: { agent_id: string }) => row.agent_id))
    );
    expect(line).toBe("codex active · claude active · +1");
    expect(line.length).toBeLessThan(36);
  });

  test("bounds tiny terminals and wide or multiline names", () => {
    const members = [member({ agent_id: "custom:a" })];
    for (let columns = 1; columns < 50; columns++) {
      const line = formatChatStatus(
        {
          members,
          owner: null,
          owner_since: null,
          reserved_for: null,
          now,
          columns
        },
        { ...context([]), name_of: () => "界界界\n界界界" }
      );
      expect(line).not.toContain("\n");
      const cells = Array.from(line).reduce(
        (sum, char) => sum + (char === "界" ? 2 : 1),
        0
      );
      expect(cells).toBeLessThan(columns);
    }
  });

  test("formats compact durations", () => {
    expect(formatDuration(now, minutesAgo(0.5))).toBe("30s");
    expect(formatDuration(now, minutesAgo(59))).toBe("59m");
    expect(formatDuration(now, minutesAgo(60 * 47))).toBe("47h");
    expect(formatDuration(now, minutesAgo(60 * 72))).toBe("3d");
  });
});

describe("human_chat observer membership", () => {
  test("an observer retains the room without participating in turn scheduling", async () => {
    const { root, service } = setupService();
    const joined = service.joinPath({
      agent_id: "claude:solo",
      context_path: root
    });
    service.joinPath({
      agent_id: "human:op",
      context_path: root,
      process_metadata: observerIdentity().process_metadata
    });

    expect(
      service
        .getRoomEvents({ room_id: joined.room_id })
        .map((row) => row.event_type)
    ).not.toContain("join");

    expect(
      await service.waitForTurn({
        agent_id: "claude:solo",
        room_id: joined.room_id,
        max_wait_ms: 0,
        allow_solo_claim: false
      })
    ).toMatchObject({ status: "not_yet", reason: "solo_room" });

    const turn = await service.waitForTurn({
      agent_id: "claude:solo",
      room_id: joined.room_id,
      max_wait_ms: 0,
      allow_solo_claim: true
    });
    if (turn.status !== "your_turn") throw new Error("expected ownership");
    expect(() =>
      service.passStick({
        agent_id: "claude:solo",
        room_id: joined.room_id,
        lease_id: turn.lease_id,
        expected_turn_id: turn.turn_id,
        to_agent_id: "human:op",
        operator_override: true,
        handoff: { status: "s", next_action: "n" }
      })
    ).toThrow(/turn-taking/);

    service.releaseStick({
      agent_id: "claude:solo",
      room_id: joined.room_id,
      lease_id: turn.lease_id,
      expected_turn_id: turn.turn_id,
      handoff: { status: "s", next_action: "n" }
    });
    expect(
      service.leaveRoom({ agent_id: "claude:solo", room_id: joined.room_id })
    ).toMatchObject({
      status: "left",
      remaining_members: 1
    });
  });

  test("a live console keeps the room after the last agent leaves or is kicked", () => {
    const { root, service } = setupService({ observerLiveness: "alive" });
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.joinPath({ agent_id: "claude:bb", context_path: root });
    service.joinPath({
      agent_id: "human:op:chat:1",
      context_path: root,
      process_metadata: observerIdentity().process_metadata
    });

    service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id });
    expect(
      service.kickMember({
        agent_id: "human:op:chat:1",
        room_id: joined.room_id,
        target_agent_id: "claude:bb",
        force: true
      })
    ).toMatchObject({ status: "kicked" });
    expect(
      service.getRoomState({ room_id: joined.room_id }).members.map(
        (member) => member.agent_id
      )
    ).toEqual(["human:op:chat:1"]);

    // An agent coming back lands in the same room the operator kept open.
    expect(
      service.joinPath({ agent_id: "codex:aa", context_path: root })
    ).toMatchObject({ room_id: joined.room_id, joined_existing_room: true });
  });

  test.each(["gone", "unknown"] as const)("a %s console does not keep an abandoned room", (observerLiveness) => {
    const { root, service } = setupService({ observerLiveness });
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.joinPath({
      agent_id: "human:op:chat:1",
      context_path: root,
      process_metadata: observerIdentity().process_metadata
    });
    expect(
      service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id })
    ).toMatchObject({ status: "room_deleted" });
  });

  test("the last owner leaving clears ownership while retaining chat history", async () => {
    const { root, service } = setupService({ observerLiveness: "alive" });
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.joinPath({
      agent_id: "human:op:chat:1",
      context_path: root,
      process_metadata: observerIdentity().process_metadata
    });
    const turn = await service.waitForTurn({
      agent_id: "codex:aa", room_id: joined.room_id,
      max_wait_ms: 0, allow_solo_claim: true
    });
    expect(turn.status).toBe("your_turn");
    service.sendMessage({ agent_id: "codex:aa", room_id: joined.room_id, body: "preserve me" });
    service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id });
    expect(service.getRoomState({ room_id: joined.room_id }).room).toMatchObject({
      state: "idle", owner: null, lease_expires_at: null
    });
    expect(service.joinPath({ agent_id: "codex:aa", context_path: root }).room_id).toBe(joined.room_id);
    expect(service.getRoomEvents({ room_id: joined.room_id }).some(
      (event) => event.payload?.body === "preserve me"
    )).toBe(true);
  });

  test("the last console closing an agent-less room deletes it", () => {
    const { root, service } = setupService({ observerLiveness: "alive" });
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    for (const id of ["human:op:chat:1", "human:op:chat:2"]) {
      service.joinPath({
        agent_id: id,
        context_path: root,
        process_metadata: observerIdentity().process_metadata
      });
    }
    service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id });
    expect(
      service.leaveRoom({ agent_id: "human:op:chat:1", room_id: joined.room_id })
    ).toMatchObject({ status: "left", remaining_members: 1 });
    expect(
      service.leaveRoom({ agent_id: "human:op:chat:2", room_id: joined.room_id })
    ).toMatchObject({ status: "room_deleted" });
  });

  test("idle purge keeps a room with a live console and drops one without", () => {
    const now = { value: new Date("2026-09-01T00:00:00.000Z") };
    for (const [liveness, survives] of [
      ["alive", true],
      ["gone", false]
    ] as const) {
      const root = fs.realpathSync.native(
        fs.mkdtempSync(path.join(os.tmpdir(), "tt-chat-purge-"))
      );
      now.value = new Date("2026-09-01T00:00:00.000Z");
      const service = new TalkingStickService({
        dbPath: path.join(root, ".state", "rooms.sqlite"),
        now: () => now.value,
        processLivenessChecker: (metadata) =>
          metadata.session_kind === "human_chat" ? liveness : "gone"
      });
      cleanups.push(() => {
        service.close();
        fs.rmSync(root, { recursive: true, force: true });
      });
      const joined = service.joinPath({
        agent_id: "human:op:chat:1",
        context_path: root,
        process_metadata: observerIdentity().process_metadata
      });
      now.value = new Date("2026-10-01T00:00:00.000Z");
      expect(service.listRooms({ context_path: root }).rooms.length).toBe(
        survives ? 1 : 0
      );
      expect(joined.room_id).toBeTruthy();
    }
  });

  test("an observer leaving keeps the room and emits no leave event", () => {
    const { root, service } = setupService();
    const joined = service.joinPath({
      agent_id: "codex:aa",
      context_path: root
    });
    service.joinPath({
      agent_id: "human:op",
      context_path: root,
      process_metadata: observerIdentity().process_metadata
    });

    expect(
      service.leaveRoom({ agent_id: "human:op", room_id: joined.room_id })
    ).toMatchObject({
      status: "left",
      remaining_members: 1
    });
    expect(
      service
        .getRoomEvents({ room_id: joined.room_id })
        .map((row) => row.event_type)
    ).not.toContain("leave");
  });
});

describe("tt chat session", () => {
  test("stays open after the last agent leaves and reconnects with a returning agent", async () => {
    const { root, service } = setupService({ observerLiveness: "alive" });
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });

    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: createChatIdentity(),
      context_path: root,
      input,
      output,
      terminal: false,
      color: false,
      history: 10,
      show_turn_events: false,
      poll_ms: 5
    });
    await until(() => transcript.includes("In the room: codex"));

    service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id });
    await until(() => transcript.includes("codex left"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transcript).not.toContain("The room has closed.");

    input.write("@codex are you there?\n");
    await until(() =>
      transcript.includes(
        "! codex left the room and can't receive messages until it rejoins."
      )
    );

    service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.sendMessage({
      agent_id: "codex:aa",
      room_id: joined.room_id,
      body: "back again"
    });
    await until(() => transcript.includes("back again"));

    input.write("/quit\n");
    await session;
    expect(
      service.getRoomState({ room_id: joined.room_id }).members.map(
        (member) => member.agent_id
      )
    ).toEqual(["codex:aa"]);
  });

  test("shows recent history, streams agent messages, sends, and detaches on /quit", async () => {
    const { root, service } = setupService();
    const joined = service.joinPath({
      agent_id: "codex:aa",
      context_path: root
    });
    service.sendMessage({
      agent_id: "codex:aa",
      room_id: joined.room_id,
      body: "earlier note"
    });

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });

    const identity = observerIdentity();
    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity,
      context_path: root,
      input,
      output,
      terminal: false,
      color: false,
      history: 10,
      show_turn_events: true,
      poll_ms: 5
    });

    await until(() => transcript.includes("earlier note"));
    expect(transcript).toContain("In the room: codex");

    input.write("hello team\n");
    input.write("@codex please rebase\n");
    input.write("@nobody hi\n");
    input.write("partial @codex and @nobody\n");
    await until(() =>
      /you → codex  \d\d:\d\d\n  please rebase/.test(transcript)
    );
    expect(transcript).toMatch(/\n\nyou  \d\d:\d\d\n  hello team\n/);
    expect(transcript).toContain("! No room member matches '@nobody'.");
    // One unknown mention blocks the whole send; nothing reaches codex.
    expect(transcript).not.toContain("partial @codex and @nobody");

    service.sendMessage({
      agent_id: "codex:aa",
      room_id: joined.room_id,
      body: "rebased",
      to_agent_id: identity.agent_id
    });
    await until(() => /codex → you  \d\d:\d\d\n  rebased/.test(transcript));

    service.joinPath({ agent_id: "codex:bb", context_path: root });
    input.write("@CODEX, check both sessions\n");
    await until(
      () =>
        service
          .getRoomEvents({ room_id: joined.room_id, include_all: true })
          .filter((event) => event.payload?.body === "check both sessions")
          .length === 2
    );
    expect(
      service
        .getRoomEvents({ room_id: joined.room_id, include_all: true })
        .filter((event) => event.payload?.body === "check both sessions")
        .map((event) => event.to_agent_id)
        .sort()
    ).toEqual(["codex:aa", "codex:bb"]);
    service.leaveRoom({ agent_id: "codex:bb", room_id: joined.room_id });

    service.joinPath({ agent_id: "claude:cc", context_path: root });
    input.write("ping @codex:aa and @claude about it\n");
    const mentioned = () =>
      service
        .getRoomEvents({ room_id: joined.room_id, include_all: true })
        .filter((event) => event.payload?.body === "ping @codex:aa and @claude about it")
        .map((event) => event.to_agent_id)
        .sort();
    await until(() => mentioned().length === 2);
    expect(mentioned()).toEqual(["claude:cc", "codex:aa"]);
    service.leaveRoom({ agent_id: "claude:cc", room_id: joined.room_id });

    input.write("/quit\n");
    await session;

    const members = service.getRoomState({ room_id: joined.room_id }).members;
    expect(members.map((member) => member.agent_id)).toEqual(["codex:aa"]);
  });

  test.each([false, true])(
    "room deletion explains the exit (TTY=%s)",
    async (terminal) => {
      const { root, service } = setupService({ observerLiveness: "gone" });
      const joined = service.joinPath({
        agent_id: "codex:aa",
        context_path: root
      });
      const output = new PassThrough();
      let transcript = "";
      output.on("data", (chunk) => {
        transcript += chunk.toString();
      });

      const session = runChatSession({
        runtime: {
          commands: new TalkingStickCommands(service),
          close: () => {}
        },
        identity: observerIdentity(),
        context_path: root,
        input: new PassThrough(),
        output,
        terminal,
        color: false,
        history: 10,
        show_turn_events: true,
        poll_ms: 5
      });
      await until(() => transcript.includes("Talking Stick chat"));

      service.leaveRoom({ agent_id: "codex:aa", room_id: joined.room_id });
      await session;
      if (terminal) {
        expect(
          transcript.slice(transcript.lastIndexOf("\u001b[?1049l"))
        ).toContain("tt chat: the room has closed.");
      } else expect(transcript).toContain("The room has closed.");
    }
  );
});

test("each console has a distinct identity even with an explicit human base", () => {
  const first = createChatIdentity("human:operator");
  const second = createChatIdentity("human:operator");
  expect(first.agent_id).not.toBe(second.agent_id);
  expect(first.agent_id).not.toBe("human:operator");
  expect(first.process_metadata.display_name).toBe("operator");
  expect(first.process_metadata.pid).toBe(process.pid);
});

test("observer direct wait and takeover cannot acquire ownership", async () => {
  const { root, service } = setupService();
  const identity = observerIdentity();
  const room = service.joinPath({
    agent_id: identity.agent_id,
    context_path: root,
    process_metadata: identity.process_metadata
  });
  await expect(
    service.waitForTurn({
      agent_id: identity.agent_id,
      room_id: room.room_id,
      max_wait_ms: 0,
      allow_solo_claim: true
    })
  ).rejects.toThrow(/observers cannot acquire/);
  expect(() =>
    service.takeoverStick({
      agent_id: identity.agent_id,
      room_id: room.room_id,
      expected_turn_id: 0,
      reason: "test",
      operator_override: true
    })
  ).toThrow(/observers cannot acquire/);
  expect(service.getRoomState({ room_id: room.room_id }).room.owner).toBeNull();
});

test("zero history hides backlog; recent history reaches the newest messages past one batch", async () => {
  const { root, service } = setupService();
  const room = service.joinPath({
    agent_id: "codex:history",
    context_path: root
  });
  for (let index = 0; index < 250; index++) {
    service.sendMessage({
      agent_id: "codex:history",
      room_id: room.room_id,
      body: `backlog-${index}`
    });
  }
  for (const history of [0, 3]) {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: createChatIdentity(),
      context_path: root,
      input,
      output,
      terminal: false,
      color: false,
      history,
      show_turn_events: false,
      poll_ms: 5
    });
    await until(() => transcript.includes("In the room"));
    if (history === 0) expect(transcript).not.toContain("backlog-");
    else {
      expect(transcript).toContain("backlog-249");
      expect(transcript).toContain("backlog-247");
      expect(transcript).not.toContain("backlog-246");
    }
    input.write("/quit\n");
    await session;
  }
});

test.each([false, true])(
  "setup failure restores input and detaches the observer (TTY=%s)",
  async (terminal) => {
    const { root, service } = setupService();
    const room = service.joinPath({
      agent_id: "codex:setup",
      context_path: root
    });
    const commands = new TalkingStickCommands(service);
    commands.getRecentRoomEvents = () => {
      throw new Error("history failed");
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString();
    });
    await expect(
      runChatSession({
        runtime: { commands, close: () => {} },
        identity: createChatIdentity(),
        context_path: root,
        input,
        output,
        terminal,
        mouse: false,
        color: false,
        history: 2,
        show_turn_events: false
      })
    ).rejects.toThrow("history failed");
    expect(input.listenerCount("data")).toBe(0);
    if (terminal) {
      expect(captured).toContain("\u001b[?1049h");
      expect(captured).toContain("\u001b[?1049l");
      expect(captured).not.toContain("\u001b[?1000h");
    }
    expect(
      service.getRoomState({ room_id: room.room_id }).members
    ).toHaveLength(1);
  }
);

test.each([
  "draft-" + "x".repeat(84),
  "draft-" + "界".repeat(30) + "🙂".repeat(10) + "e\u0301".repeat(10)
])(
  "terminal preserves a pasted wrapped draft and mid-line cursor across incoming messages: %s",
  async (draft) => {
    const { root, service } = setupService();
    const room = service.joinPath({
      agent_id: "codex:terminal",
      context_path: root
    });
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 40 });
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const identity = createChatIdentity();
    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity,
      context_path: root,
      input,
      output,
      terminal: true,
      color: false,
      history: 0,
      show_turn_events: false,
      poll_ms: 5
    });
    await until(() => transcript.includes("Room · "));
    input.write(draft);
    input.write("\u001b[D".repeat(20));
    service.sendMessage({
      agent_id: "codex:terminal",
      room_id: room.room_id,
      body: "during-draft"
    });
    await until(() => transcript.includes("during-draft"));
    output.columns = 24;
    output.emit("resize");
    output.columns = 60;
    output.emit("resize");
    input.write("Z\r");
    await until(() =>
      service
        .getRoomEvents({ room_id: room.room_id, include_all: true })
        .some(
          (row) =>
            row.payload?.body === draft.slice(0, -20) + "Z" + draft.slice(-20)
        )
    );
    input.write("/quit\r");
    await session;
  }
);

function setupService(options: TalkingStickServiceOptions & { observerLiveness?: ProcessLiveness } = {}) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "tt-chat-"))
  );
  const service = new TalkingStickService({
    dbPath: path.join(root, ".state", "rooms.sqlite"),
    policy: { waitForEventsPollMs: 1 },
    ...options,
    ...(options.observerLiveness
      ? { processLivenessChecker: (metadata: ProcessMetadata) =>
          metadata.session_kind === "human_chat" ? options.observerLiveness! : "unknown" }
      : {})
  });
  cleanups.push(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, service };
}

function observerIdentity() {
  return deriveHumanCliIdentity({
    agentId: "human:op",
    displayName: "op",
    sessionKind: "human_chat"
  });
}

function event(overrides: Partial<RoomEvent>): RoomEvent {
  return {
    event_seq: 1,
    event_id: "e1",
    room_id: "r1",
    turn_id: 1,
    event_type: "message_sent",
    from_agent_id: null,
    to_agent_id: null,
    handoff: null,
    reason: null,
    created_at: new Date().toISOString(),
    payload: null,
    ...overrides
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("chat remains responsive while a slow recipient wakes and reports each recipient independently", async () => {
  let finishSlow!: (result: { outcome: "queued" }) => void;
  const slow = new Promise<{ outcome: "queued" }>((resolve) => { finishSlow = resolve; });
  let deliveries = 0;
  const { root, service } = setupService({ nativeWakeTransport: {
    deliver(request) { deliveries++; return request.address === "slow" ? slow : { outcome: "queued" }; }
  } });
  const joined = service.joinPath({ agent_id: "claude:slow", context_path: root, process_metadata: { harness_session_id: "slow" } });
  service.joinPath({ agent_id: "claude:fast", context_path: root, process_metadata: { harness_session_id: "fast" } });
  for (const name of ["slow", "fast"]) service.registerNativeWakeEndpoint({ room_id: joined.room_id,
    agent_id: `claude:${name}`, transport: "claude_inbox", address: name, secret: "private", harness_session_id: name, host_id: os.hostname() });
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: false, color: false, history: 0,
    show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => transcript.includes("Talking Stick chat"));
    input.write("@claude hello both\n");
    await until(() => deliveries === 2);
    input.write("/who\n");
    await until(() => transcript.split("In the room:").length >= 3);
    await until(() => transcript.includes("claude:fast: queued"));
    expect(transcript).not.toContain("claude:slow: queued");
    finishSlow({ outcome: "queued" });
    await until(() => transcript.includes("claude:slow: queued"));
    const noticesBefore = transcript.match(/claude:fast: queued/g)?.length;
    input.write("@claude:fast another message\n");
    await until(() => (transcript.match(/claude:fast: queued/g)?.length ?? 0) > (noticesBefore ?? 0));
    expect(deliveries).toBe(2);
  } finally {
    finishSlow({ outcome: "queued" });
    input.write("/quit\n");
    await session;
  }
});

describe("message receipts", () => {
  test("record only addressed messages actually returned to the recipient's own stream", async () => {
    const { root, service } = setupService();
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.joinPath({ agent_id: "claude:bb", context_path: root });
    const roomId = joined.room_id;
    const first = service.sendMessage({ agent_id: "claude:bb", room_id: roomId, to_agent_id: "codex:aa", body: "one" });
    const skipped = service.sendMessage({ agent_id: "claude:bb", room_id: roomId, to_agent_id: "codex:aa", body: "two" });
    const broadcast = service.sendMessage({ agent_id: "claude:bb", room_id: roomId, body: "all" });
    const receipts = () =>
      service.getMessageReceipts({ room_id: roomId, event_seqs: [first.event_seq, skipped.event_seq, broadcast.event_seq] });

    // An audit wait of someone else's stream is not delivery.
    await service.waitForEvents({ agent_id: "claude:bb", room_id: roomId, after_event_seq: 0, target_agent_id: "any", max_wait_ms: 0 });
    expect(receipts()).toEqual([]);

    // A cursor that skips a message never marks it delivered.
    await service.waitForEvents({ agent_id: "codex:aa", room_id: roomId, after_event_seq: skipped.event_seq, max_wait_ms: 0 });
    expect(receipts()).toEqual([]);

    await service.waitForTurn({
      agent_id: "codex:aa", room_id: roomId, max_wait_ms: 0, mode: "parked",
      include_events: true, after_event_seq: first.event_seq - 1
    });
    expect(receipts().map((receipt) => [receipt.event_seq, receipt.agent_id])).toEqual([
      [first.event_seq, "codex:aa"],
      [skipped.event_seq, "codex:aa"]
    ]);
  });

  test("chat advances a delivery notice once the recipient's wait returns the message", async () => {
    const { root, service } = setupService();
    const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: observerIdentity(),
      context_path: root,
      input,
      output,
      terminal: false,
      color: false,
      history: 0,
      show_turn_events: false,
      poll_ms: 5
    });
    await until(() => transcript.includes("In the room"));
    input.write("@codex please look\n");
    await until(() => /codex: \S/.test(transcript));
    expect(transcript).not.toContain("codex: delivered");
    await service.waitForTurn({
      agent_id: "codex:aa", room_id: joined.room_id, max_wait_ms: 0, mode: "parked",
      include_events: true, after_event_seq: 0
    });
    await until(() => transcript.includes("codex: delivered"));
    input.write("/quit\n");
    await session;
  });
});

test("receipts for later messages still arrive with more than one batch awaiting", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close: () => {} },
    identity: observerIdentity(),
    context_path: root,
    input,
    output,
    terminal: false,
    color: false,
    history: 0,
    show_turn_events: false,
    poll_ms: 5
  });
  await until(() => transcript.includes("In the room"));
  const count = 205;
  input.write(Array.from({ length: count }, (_, index) => `@codex m${index}\n`).join(""));
  await until(() => (transcript.match(/codex: /g)?.length ?? 0) >= count, 10_000);
  const last = service.getLatestEventSeq({ room_id: joined.room_id });
  await service.waitForTurn({
    agent_id: "codex:aa", room_id: joined.room_id, max_wait_ms: 0, mode: "parked",
    include_events: true, after_event_seq: last - 1
  });
  await until(() => transcript.includes("codex: delivered"), 5_000);
  expect(transcript.match(/codex: delivered/g)).toHaveLength(1);
  input.write("/quit\n");
  await session;
}, 20_000);

describe("ended member pruning", () => {
  test("probes liveness without a writer lock and preserves concurrently refreshed members", () => {
    let clock = new Date("2026-09-16T10:00:00Z");
    let onProbe: (() => void) | undefined;
    const { root, service } = setupService({ now: () => clock,
      policy: { idleRoomTtlMs: 0 },
      processLivenessChecker: () => { onProbe?.(); return "gone"; }
    });
    const room = service.joinPath({ agent_id: "codex:old", context_path: root,
      process_metadata: { host_id: "host", pid: 123, process_started_at: "start", session_kind: "harness_cli" } });
    const concurrent = new Database(service.db.name);
    concurrent.pragma("busy_timeout = 1");
    clock = new Date("2026-09-16T12:00:00Z");
    let probed = false;
    onProbe = () => {
      onProbe = undefined;
      probed = true;
      expect(service.db.inTransaction).toBe(false);
      concurrent.prepare("UPDATE room_members SET last_seen_at = ? WHERE room_id = ?")
        .run(clock.toISOString(), room.room_id);
    };
    try {
      const state = service.getRoomState({ room_id: room.room_id, include_all: true });
      expect(probed).toBe(true);
      expect(state.members.map(member => member.agent_id)).toContain("codex:old");
    } finally { concurrent.close(); }
  });

  test("removes definitely ended agents after the grace period and keeps everyone else", () => {
    let clock = new Date("2026-09-15T10:00:00.000Z");
    const liveness: Record<string, ProcessLiveness> = {
      "gone-old": "gone",
      "gone-recent": "gone",
      "alive-old": "alive",
      "unknown-old": "unknown",
      "gone-owner": "gone"
    };
    const { root, service } = setupService({
      now: () => clock,
      // Room expiry disabled: ended-member cleanup must still run.
      policy: { waitForEventsPollMs: 1, idleRoomTtlMs: 0 },
      processLivenessChecker: (metadata: ProcessMetadata) =>
        liveness[metadata.harness_session_id ?? ""] ?? "unknown"
    });
    const meta = (session: string): ProcessMetadata => ({
      host_id: "h", pid: 1, process_started_at: "t", session_kind: "harness_cli",
      harness_name: "codex", harness_session_id: session, harness_host_id: "h",
      harness_pid: 2, harness_process_started_at: "t"
    });
    const owner = service.joinPath({ agent_id: "codex:owner", context_path: root, process_metadata: meta("gone-owner") });
    service.joinPath({ agent_id: "codex:old", context_path: root, process_metadata: meta("gone-old") });
    service.joinPath({ agent_id: "codex:alive", context_path: root, process_metadata: meta("alive-old") });
    service.joinPath({ agent_id: "codex:unknown", context_path: root, process_metadata: meta("unknown-old") });
    service.db.prepare("UPDATE path_rooms SET owner = 'codex:owner', state = 'owned' WHERE room_id = ?").run(owner.room_id);

    clock = new Date("2026-09-15T11:30:00.000Z");
    service.joinPath({ agent_id: "codex:recent", context_path: root, process_metadata: meta("gone-recent") });
    const state = service.getRoomState({ room_id: owner.room_id, include_all: true });
    expect(state.members.map((member) => member.agent_id).sort()).toEqual([
      "codex:alive", "codex:owner", "codex:recent", "codex:unknown"
    ]);
    expect(state.members.find((member) => member.agent_id === "codex:alive")?.process_liveness).toBe("alive");
    const leave = service.getRoomEvents({ room_id: owner.room_id, include_all: true })
      .find((event) => event.event_type === "leave");
    expect(leave).toMatchObject({ from_agent_id: "codex:old", reason: "process_ended" });
  });
});

test("chat kick rejects ambiguous and unconfirmed targets, then revokes an exact owner's turn with force", async () => {
  const { root, service } = setupService({ observerLiveness: "alive" });
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  service.joinPath({ agent_id: "codex:bb", context_path: root });
  await service.waitForTurn({ agent_id: "codex:aa", room_id: joined.room_id, max_wait_ms: 0 });
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: false, color: false, history: 0,
    show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => transcript.includes("Talking Stick chat"));
    input.write("/kick codex\n");
    await until(() => transcript.includes("Ambiguous agent codex: codex:aa, codex:bb"));
    input.write("/kick codex:aa\n");
    await until(() => transcript.includes("is not confirmed ended"));
    input.write("/kick --force human:op\n");
    await until(() => transcript.includes("Chat consoles cannot be kicked"));
    input.write("/kick --force codex:aa test removal\n");
    await until(() => transcript.includes("Its turn was revoked."));
    expect(service.getRoomState({ room_id: joined.room_id }).room.owner).toBeNull();
    expect(service.getRoomState({ room_id: joined.room_id }).members.map((member) => member.agent_id)).toContain("codex:bb");
    const events = service.getRoomEvents({ room_id: joined.room_id, limit: 100 });
    expect(events.find((event) => event.event_type === "kick")).toMatchObject({ to_agent_id: "codex:aa", reason: "test removal" });
  } finally {
    input.write("/quit\n");
    await session;
  }
});

test("chat kicks a persistently ended member without force and protects live members", async () => {
  let now = new Date("2026-09-15T12:00:00Z");
  const { root, service } = setupService({ now: () => now,
    processLivenessChecker: (metadata) => metadata.harness_session_id === "ended" ? "gone" : "alive" });
  const joined = service.joinPath({ agent_id: "claude:ended", context_path: root, process_metadata: {
    host_id: "host", pid: 1, process_started_at: "t", harness_session_id: "ended", harness_host_id: "host",
    harness_pid: 1, harness_process_started_at: "t", session_kind: "harness_cli"
  } });
  service.joinPath({ agent_id: "codex:live", context_path: root, process_metadata: {
    host_id: "host", pid: 2, process_started_at: "t", session_kind: "harness_cli"
  } });
  now = new Date("2026-09-15T12:11:00Z");
  const input = new PassThrough(); const output = new PassThrough(); let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: false, color: false, history: 0,
    show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => transcript.includes("Talking Stick chat"));
    input.write("/kick codex:live\n");
    await until(() => transcript.includes("is still running"));
    input.write("/kick claude:ended cleanup\n");
    await until(() => transcript.includes("Removed claude:ended"));
    expect(service.getRoomState({ room_id: joined.room_id }).members.map((member) => member.agent_id)).not.toContain("claude:ended");
    input.write("/who\n");
    await until(() => transcript.includes("In the room: codex"));
  } finally { input.write("/quit\n"); await session; }
});

test("inline chat keeps a pasted multiline draft and erases wrapped rows", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 12 });
  let out = "";
  output.on("data", (chunk) => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline: true, color: false, history: 0, show_turn_events: false, poll_ms: 5
  });
  const bodies = () =>
    service.getRoomEvents({ room_id: joined.room_id, include_all: true })
      .filter((event) => event.event_type === "message_sent")
      .map((event) => event.payload?.body);
  try {
    await until(() => out.includes("> "));
    // Bracketed paste must stay in the draft instead of sending line by line.
    input.write("\u001b[200~first line\nsecond line\u001b[201~");
    await until(() => out.includes("second line"));
    expect(bodies()).toEqual([]);
    out = "";
    input.write("x".repeat(70));
    await until(() => /x{30}/.test(out));
    // Erasing a wrapped draft walks back up every row it drew.
    expect(out).toMatch(/\u001b\[\d+A\u001b\[J/);
    input.write("\u007f".repeat(70) + "\r");
    await until(() => bodies().length === 1);
    expect(bodies()).toEqual(["first line\nsecond line"]);
  } finally {
    input.write("/quit\r");
    await session;
  }
});

test("inline incoming messages erase from the actual draft cursor and restore paste mode on exit", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(raw: boolean) { rawModes.push(raw); } });
  const output = Object.assign(new PassThrough(), { columns: 40, rows: 12 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline: true, color: false, history: 0, show_turn_events: false, poll_ms: 5
  });
  try {
    await until(() => out.includes("> "));
    input.write("\u001b[200~first\nsecond\u001b[201~\u001b[A");
    out = "";
    service.sendMessage({ agent_id: "codex:aa", room_id: joined.room_id, body: "incoming-during-edit" });
    await until(() => out.includes("incoming-during-edit"));
    // With no suggestions, only the room bar is above the first draft row.
    // Move back only to the panel start, never into the transcript.
    expect(out.startsWith("\r\u001b[1A\u001b[J")).toBe(true);
    expect(out).toContain("first");
    expect(out).toContain("second");
  } finally {
    input.write("\u0003/quit\r");
    await session;
  }
  expect(out).toContain("\u001b[?2004l");
  expect(rawModes).toEqual([true, false]);
});

test("inline terminal retains history, bars and draft across incoming messages and resize", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  for (let i = 0; i < 30; i++) service.sendMessage({ agent_id: "codex:aa", room_id: joined.room_id, body: `saved-message-${i}` });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  const vt = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 5000 });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const text = () => Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: false, history: 20, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("saved-message-29"));
    await flush();
    expect(vt.buffer.active.type).toBe("normal");
    expect(vt.buffer.active.baseY).toBeGreaterThan(0);
    expect(text()).toContain("Room · ");
    expect(text()).toContain("codex");
    input.write("\u001b[200~draft-first\ndraft-second\u001b[201~\u001b[A");
    service.sendMessage({ agent_id: "codex:aa", room_id: joined.room_id, body: "incoming-marker" });
    await until(() => bytes.includes("incoming-marker"));
    await flush();
    expect(text()).toContain("saved-message-29");
    expect(text()).toContain("incoming-marker");
    expect(text().match(/draft-first/g)).toHaveLength(1);
    expect(text().match(/draft-second/g)).toHaveLength(1);
    vt.resize(40, 24); output.columns = 40; output.emit("resize");
    await flush();
    expect(text()).toContain("incoming-marker");
    expect(text().match(/draft-first/g)).toHaveLength(1);
    expect(text().match(/draft-second/g)).toHaveLength(1);
    expect(text()).toContain("Room · ");
    // A sudden shrink in both directions reflows the panel that is already on
    // screen, so at most one stale copy can be left behind in scrollback; the
    // live panel and the draft must still be intact and singular afterwards.
    vt.resize(20, 8); output.columns = 20; output.rows = 8; output.emit("resize");
    await flush();
    expect(text().match(/draft-first/g)).toHaveLength(1);
    expect(text().match(/Room · /g)?.length ?? 0).toBeLessThanOrEqual(2);
    vt.resize(80, 24); output.columns = 80; output.rows = 24; output.emit("resize");
    await flush();
    expect(text().match(/draft-second/g)).toHaveLength(1);
    expect(text()).toContain("Room · ");
    input.write("\u0003/older\r");
    await until(() => bytes.includes("saved-message-0"));
    await flush();
    expect(text()).toContain("Earlier saved messages");
    expect(text()).toContain("saved-message-0");
    const beforeMenu = vt.buffer.active.baseY;
    input.write("/h");
    await flush();
    expect(text()).toContain("› /help");
    expect(vt.buffer.active.baseY).toBe(beforeMenu + 1);
    input.write("\u0003" + "Ω".repeat(37));
    await flush();
    for (const cols of [20, 80, 40]) {
      vt.resize(cols, 24);
      output.columns = cols; output.emit("resize");
      await flush();
      expect(text()).toContain("incoming-marker");
      // Reflow must not leave old draft fragments in the conversation.
      expect((text().match(/Ω/g) ?? []).length, JSON.stringify({ cols, screen: text().split("\n").slice(-30) })).toBe(37);
    }
    expect(bytes).not.toContain("\u001b[?1049h");
    expect(bytes).not.toContain("\u001b[2J");
    expect(bytes).not.toContain("\u001b[3J");
    expect(bytes).not.toContain("\u001b[?1000h");
  } finally {
    input.write("\u0003/quit\r");
    await session;
    vt.dispose();
  }
});

test("chat survives a real SQLite writer lock and preserves its draft and event cursor", async () => {
  const { root, service } = setupService();
  const room = service.joinPath({ agent_id: "codex:aa", context_path: root });
  const concurrent = new Database(service.db.name);
  service.db.pragma("busy_timeout = 1");
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  let finished = false;
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 }).finally(() => { finished = true; });
  // Observe rejection immediately even when the test is waiting for UI output.
  void session.catch(() => {});
  try {
    await until(() => out.includes("Room ·"));
    input.write("unsent-draft");
    service.joinPath({ agent_id: "claude:joined", context_path: root });
    concurrent.exec("BEGIN IMMEDIATE");
    await until(() => out.includes("database busy"));
    expect(finished).toBe(false);
    input.write("-preserved");
    concurrent.exec("COMMIT");
    out = "";
    await until(() => out.includes("claude"));
    input.write("\r");
    await until(() => service.getRoomEvents({ room_id: room.room_id, include_all: true })
      .some(event => event.payload?.body === "unsent-draft-preserved"));
    const sent = service.getRoomEvents({ room_id: room.room_id, include_all: true })
      .filter(event => event.payload?.body === "unsent-draft-preserved");
    expect(sent).toHaveLength(1);
    expect(finished).toBe(false);
  } finally {
    if (concurrent.inTransaction) concurrent.exec("ROLLBACK");
    concurrent.close();
    input.write("\u0003/quit\r");
    await session;
  }
});

test("the chat CLI renders inline unless --fullscreen is given", () => {
  const inline = (argv: string[]) => chatInlineEnabled(parseCommand(["chat", ...argv]));
  expect(inline([])).toBe(true);
  expect(inline(["--fullscreen"])).toBe(false);
});

test.each([undefined, false, true])("chat enables terminal mouse capture only when requested (mouse=%s)", async (mouse) => {
  const { root, service } = setupService();
  const input = new PassThrough(); const output = new PassThrough(); let captured = "";
  output.on("data", (chunk) => { captured += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, color: false, history: 0,
    show_turn_events: false, poll_ms: 5, mouse });
  try {
    await until(() => captured.includes("Room · "));
    expect(captured.includes("\u001b[?1000h")).toBe(mouse === true);
    expect(captured.includes("\u001b[?1006h")).toBe(mouse === true);
  } finally { input.write("/quit\r"); await session; }
  expect(captured).toContain("\u001b[?1000l\u001b[?1006l");
});

test("reopened chat pages back beyond its startup history and 500-event scan", async () => {
  const { root, service } = setupService();
  const room = service.joinPath({ agent_id: "codex:archive", context_path: root });
  for (let i = 0; i < 650; i++) service.sendMessage({ agent_id: "codex:archive", room_id: room.room_id, body: `archive-${String(i).padStart(3, "0")}` });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let captured = "";
  output.on("data", (chunk) => { captured += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, color: false, history: 3,
    show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => captured.includes("archive-649"));
    expect(captured).not.toContain("archive-000");
    input.write("\u001b[5~".repeat(200));
    await until(() => captured.includes("archive-000"));
    input.write("\u001b[1;5F");
    service.sendMessage({ agent_id: "codex:archive", room_id: room.room_id, body: "fresh-live-message" });
    await until(() => captured.includes("fresh-live-message"));
  } finally { input.write("/quit\r"); await session; }
}, 20_000);

test.each([false, true])("inline delivery replaces pending status with delivered without disturbing the draft (manual standby=%s)", async (manualStandby) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  if (manualStandby) service.registerStandby({ agent_id: "codex:aa", room_id: joined.room_id, transport: "manual" });
  const initialState = manualStandby ? "waiting for resume" : "not listening";
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
  const vt = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const text = () => Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Room ·"));
    input.write("@codex first message\r");
    await until(() => bytes.includes("first message") && bytes.includes(`codex: ${initialState}`));
    input.write("unfinished draft");
    await flush();
    const history = vt.buffer.active.baseY;
    await service.waitForTurn({ agent_id: "codex:aa", room_id: joined.room_id, max_wait_ms: 0,
      mode: "parked", include_events: true, after_event_seq: 0 });
    await until(() => bytes.includes("codex: delivered"));
    await flush();
    expect(text()).toContain("codex: delivered");
    expect(text()).not.toContain(`codex: ${initialState}`);
    expect(text()).not.toContain("received");
    expect(text()).toContain("> unfinished draft");
    expect(vt.buffer.active.baseY).toBe(history);
    expect(vt.buffer.active.type).toBe("normal");
  } finally {
    input.write("\u0003\u0004");
    await session;
    vt.dispose();
  }
});

test("a dumb terminal falls back to plain line mode", () => {
  const tty = { isTTY: true };
  expect(chatTerminalCapable(tty, tty, { TERM: "xterm-256color" })).toBe(true);
  expect(chatTerminalCapable(tty, tty, { TERM: "dumb" })).toBe(false);
  expect(chatTerminalCapable({ isTTY: false }, tty, { TERM: "xterm-256color" })).toBe(false);
  expect(chatTerminalCapable(tty, {}, {})).toBe(false);
});

test.each([true, false])("receipts update the matching transcript message, never the footer (inline=%s)", async (inline) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 32 });
  const vt = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const lines = () => Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Room ·"));
    input.write("@codex first distinct message\r");
    await until(() => bytes.includes("first distinct message"));
    input.write("@codex second distinct message\r");
    await until(() => bytes.includes("second distinct message"));
    const intervening = "intervening " + "界🙂".repeat(60);
    service.sendMessage({ agent_id: "codex:aa", room_id: joined.room_id, body: intervening });
    await until(() => bytes.includes("intervening"));
    input.write("unfinished draft");
    const events = service.getRoomEvents({ room_id: joined.room_id, include_all: true });
    const first = events.find(event => event.payload?.body === "@codex first distinct message" || event.payload?.body === "first distinct message")!;
    const second = events.find(event => event.payload?.body === "@codex second distinct message" || event.payload?.body === "second distinct message")!;
    // Accept only the second event first: the older receipt must not overwrite it.
    service.db.prepare("INSERT INTO message_receipts (room_id, agent_id, event_seq, delivered_at) VALUES (?, ?, ?, ?)")
      .run(joined.room_id, "codex:aa", second.event_seq, new Date().toISOString());
    await until(() => bytes.includes("codex: delivered"));
    await flush();
    let rendered = lines();
    let firstRow = rendered.findIndex(line => line.includes("first distinct message"));
    let secondRow = rendered.findIndex(line => line.includes("second distinct message"));
    expect(rendered[firstRow + 1]).toContain("codex: not listening");
    expect(rendered[secondRow + 1]).toContain("codex: delivered");
    const roomBar = rendered.length - 1 - [...rendered].reverse().findIndex(line => line.includes("Room ·"));
    if (inline) expect(rendered.slice(roomBar).join("\n")).not.toContain("delivered");
    expect(rendered.join("\n")).toContain("> unfinished draft");
    if (inline) {
      vt.resize(60, 32); output.columns = 60; output.emit("resize");
      await flush();
    }
    bytes = "";
    service.db.prepare("INSERT INTO message_receipts (room_id, agent_id, event_seq, delivered_at) VALUES (?, ?, ?, ?)")
      .run(joined.room_id, "codex:aa", first.event_seq, new Date().toISOString());
    await until(() => bytes.includes("codex: delivered"));
    await flush();
    rendered = lines();
    firstRow = rendered.findIndex(line => line.includes("first distinct message"));
    secondRow = rendered.findIndex(line => line.includes("second distinct message"));
    expect(rendered[firstRow + 1]).toContain("codex: delivered");
    expect(rendered[secondRow + 1]).toContain("codex: delivered");
    expect(rendered.join("").match(/界/g)).toHaveLength(60);
    expect(rendered.join("").match(/🙂/g)).toHaveLength(60);
  } finally { input.write("\u0003\u0004"); await session; vt.dispose(); }
});

test("saved history batches durable receipts and does not invent pending states for old messages", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  service.joinPath({ agent_id: "human:old:chat:session", context_path: root });
  service.sendMessage({ agent_id: "human:old:chat:session", room_id: joined.room_id, to_agent_id: "codex:aa", body: "old unread" });
  const delivered = service.sendMessage({ agent_id: "human:old:chat:session", room_id: joined.room_id, to_agent_id: "codex:aa", body: "old delivered" });
  service.db.prepare("INSERT INTO message_receipts (room_id, agent_id, event_seq, delivered_at) VALUES (?, ?, ?, ?)")
    .run(joined.room_id, "codex:aa", delivered.event_seq, new Date().toISOString());
  const commands = new TalkingStickCommands(service);
  const queries: number[][] = [];
  const getReceipts = commands.getMessageReceipts.bind(commands);
  commands.getMessageReceipts = query => { queries.push(query.event_seqs); return getReceipts(query); };
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); });
  const session = runChatSession({ runtime: { commands, close() {} }, identity: observerIdentity(),
    context_path: root, input, output, terminal: true, inline: true, color: false,
    history: 10, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("old delivered\r\n  codex: delivered"));
    expect(bytes).toContain("old unread");
    expect(bytes).not.toContain("codex: sent");
    expect(bytes).not.toContain("codex: queued");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toHaveLength(2);
  } finally { input.write("\u0004"); await session; }
});
