import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
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
import { chatInlineEnabled, chatTerminalCapable, createChatIdentity, runChatConsole, runChatSession, uniqueRoomNames } from "../src/cli/chat.js";
import { formatRoomStrip } from "../src/cli/chat-format.js";
import { chatThemeName, setChatTheme } from "../src/cli/theme.js";
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
    expect(text).toBe("\u001b[2;38;5;244mcodex  Yesterday at 09:05\u001b[0m\n\u001b[2;38;5;244m  old message\u001b[0m");
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

  test("transient interrupt indicators replace member state without changing the transcript", () => {
    const members = [
      member({ agent_id: "codex:aa" }),
      member({ agent_id: "claude:bb", standby_transport: "manual" })
    ];
    const base = { members, owner: "codex:aa", owner_since: minutesAgo(2),
      reserved_for: null, now, columns: 100 };
    const names = context(members.map((row: { agent_id: string }) => row.agent_id));
    expect(formatChatStatus({ ...base, interrupt_statuses: new Map([
      ["codex:aa", "interrupted"], ["claude:bb", "stopping"]
    ]) }, names)).toBe("codex interrupted · claude stopping");
    expect(formatChatStatus(base, names)).toBe("codex holding 2m · claude standby");
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

  test("a running console delivers a wake its sender could not", async () => {
    const delivered: string[] = [];
    const { root, service } = setupService({ hostId: "host-a", processLivenessChecker: () => "alive",
      receiverLivenessChecker: () => "gone",
      nativeWakeTransport: { deliver(request) { delivered.push(request.text); return { outcome: "queued" }; } } });
    const agent: ProcessMetadata = { host_id: "host-a", pid: 4001, process_started_at: "t", session_kind: "human_guardian",
      display_name: "claude", harness_name: "claude", harness_session_id: "claude-session", harness_host_id: "host-a",
      harness_pid: 5001, harness_process_started_at: "t" };
    const { room_id: roomId } = service.joinPath({ agent_id: "claude:aa", context_path: root, process_metadata: agent });
    service.registerNativeWakeEndpoint({ agent_id: "claude:aa", room_id: roomId, transport: "claude_inbox",
      address: "/tmp/claude.sock", secret: "s", harness_session_id: "claude-session", host_id: "host-a" });

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const session = runChatSession({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: createChatIdentity(), context_path: root, input, output,
      terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5
    });
    await until(() => transcript.includes("In the room: claude"));

    // A visitor whose process may not open the agent's socket.
    const restricted = new TalkingStickService({ dbPath: path.join(root, ".state", "rooms.sqlite"), hostId: "host-a",
      processLivenessChecker: () => "alive", receiverLivenessChecker: () => "gone",
      nativeWakeTransport: { deliver: () => ({ outcome: "failed", error: "claude_inbox_unreachable", detail: "connect:EPERM", local: true }) } });
    cleanups.push(() => restricted.close());
    const asked = await restricted.askRoom({ agent_id: "codex:desktop", room_id: roomId, to: ["claude:aa"], body: "status?" });
    expect(asked.deliveries?.[0]).toMatchObject({ error_detail: "connect:EPERM" });

    await until(() => delivered.length === 1);
    expect(delivered[0]).toContain(`#${asked.event_seq} visitor codex:desktop → you`);
    input.write("/quit\n");
    await session;
    expect(delivered).toHaveLength(1);
  });

  test("room activity counts unread and directed messages and ignores consoles", () => {
    const { root, service } = setupService();
    const room = service.joinPath({ agent_id: "codex:aa", context_path: root });
    service.joinPath({ agent_id: "human:op", context_path: root, process_metadata: { session_kind: "human_chat" } });
    const start = service.globalEventSeq();
    service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, body: "to all" });
    service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, body: "to op", to_agent_id: "human:op" });
    service.sendMessage({ agent_id: "human:op", room_id: room.room_id, body: "mine" });
    service.joinPath({ agent_id: "grok:bb", context_path: root });
    service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, body: "to both", to_agent_ids: ["human:op", "grok:bb"] });
    expect(service.summarizeRoomActivity({ agent_id: "human:op", rooms: [{ room_id: room.room_id, after_event_seq: start }] }))
      .toEqual([expect.objectContaining({ unread_messages: 3, unread_directed: 2 })]);
    expect(service.getDirectedMessages({ room_id: room.room_id, agent_id: "human:op", after_event_seq: start })
      .map((event) => (event.payload as { body: string }).body)).toEqual(["to op", "to both"]);
    expect(formatRoomStrip([
      { name: "web", directed: 0 }, { name: "api", directed: 1 }, { name: "docs", directed: 0 }
    ], { color: false, name_of: (id: string) => id } as never)).toBe("#api 1@ · #docs · #web");
  });

  test("an explicit room declared only on a worktree branch keeps the repository's strip", async () => {
    const { root, service } = setupService();
    const main = path.join(root, "main");
    fs.mkdirSync(main);
    const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    git("config", "user.name", "Test"); git("config", "user.email", "t@example.com");
    fs.writeFileSync(path.join(main, "README"), "x\n");
    git("add", "-A"); git("commit", "-q", "-m", "init");
    const wt = path.join(root, "wt");
    git("worktree", "add", "-q", "-b", "feat", wt);
    fs.mkdirSync(path.join(wt, "pkg", ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(wt, "pkg", ".talking-stick", "room.toml"), "");
    const rootRoom = service.joinPath({ agent_id: "claude:root", context_path: main });
    const pkgRoom = service.joinPath({ agent_id: "codex:pkg", context_path: path.join(wt, "pkg") });
    expect(pkgRoom.canonical_path).toBe(path.join(main, "pkg"));
    expect(fs.existsSync(path.join(main, "pkg"))).toBe(false);

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const run = runChatConsole({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: observerIdentity(), context_path: wt, room_id: pkgRoom.room_id, input, output,
      terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5
    });
    await until(() => transcript.includes("In the room: codex"));
    input.write("/rooms\n");
    await until(() => transcript.includes("#main"));
    input.write("/quit\n");
    await run;
    expect(rootRoom.room_id).not.toBe(pkgRoom.room_id);
  });

  test("a nested Git repository below the console's repository is not in its strip", async () => {
    const { root, service } = setupService();
    const outer = path.join(root, "outer");
    const inner = path.join(outer, "vendor", "inner");
    fs.mkdirSync(inner, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", outer]);
    execFileSync("git", ["init", "-q", "-b", "main", inner]);
    service.joinPath({ agent_id: "claude:outer", context_path: outer });
    const innerRoom = service.joinPath({ agent_id: "codex:inner", context_path: inner });
    expect(innerRoom.canonical_path).toBe(inner);

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const run = runChatConsole({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: observerIdentity(), context_path: outer, input, output,
      terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5
    });
    await until(() => transcript.includes("In the room: claude"));
    input.write("/rooms\n");
    await until(() => transcript.includes("Active rooms on this host"));
    expect(transcript).toContain("#inner"); // Host navigation includes nested repositories; the strip remains local.
    input.write("/quit\n");
    await run;
  });

  test("a room chosen from another repository brings that repository's strip, and /go stays inside it", async () => {
    const { root, service } = setupService();
    const here = path.join(root, "here");
    const other = path.join(root, "other");
    for (const repo of [here, other]) {
      fs.mkdirSync(path.join(repo, "api"), { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
    }
    fs.mkdirSync(path.join(other, "api", ".talking-stick"));
    fs.writeFileSync(path.join(other, "api", ".talking-stick", "room.toml"), "");
    service.joinPath({ agent_id: "claude:here", context_path: here });
    const otherRoot = service.joinPath({ agent_id: "codex:other", context_path: other });
    service.joinPath({ agent_id: "grok:api", context_path: path.join(other, "api") });

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const run = runChatConsole({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity: observerIdentity(), context_path: here, room_id: otherRoot.room_id, input, output,
      terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5
    });
    await until(() => transcript.includes("In the room: codex"));
    input.write("/rooms\n");
    await until(() => transcript.includes("#api"));
    expect(transcript).toContain(here); // /rooms is host-wide even when the strip is anchored elsewhere.
    input.write(`/go ${here}\n`);
    await until(() => transcript.includes("belongs to another repository"));
    // A relative directory resolves in the active room's repository, not the caller's.
    fs.mkdirSync(path.join(other, "docs", ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(other, "docs", ".talking-stick", "room.toml"), "");
    fs.mkdirSync(path.join(here, "docs"), { recursive: true });
    input.write("/go docs\n");
    await until(() => service.listRooms({}).rooms.some((room) => room.canonical_path === path.join(other, "docs")));
    expect(service.listRooms({}).rooms.some((room) => room.canonical_path === path.join(here, "docs"))).toBe(false);
    input.write("/quit\n");
    await run;
  });

  test("strip names fall back to the shortest unique path suffix", () => {
    const names = uniqueRoomNames([
      { room_id: "r", canonical_path: "/repo" },
      { room_id: "a", canonical_path: "/repo/web/api" },
      { room_id: "b", canonical_path: "/repo/svc/api" },
      { room_id: "d", canonical_path: "/repo/docs" }
    ], "/repo");
    expect([...names.values()]).toEqual(["root", "web/api", "svc/api", "docs"]);
  });

  test("switches rooms with /go, keeps memberships until exit, and lists rooms with agents", async () => {
    const { root, service } = setupService();
    const api = path.join(root, "api");
    fs.mkdirSync(path.join(api, ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(api, ".talking-stick", "room.toml"), 'name = "api"\n');
    const rootRoom = service.joinPath({ agent_id: "claude:root", context_path: root });
    const apiRoom = service.joinPath({ agent_id: "codex:api", context_path: api });
    expect(apiRoom.room_id).not.toBe(rootRoom.room_id);

    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => { transcript += chunk.toString(); });
    const identity = observerIdentity();
    const consoleRun = runChatConsole({
      runtime: { commands: new TalkingStickCommands(service), close: () => {} },
      identity, context_path: root, input, output,
      terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5
    });
    await until(() => transcript.includes("In the room: claude"));
    service.sendMessage({ agent_id: "codex:api", room_id: apiRoom.room_id, body: "api note" });
    // Listed rooms are joined as an observer, so an agent there can address
    // the operator; that message appears inline in the current room.
    const members = (roomId: string) => service.getRoomState({ room_id: roomId }).members.map((member) => member.agent_id);
    await until(() => members(apiRoom.room_id).includes(identity.agent_id));
    service.sendMessage({ agent_id: "codex:api", room_id: apiRoom.room_id, body: "ping op", to_agent_id: identity.agent_id });
    await until(() => transcript.includes("#api › codex → you: ping op"));

    input.write("/rooms\n");
    await until(() => transcript.includes("#api"));
    expect(transcript).toContain("Open with /rooms <room-id>");

    input.write("/go api\n");
    await until(() => transcript.includes("In the room: codex"));
    expect(transcript).toContain("api note");
    input.write("hello api\n");
    await until(() => service.getRecentRoomEvents({ room_id: apiRoom.room_id, limit: 10 })
      .some((event) => (event.payload as { body?: string } | null)?.body === "hello api"));

    expect(members(rootRoom.room_id)).toContain(identity.agent_id);

    // A committed declaration nobody has joined here has no room yet; /go by
    // directory opens it.
    const docs = path.join(root, "docs");
    fs.mkdirSync(path.join(docs, ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(docs, ".talking-stick", "room.toml"), "");
    input.write("/go #docs\n");
    await until(() => transcript.includes("No open room matches #docs"));
    input.write("/go docs\n");
    await until(() => service.listRooms({}).rooms.some((room) => room.canonical_path === docs));
    await until(() => members(service.listRooms({}).rooms.find((room) => room.canonical_path === docs)!.room_id).includes(identity.agent_id));

    input.write("/go root\n");
    await until(() => transcript.split("In the room: claude").length > 2);
    // The visit to #api already showed "ping op"; switching away must not replay it inline.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(transcript.split("#api › codex → you: ping op").length).toBe(2);
    input.write("/quit\n");
    await consoleRun;
    expect(members(rootRoom.room_id)).not.toContain(identity.agent_id);
    expect(members(apiRoom.room_id)).not.toContain(identity.agent_id);
  });

  test("inline /go picker and room keys switch into an open room without agents", async () => {
    const { root, service } = setupService();
    const api = path.join(root, "api");
    fs.mkdirSync(path.join(api, ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(api, ".talking-stick", "room.toml"), 'name = "api"\n');
    service.joinPath({ agent_id: "claude:root", context_path: root });
    const apiRoom = service.openRoom({ context_path: api });
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 16 });
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const identity = observerIdentity();
    const session = runChatConsole({
      runtime: { commands: new TalkingStickCommands(service), close() {} }, identity,
      context_path: root, input, output, terminal: true, inline: true,
      color: false, history: 0, show_turn_events: false, poll_ms: 5
    });
    try {
      await until(() => text.includes("Type to message the room"));
      input.write("/go");
      await until(() => text.includes("#api"));
      input.write("\r");
      await until(() => text.includes("In the room: no agents yet"));
      expect(service.getRoomState({ room_id: apiRoom.room_id }).members.map((member) => member.agent_id))
        .toContain(identity.agent_id);
      input.write("\u001b[5;5~"); // Ctrl+PageUp, works when Alt+Arrow is captured by the terminal.
      await until(() => text.split("In the room: claude").length > 2);
      input.write("\u001bf"); // macOS Option+Right encoding.
      await until(() => text.split("In the room: no agents yet").length > 2);
    } finally {
      input.write("/quit\r");
      await session;
    }
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
    expect(transcript).toMatch(/\n\nyou → codex  \d\d:\d\d\n  hello team\n/);
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
    // Two matching sessions share one message that lists both, never a copy each.
    const both = () => service
      .getRoomEvents({ room_id: joined.room_id, include_all: true })
      .filter((event) => event.payload?.body === "check both sessions");
    await until(() => both().length === 1);
    expect(both()[0].to_agent_id).toBeNull();
    expect([...(both()[0].payload?.recipients as string[])].sort()).toEqual(["codex:aa", "codex:bb"]);
    service.leaveRoom({ agent_id: "codex:bb", room_id: joined.room_id });

    service.joinPath({ agent_id: "claude:cc", context_path: root });
    input.write("ping @codex:aa and @claude about it\n");
    const mentioned = () =>
      service
        .getRoomEvents({ room_id: joined.room_id, include_all: true })
        .filter((event) => event.payload?.body === "ping @codex:aa and @claude about it");
    await until(() => mentioned().length === 1);
    expect([...(mentioned()[0].payload?.recipients as string[])].sort()).toEqual(["claude:cc", "codex:aa"]);
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
    // The first gone reading after a long silence only starts the grace.
    expect(service.getRoomState({ room_id: owner.room_id, include_all: true }).members
      .map((member) => member.agent_id)).toContain("codex:old");
    clock = new Date("2026-09-15T12:31:00.000Z");
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

describe("first gone reading", () => {
  const setup = () => {
    let clock = new Date("2026-09-15T10:00:00.000Z");
    let reading: ProcessLiveness = "alive";
    let onInspect = () => {};
    const { root, service } = setupService({
      now: () => clock,
      policy: { waitForEventsPollMs: 1, idleRoomTtlMs: 0 },
      processLivenessChecker: (metadata: ProcessMetadata) => {
        if (metadata.harness_session_id !== "silent") return "alive";
        onInspect();
        // The refreshed process in the identity test cannot be read.
        return metadata.harness_process_started_at === "later" ? "unknown" : reading;
      }
    });
    const metadata: ProcessMetadata = {
      host_id: "h", pid: 1, process_started_at: "t", session_kind: "harness_cli",
      harness_name: "codex", harness_session_id: "silent", harness_host_id: "h",
      harness_pid: 2, harness_process_started_at: "t"
    };
    const room = service.joinPath({ agent_id: "codex:silent", context_path: root, process_metadata: metadata });
    // Any later RPC runs the cleanup pass.
    const at = (iso: string, liveness: ProcessLiveness) => {
      clock = new Date(iso);
      reading = liveness;
      service.joinPath({ agent_id: "human:probe", context_path: root });
      return service.getRoomState({ room_id: room.room_id, include_all: true }).members
        .some((member) => member.agent_id === "codex:silent");
    };
    const observations = () => service.db.prepare("SELECT * FROM member_gone_observations").all();
    return { service, root, metadata, at, observations, setInspect: (fn: () => void) => { onInspect = fn; } };
  };

  test("a 24h-silent member survives one gone reading and is removed only after a full grace", () => {
    const { at, observations } = setup();
    expect(at("2026-09-16T10:00:00.000Z", "gone")).toBe(true);
    expect(observations()).toHaveLength(1);
    expect(at("2026-09-16T10:59:00.000Z", "gone")).toBe(true);
    expect(at("2026-09-16T11:01:00.000Z", "gone")).toBe(false);
  });

  test("an alive reading clears the observation and an unknown reading keeps it", () => {
    const { at, observations } = setup();
    at("2026-09-16T10:00:00.000Z", "gone");
    expect(at("2026-09-16T10:30:00.000Z", "unknown")).toBe(true);
    expect(observations()).toHaveLength(1);
    expect(at("2026-09-16T11:01:00.000Z", "gone")).toBe(false);

    const second = setup();
    second.at("2026-09-16T10:00:00.000Z", "gone");
    second.at("2026-09-16T10:30:00.000Z", "alive");
    expect(second.observations()).toHaveLength(0);
    expect(second.at("2026-09-16T11:01:00.000Z", "gone")).toBe(true);
    expect(second.at("2026-09-16T12:02:00.000Z", "gone")).toBe(false);
  });

  test("the session's own later tt use voids an earlier gone reading", () => {
    const { service, root, metadata, at } = setup();
    at("2026-09-16T10:00:00.000Z", "gone");
    at("2026-09-16T10:30:00.000Z", "unknown");
    service.joinPath({ agent_id: "codex:silent", context_path: root, process_metadata: metadata });
    expect(at("2026-09-16T11:31:00.000Z", "gone")).toBe(true);
    expect(at("2026-09-16T12:32:00.000Z", "gone")).toBe(false);
  });

  test("an idle room is kept while a member is inside its gone grace", () => {
    let clock = new Date("2026-09-15T10:00:00.000Z");
    let otherReads = 0;
    let clearDuringRetainCheck = false;
    const { root, service } = setupService({
      now: () => clock,
      policy: { waitForEventsPollMs: 1, idleRoomTtlMs: 7 * 24 * 60 * 60_000 },
      processLivenessChecker: (metadata: ProcessMetadata) => {
        if (metadata.harness_session_id !== "other") return "gone";
        // The second read of "other" in a pass is the idle-room retention check,
        // after this pass has validated the observation of "silent".
        if (++otherReads % 2 === 0 && clearDuringRetainCheck) {
          service.db.prepare("DELETE FROM member_gone_observations WHERE agent_id = 'codex:silent'").run();
        }
        return "unknown";
      }
    });
    const metadata = (session: string): ProcessMetadata => ({
      host_id: "h", pid: 1, process_started_at: "t", session_kind: "harness_cli",
      harness_name: "codex", harness_session_id: session, harness_host_id: "h",
      harness_pid: 2, harness_process_started_at: "t"
    });
    const room = service.joinPath({ agent_id: "codex:silent", context_path: root, process_metadata: metadata("silent") });
    service.joinPath({ agent_id: "codex:other", context_path: root, process_metadata: metadata("other") });
    const pass = (iso: string) => {
      clock = new Date(iso);
      try { service.getRoomEventsView({ room_id: room.room_id, include_all: false }); } catch { /* expired */ }
      return service.db.prepare("SELECT agent_id FROM room_members").all().map((row) => (row as { agent_id: string }).agent_id).sort();
    };
    expect(pass("2026-09-23T10:00:00.000Z")).toEqual(["codex:other", "codex:silent"]);
    // Another pass's alive reading clears the observation mid-pass; this pass must not delete.
    clearDuringRetainCheck = true;
    expect(pass("2026-09-23T11:01:00.000Z")).toEqual(["codex:other", "codex:silent"]);
    clearDuringRetainCheck = false;
    pass("2026-09-23T12:02:00.000Z");
    expect(pass("2026-09-23T13:03:00.000Z")).toEqual([]);
  });

  test("an identity refresh during the inspection does not start the new process's timer", () => {
    const { service, at, observations, setInspect } = setup();
    setInspect(() => {
      setInspect(() => {});
      service.db.prepare(
        "UPDATE room_members SET harness_process_started_at = 'later' WHERE agent_id = 'codex:silent'").run();
    });
    expect(at("2026-09-16T10:00:00.000Z", "gone")).toBe(true);
    expect(observations()).toHaveLength(0);
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

test("a quiet room removes the transient empty-Escape hint after three seconds", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "grok:aa", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 12 });
  let out = "";
  output.on("data", (chunk) => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline: true, color: false, history: 0, show_turn_events: false, poll_ms: 10
  });
  try {
    await until(() => out.includes("> "));
    input.write("\u001b");
    await until(() => out.includes("nothing to interrupt"));
    out = "";
    await until(() => out.includes("/ for commands"), 5_000);
    expect(out).not.toContain("nothing to interrupt");
    expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true })
      .filter((event) => event.event_type === "message_sent")).toEqual([]);
  } finally {
    input.write("/quit\r");
    await session;
  }
});

test.each([true, false])("terminal starts reading in raw mode and restores it with Herdr scroll (inline=%s)", async inline => {
  const nativeScroll = await import("../src/cli/native-scroll.js");
  const close = vi.fn();
  const subscribe = vi.spyOn(nativeScroll, "subscribePaneScroll").mockReturnValue({ close });
  const { root, service } = setupService();
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; }
  });
  const rawAtListener: boolean[] = [];
  const rawAtResume: boolean[] = [];
  input.on("newListener", event => { if (event === "data") rawAtListener.push(input.isRaw); });
  const resume = input.resume.bind(input);
  const resumed = vi.spyOn(input, "resume").mockImplementation(() => {
    rawAtResume.push(input.isRaw);
    return resume();
  });
  const output = Object.assign(new PassThrough(), { columns: 89, rows: 24 });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline, color: false, history: 0, show_turn_events: false, poll_ms: 5,
    herdr: { pane_id: "test-pane", socket_path: "test-socket", runner: () => { throw new Error("no plugin"); } }
  });
  try {
    await until(() => bytes.includes("Type to message the room"));
    expect(rawAtListener.length).toBeGreaterThan(0);
    expect(rawAtResume.length).toBeGreaterThan(0);
    expect(rawAtListener.every(Boolean)).toBe(true);
    expect(rawAtResume.every(Boolean)).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(inline ? 1 : 0);
  } finally {
    input.write("/quit\r");
    await session;
    resumed.mockRestore();
    subscribe.mockRestore();
  }
  expect(input.isRaw).toBe(false);
  expect(close).toHaveBeenCalledTimes(inline ? 1 : 0);
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
    // The reserved suggestion rows are above the room bar. Move back only
    // to that fixed panel start, never into the transcript.
    expect(out.startsWith("\r\u001b[5A\u001b[J")).toBe(true);
    expect(out).toContain("first");
    expect(out).toContain("second");
  } finally {
    input.write("\u0003/quit\r");
    await session;
  }
  expect(out).toContain("\u001b[?2004l");
  // The startup cursor-row query toggles raw mode once before the editor does.
  expect(rawModes).toEqual([true, false, true, false]);
});

test("inline menus keep the footer pinned and new output reclaims their blank rows", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:anchor", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data)); // Answer the startup cursor-position query.
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: 28 }, (_, i) =>
    vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const session = runChatConsole({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    await flush();
    const footer = screen()[27];
    expect(footer, JSON.stringify(screen())).not.toBe("");
    for (const command of ["rooms", "members", "roles", "rooms"]) {
      input.write(`/${command}\r`);
      await flush();
      expect(screen()[27]).not.toBe("");
      input.write("\u001b");
      await new Promise(resolve => setTimeout(resolve, 60));
      await flush();
      expect(screen()[27]).toBe(footer);
      expect(screen().filter(line => line.startsWith("> "))).toHaveLength(1);
    }
    const base = vt.buffer.active.baseY;
    service.sendMessage({ agent_id: "codex:anchor", room_id: joined.room_id, body: "fills-menu-gap" });
    await until(() => bytes.includes("fills-menu-gap"));
    await flush();
    expect(screen().join("\n")).toContain("fills-menu-gap");
    expect(screen()[27]).toBe(footer);
    expect(vt.buffer.active.baseY).toBe(base);
  } finally {
    input.end(); await session; vt.dispose();
  }
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
    expect(vt.buffer.active.baseY).toBe(beforeMenu);
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
    // Pending and manual-standby recipients both show the pending mark.
    await until(() => bytes.includes("first message") && bytes.includes("you → codex …"));
    input.write("unfinished draft");
    await flush();
    const history = vt.buffer.active.baseY;
    await service.waitForTurn({ agent_id: "codex:aa", room_id: joined.room_id, max_wait_ms: 0,
      mode: "parked", include_events: true, after_event_seq: 0 });
    await until(() => bytes.includes("codex ✓"));
    await flush();
    expect(text()).toContain("you → codex ✓");
    expect(text()).not.toContain("codex …");
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
    await until(() => bytes.includes("codex ✓"));
    await flush();
    let rendered = lines();
    // Icons sit on each message's own header, directly above its body.
    let firstRow = rendered.findIndex(line => line.includes("first distinct message"));
    let secondRow = rendered.findIndex(line => line.includes("second distinct message"));
    expect(rendered[firstRow - 1]).toContain("you → codex …");
    expect(rendered[secondRow - 1]).toContain("you → codex ✓");
    const roomBar = rendered.length - 1 - [...rendered].reverse().findIndex(line => line.includes("Room ·"));
    if (inline) expect(rendered.slice(roomBar).join("\n")).not.toMatch(/[✓…]|delivered/);
    expect(rendered.join("\n")).toContain("> unfinished draft");
    if (inline) {
      vt.resize(60, 32); output.columns = 60; output.emit("resize");
      await flush();
    }
    bytes = "";
    service.db.prepare("INSERT INTO message_receipts (room_id, agent_id, event_seq, delivered_at) VALUES (?, ?, ?, ?)")
      .run(joined.room_id, "codex:aa", first.event_seq, new Date().toISOString());
    await until(() => bytes.includes("codex ✓"));
    await flush();
    rendered = lines();
    firstRow = rendered.findIndex(line => line.includes("first distinct message"));
    secondRow = rendered.findIndex(line => line.includes("second distinct message"));
    expect(rendered[firstRow - 1]).toContain("you → codex ✓");
    expect(rendered[secondRow - 1]).toContain("you → codex ✓");
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
    await until(() => /→ codex ✓  \d\d:\d\d\r\n  old delivered/.test(bytes));
    expect(bytes).toMatch(/→ codex  \d\d:\d\d\r\n  old unread/);
    expect(bytes).not.toContain("codex …");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toHaveLength(2);
  } finally { input.write("\u0004"); await session; }
});

test("a plain chat message is one room message that reports every agent", async () => {
  const { root, service } = setupService({ nativeWakeTransport: { deliver() { return { outcome: "queued" }; } } });
  const joined = service.joinPath({ agent_id: "claude:aa", context_path: root, process_metadata: { harness_session_id: "aa" } });
  service.joinPath({ agent_id: "codex:bb", context_path: root, process_metadata: { harness_session_id: "bb" } });
  service.registerNativeWakeEndpoint({ room_id: joined.room_id, agent_id: "claude:aa", transport: "claude_inbox",
    address: "aa", secret: "private", harness_session_id: "aa", host_id: os.hostname() });
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: false, color: false, history: 0,
    show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => transcript.includes("Talking Stick chat"));
    input.write("status everyone\n");
    await until(() => transcript.includes("claude: queued") && transcript.includes("codex: not acknowledged yet"));
    const copies = service.getRoomEvents({ room_id: joined.room_id, include_all: true })
      .filter((event) => event.payload?.body === "status everyone");
    expect(copies).toHaveLength(1);
    expect(copies[0].to_agent_id).toBeNull();

    input.write("@everyone again\n");
    await until(() => service.getRoomEvents({ room_id: joined.room_id, include_all: true })
      .some((event) => event.payload?.body === "again"));
    expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true })
      .filter((event) => event.payload?.body === "again").map((event) => event.to_agent_id)).toEqual([null]);
  } finally {
    input.write("/quit\n");
    await session;
  }
});

test.each([100, 18])("a room message header updates delivery marks across wrapped rows (width=%s)", async (columns) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "claude:aa", context_path: root });
  service.joinPath({ agent_id: "codex:bb", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns, rows: 24 });
  const vt = new Terminal({ cols: columns, rows: 24, allowProposedApi: true });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("[0m", resolve));
  const text = () => Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.length > 0);
    input.write("status everyone\r");
    await until(() => bytes.replace(/\s/g, "").includes("you→claude…,codex…"));
    const sent = service.getRoomEvents({ room_id: joined.room_id, include_all: true }).find(event => event.payload?.body === "status everyone")!;
    input.write("draft");
    service.db.prepare("INSERT INTO message_receipts (room_id, agent_id, event_seq, delivered_at) VALUES (?, ?, ?, ?)")
      .run(joined.room_id, "codex:bb", sent.event_seq, new Date().toISOString());
    await until(() => bytes.includes("✓"));
    await flush();
    const screen = text();
    expect(screen.replace(/\s/g, "")).toContain("you→claude…,codex✓");
    expect(screen.match(/status everyone/g)).toHaveLength(1);
    expect(screen).not.toMatch(/delivered|queued/);
    expect(screen).toContain("> draft");
  } finally { input.write(""); await session; vt.dispose(); }
});

test("/roles opens a key-driven editor; Enter applies and tells only the changed agent", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "claude:aa", context_path: root });
  service.joinPath({ agent_id: "codex:bb", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 20 });
  let out = "";
  output.on("data", (chunk) => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline: true, color: false, history: 0, show_turn_events: false, poll_ms: 5
  });
  await until(() => out.includes("Room"));
  input.write("/roles\r");
  await until(() => out.includes("Roles v0"));
  // codex row, reviewer column, toggle on, apply.
  input.write("\u001b[B");
  input.write("\u001b[C\u001b[C");
  input.write(" ");
  input.write("\r");
  await until(() => service.getRoomRoles({ room_id: joined.room_id }).version === 1);
  expect(service.getRoomRoles({ room_id: joined.room_id }).assignments)
    .toEqual([{ subject: "agent:codex:bb", roles: ["implementer", "reviewer"] }]);
  await until(() => out.includes("Roles applied; told 1 agent"));
  const messages = service.getRecentRoomEvents({ room_id: joined.room_id, limit: 20 })
    .filter((event) => event.event_type === "message_sent");
  expect(messages).toHaveLength(1);
  expect(messages[0].to_agent_id).toBe("codex:bb");
  // Apply keeps the same cell: toggling again removes that exact assignment.
  out = "";
  input.write(" "); input.write("\r");
  await until(() => out.includes("Roles applied; told 1 agent"));
  expect(service.getRoomRoles({ room_id: joined.room_id }).version).toBe(2);
  expect(service.getRoomRoles({ room_id: joined.room_id }).assignments)
    .toEqual([{ subject: "agent:codex:bb", roles: ["implementer"] }]);
  input.write("q");
  input.write("/quit\r");
  await session;
});


test.each([true, false])("/members confirms exact-session removal without sending modal keys (inline=%s)", async (inline) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  service.joinPath({ agent_id: "codex:bb", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 20 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, inline, color: false, history: 0, show_turn_events: false, poll_ms: 5
  });
  await until(() => out.includes("Room"));
  input.write("/members\r");
  await until(() => out.includes("Room members"));
  input.write("\u001b[B\r\u001b[B\r");
  await until(() => out.includes("harness keeps running"));
  expect(service.getRoomState({ room_id: joined.room_id }).members.some(m => m.agent_id === "codex:bb")).toBe(true);
  input.write("\u001b[B\r");
  await until(() => !service.getRoomState({ room_id: joined.room_id }).members.some(m => m.agent_id === "codex:bb"));
  expect(service.getRoomState({ room_id: joined.room_id }).members.some(m => m.agent_id === "codex:aa")).toBe(true);
  expect(service.getRecentRoomEvents({ room_id: joined.room_id, limit: 30 }).filter(e => e.event_type === "message_sent")).toHaveLength(0);
  input.write("/quit\r");
  await session;
});

test("status hit offsets exclude truncation and include wide display names", () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:aa", context_path: root });
  service.joinPath({ agent_id: "codex:bb", context_path: root });
  const status = { members: service.getRoomState({ room_id: joined.room_id }).members, owner: null, owner_since: null, reserved_for: null, now: new Date(), columns: 80 };
  const context = { self_agent_id: "human:op", name_of: () => "界", color: false, show_turn_events: false };
  const hits: Array<[string, number, number]> = [];
  const line = formatChatStatus(status, context, (...hit) => hits.push(hit));
  expect(hits).toHaveLength(2);
  expect(hits[0][1]).toBe(0);
  expect(hits[1][1]).toBe(hits[0][2] + 3);
  expect(hits[0][2]).toBeGreaterThan(line.split(" · ")[0].length);
  const narrow: string[] = [];
  expect(formatChatStatus({ ...status, columns: 4 }, context, id => narrow.push(id))).toContain("+2");
  expect(narrow).toEqual([]);
});

test("right-clicking a footer member preserves the draft when addressing a message", async () => {
  const { root, service } = setupService();
  service.joinPath({ agent_id: "codex:aa", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 20 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatSession({
    runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output,
    terminal: true, mouse: true, color: false, history: 0, show_turn_events: false, poll_ms: 5
  });
  await until(() => out.includes("Room"));
  input.write("keep this draft");
  input.write("\u001b[<2;1;20M");
  await until(() => out.includes("Remove from room"));
  input.write("\r");
  await until(() => out.includes("@codex:aa keep this draft"));
  input.write("\u0003/quit\r");
  await session;
});


test.each([true, false])("host navigator searches without joining, opens another repository and loads its clear floor (inline=%s)", async inline => {
  const { root, service } = setupService();
  const here = path.join(root, "here");
  const target = path.join(root, "target");
  for (const dir of [here, target]) {
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
  }
  const source = service.joinPath({ agent_id: "claude:here", context_path: here });
  const remote = service.joinPath({ agent_id: "codex:target", context_path: target });
  const oldConsole = "human:op:chat:dddddddd";
  service.joinPath({ agent_id: oldConsole, context_path: target, process_metadata: { session_kind: "human_chat" } });
  service.sendMessage({ agent_id: "codex:target", room_id: remote.room_id, body: "hidden target history" });
  service.clearHumanChat({ room_id: remote.room_id, agent_id: oldConsole });
  service.leaveRoom({ room_id: remote.room_id, agent_id: oldConsole });
  service.sendMessage({ agent_id: "codex:target", room_id: remote.room_id, body: "fresh target history" });
  const before = service.getRoomState({ room_id: remote.room_id }).members;
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 140, rows: 24 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const identity = observerIdentity();
  const session = runChatConsole({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity, context_path: here, room_id: source.room_id, input, output, terminal: true, inline,
    color: false, history: 20, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => out.includes("Type to message the room"));
    input.write("\u0014");
    await until(() => out.includes("Folders · Tab rooms"));
    input.write("\t");
    await until(() => out.includes("Rooms · Active"));
    input.write("/target");
    await until(() => out.includes("Filter › target"));
    expect(service.getRoomState({ room_id: remote.room_id }).members).toEqual(before);
    expect(identity.agent_id).not.toBe(oldConsole);
    input.write("\r");
    await until(() => service.getRoomState({ room_id: remote.room_id }).members.some(member => member.agent_id === identity.agent_id));
    await until(() => out.includes("fresh target history"));
    expect(out).not.toContain("hidden target history");
    fs.mkdirSync(path.join(target, "docs", ".talking-stick"), { recursive: true });
    fs.writeFileSync(path.join(target, "docs", ".talking-stick", "room.toml"), "");
    input.write("/go docs\r");
    await until(() => service.listRooms({}).rooms.some(room => room.canonical_path === path.join(target, "docs")));
    expect(service.listRooms({}).rooms.some(room => room.canonical_path === path.join(here, "docs"))).toBe(false);
  } finally { input.end(); await session; }
});

test.each([true, false])("room tree opens a directory and creates its room only after confirmation (inline=%s)", async (inline) => {
  const { root, service } = setupService();
  execFileSync("git", ["init", "-q", root]);
  const child = path.join(root, "empty");
  fs.mkdirSync(child);
  service.joinPath({ agent_id: "claude:root", context_path: root });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 20 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatConsole({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => out.includes("Room"));
    input.write("\u0014");
    await until(() => out.includes("Folders ·"));
    input.write("\u001b[Bn");
    await until(() => out.includes("Create a room boundary?"));
    expect(fs.existsSync(path.join(child, ".talking-stick", "room.toml"))).toBe(false);
    input.write("n");
    input.write("n");
    input.write("y");
    await until(() => fs.existsSync(path.join(child, ".talking-stick", "room.toml")));
    await until(() => service.listRooms({}).rooms.some(room => room.canonical_path === child &&
      service.getRoomState({ room_id: room.room_id }).members.some(member => member.session_kind === "human_chat")));
    expect(service.listRooms({}).rooms.some(room => room.canonical_path === child)).toBe(true);
  } finally {
    input.write("\u0003/quit\r");
    await session;
  }
});

test.each([true, false])("/roles stages external-editor definitions and applies once (inline=%s)", async (inline) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "claude:editor", context_path: root });
  const script = path.join(root, "edit.sh");
  fs.writeFileSync(script, '#!/bin/sh\nprintf "New architect definition.\\n" > "$1"\n', { mode: 0o755 });
  const previous = process.env.VISUAL;
  process.env.VISUAL = script;
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  let out = "";
  output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline, color: false,
    history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => out.includes("Room"));
    input.write("/roles\r");
    await until(() => out.includes("Roles v0"));
    input.write("e");
    await until(() => out.includes("Draft updated"));
    expect(service.getRoomRoles({ room_id: joined.room_id }).version).toBe(0);
    expect(fs.existsSync(path.join(root, ".talking-stick", "instructions.md"))).toBe(false);
    input.write("\r");
    await until(() => service.getRoomRoles({ room_id: joined.room_id }).version === 1);
    await until(() => out.includes("Roles applied"));
    expect(fs.readFileSync(path.join(root, ".talking-stick", "instructions.md"), "utf8")).toContain("New architect definition.");
    const notices = service.getRecentRoomEvents({ room_id: joined.room_id, event_types: ["message_sent"], limit: 20 });
    expect(notices).toHaveLength(1);
    expect(notices[0].to_agent_id).toBe("claude:editor");
    expect(notices[0].payload?.body).toContain("New architect definition.");
  } finally {
    if (previous === undefined) delete process.env.VISUAL; else process.env.VISUAL = previous;
    input.end(); await session;
  }
});

test("invalid new-role text reopens intact instead of being lost", async () => {
  const { root, service } = setupService();
  service.joinPath({ agent_id: "claude:retry", context_path: root });
  const script = path.join(root, "retry.sh"), flag = path.join(root, "called"), capture = path.join(root, "reopened.md");
  fs.writeFileSync(script, `#!/bin/sh
if [ -f '${flag}' ]; then
  cp "$1" '${capture}'
  printf '## Roles\n\n### valid-role\nKeep this role.\n' > "$1"
else
  printf '## Roles\n\n### Bad Name!\nKeep my text.\n' > "$1"
  touch '${flag}'
fi
`, { mode: 0o755 });
  const previous = process.env.VISUAL;
  process.env.VISUAL = script;
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 28 });
  let out = ""; output.on("data", chunk => { out += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} }, identity: observerIdentity(),
    context_path: root, input, output, terminal: true, inline: true, color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => out.includes("Room")); input.write("/roles\r");
    await until(() => out.includes("Roles v0")); input.write("n");
    await until(() => out.includes("Press n again"));
    expect(out).not.toContain("role-name.. Press");
    input.write("n");
    await until(() => out.includes("Draft updated"));
    expect(fs.readFileSync(capture, "utf8")).toContain("### Bad Name!\nKeep my text.");
    expect(fs.existsSync(path.join(root, ".talking-stick", "instructions.md"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.VISUAL; else process.env.VISUAL = previous;
    input.end(); await session;
  }
});


test("/theme switches palettes locally and rejects unknown names without sending a message", async () => {
  const { root, service } = setupService();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: false, color: false,
    history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => text.includes("Talking Stick chat"));
    input.write("/theme tide\n");
    await until(() => text.includes("Theme: tide"));
    expect(chatThemeName()).toBe("tide");
    input.write("/theme missing\n");
    await until(() => text.includes('Unknown theme "missing"'));
    expect(chatThemeName()).toBe("tide");
    input.write("/theme dusk\n/theme\n");
    await until(() => text.includes("Theme: dusk"));
    expect(chatThemeName()).toBe("dusk");
    const room = service.listRooms({}).rooms.find(room => room.canonical_path === root)!;
    expect(service.getRoomEvents({ room_id: room.room_id, include_all: true })
      .filter(event => event.event_type === "message_sent")).toHaveLength(0);
  } finally { input.write("/quit\n"); await session; setChatTheme("lantern"); }
});

test.each([true, false])("/theme repaints existing visible content and keeps the composer anchored (inline=%s)", async (inline) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:paint", context_path: root });
  for (let i = 0; i < 25; i++) service.sendMessage({ agent_id: "codex:paint", room_id: joined.room_id,
    body: `visible-theme-${i} #137` });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true, scrollback: 1000 });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const rows = () => Array.from({ length: 28 }, (_, i) =>
    vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const referenceColor = () => {
    const y = rows().findIndex(row => row.includes("visible-theme-24 #137"));
    expect(y).toBeGreaterThanOrEqual(0);
    const line = vt.buffer.active.getLine(vt.buffer.active.baseY + y)!;
    return line.getCell(line.translateToString(true).indexOf("#137"))!.getFgColor();
  };
  const previousColorTerm = process.env.COLORTERM;
  process.env.COLORTERM = "";
  setChatTheme("lantern");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 20, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("visible-theme-24"));
    await flush();
    expect(referenceColor()).toBe(110);
    const composerRow = rows().findIndex(row => row.startsWith("> "));
    const oldest = vt.buffer.active.getLine(0)?.translateToString(true);
    for (const [name, color] of [["dusk", 147], ["tide", 110], ["lantern", 110]] as const) {
      bytes = "";
      input.write(`/theme ${name}\r`);
      await until(() => bytes.includes(`Theme: ${name}`));
      await new Promise(resolve => setTimeout(resolve, 30));
      await flush();
      expect(referenceColor()).toBe(color);
      expect(rows().findIndex(row => row.startsWith("> "))).toBe(composerRow);
      expect(rows().filter(row => row.includes("visible-theme-24"))).toHaveLength(1);
      expect(bytes).not.toContain("\u001b[3J");
      if (inline) expect(vt.buffer.active.getLine(0)?.translateToString(true)).toBe(oldest);
    }
  } finally {
    input.end(); await session; vt.dispose(); setChatTheme("lantern");
    if (previousColorTerm === undefined) delete process.env.COLORTERM; else process.env.COLORTERM = previousColorTerm;
  }
});

test("human acknowledgement is explicit, durable across console sessions and scoped to the recipient", async () => {
  const { root, service } = setupService();
  const first = "human:op:chat:aaaaaaaa";
  const second = "human:op:chat:bbbbbbbb";
  const other = "human:other:chat:cccccccc";
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  for (const id of [first, second, other]) service.joinPath({ agent_id: id, context_path: root,
    process_metadata: { session_kind: "human_chat" } });
  const direct = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: first, body: "needs attention" });
  const broadcast = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: "ordinary broadcast" });
  service.sendMessage({ agent_id: first, room_id: joined.room_id, to_agent_id: second, body: "own console" });
  service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: other, body: "other user" });
  const read = () => service.getHumanAttention({ room_id: joined.room_id, human_id: second });
  expect(read().messages.map(event => event.event_seq)).toEqual([direct.event_seq]);
  await service.waitForEvents({ room_id: joined.room_id, agent_id: first, target_agent_id: "self", after_event_seq: direct.event_seq - 1, max_wait_ms: 1 });
  expect(read().total).toBe(1); // Delivery is not a human acknowledgement.
  expect(() => service.acknowledgeHumanMessage({ room_id: joined.room_id, agent_id: other, event_seq: direct.event_seq })).toThrow();
  expect(() => service.acknowledgeHumanMessage({ room_id: joined.room_id, agent_id: second, event_seq: broadcast.event_seq })).toThrow();
  service.acknowledgeHumanMessage({ room_id: joined.room_id, agent_id: second, event_seq: direct.event_seq });
  service.acknowledgeHumanMessage({ room_id: joined.room_id, agent_id: second, event_seq: direct.event_seq });
  expect(read().total).toBe(0);
  expect(service.getHumanAttention({ room_id: joined.room_id, human_id: first }).total).toBe(0);
  const reopened = new TalkingStickService({ dbPath: path.join(root, ".state", "rooms.sqlite") });
  try { expect(reopened.getHumanAttention({ room_id: joined.room_id, human_id: first }).total).toBe(0); }
  finally { reopened.close(); }
  expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true }).some(event => event.event_seq === direct.event_seq)).toBe(true);
  // The migration's activation high-water excludes the pre-feature backlog.
  service.db.prepare("UPDATE human_attention_start SET event_seq = ?").run(service.globalEventSeq());
  const later = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: second, body: "new attention" });
  expect(read().messages.map(event => event.event_seq)).toEqual([later.event_seq]);
});

test.each([true, false])("unread control visits original messages oldest-first and acknowledges only each visit (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    mouse: true, color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    const first = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "first pinned request" });
    const second = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "second pinned request" });
    await until(() => bytes.includes("\u001b[?1000h"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    const matches = screen().map((line, index) => line.includes("first pinned request") ? index : -1).filter(index => index >= 0);
    expect(matches).toHaveLength(1);
    const composerRow = screen().findIndex(line => line.startsWith("> "));
    for (let i = 0; i < 12; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `scroll-pin-${i}` });
    await until(() => bytes.includes("scroll-pin-11"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    const promoted = screen().map((line, index) => line.includes("first pinned request") ? index : -1).filter(index => index >= 0);
    const y = screen().findIndex(line => line.includes("2 for you"));
    expect(y).toBeGreaterThanOrEqual(0);
    expect(promoted).toEqual([y]); // A one-line preview on the control, not a pinned copy.
    expect(screen().findIndex(line => line.startsWith("> "))).toBe(composerRow);
    input.write(`\u001b[<0;5;${y + 1}M`);
    await until(() => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total === 1);
    expect(service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages[0].event_seq).toBe(second.event_seq);
    await flush();
    expect(screen().filter(line => line.includes("first pinned request"))).toHaveLength(1);
    expect(screen().some(line => line.includes("scroll-pin-0"))).toBe(true);
    const nextY = screen().findIndex(line => line.includes("▲ 1 of 2"));
    expect(nextY).toBeGreaterThanOrEqual(0);
    input.write(`\u001b[<0;5;${nextY + 1}M`);
    await until(() => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total === 0);
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(screen().some(line => line.includes("second pinned request"))).toBe(true);
    expect(screen().some(line => line.includes("All caught up"))).toBe(true);
    input.write("\u001b");
    await new Promise(resolve => setTimeout(resolve, 80));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(screen().join("\n")).not.toContain("awaiting acknowledgement");
    expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true }).some(event => event.event_seq === second.event_seq)).toBe(true);
  } finally { input.end(); await session; vt.dispose(); }
});


test.each([true, false])("Ctrl-G visits only messages for the human, oldest first, and keeps the draft (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  service.joinPath({ agent_id: "claude:peer", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages.map(event => event.event_seq);
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    const first = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "first for op" });
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: "a broadcast to the room" });
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "claude:peer", body: "agent to agent" });
    const second = service.sendMessage({ agent_id: "claude:peer", room_id: joined.room_id, to_agent_id: "human:op", body: "second for op" });
    for (let i = 0; i < 30; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `chatter-${i}` });
    await until(() => bytes.includes("chatter-29"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    // Only the two messages addressed to the human count; nothing else does.
    expect(pending()).toEqual([first.event_seq, second.event_seq]);
    expect(screen().some(line => line.includes("2 for you"))).toBe(true);
    input.write("half typed");
    input.write("\u0007");
    await until(() => pending().length === 1);
    expect(pending()).toEqual([second.event_seq]);
    await flush();
    expect(screen().some(line => line.includes("first for op"))).toBe(true);
    input.write("\u0007");
    await until(() => pending().length === 0);
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(screen().some(line => line.includes("second for op"))).toBe(true);
    input.write("\u001b");
    await new Promise(resolve => setTimeout(resolve, 150)); await flush();
    expect(screen().some(line => line.includes("> half typed"))).toBe(true);
    input.write("\u0007");
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(screen().join("\n")).toContain("Nothing unread for you");
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([true, false])("Ctrl-G lands on one visible message for you per press (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages.map(event => event.event_seq);
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    const first = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "visible one" });
    const second = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "visible two" });
    await until(() => bytes.includes("visible two"));
    await new Promise(resolve => setTimeout(resolve, 30));
    input.write("\u0007");
    await until(() => pending().length === 1);
    expect(pending()).toEqual([second.event_seq]);
    input.write("\u0007");
    await until(() => pending().length === 0);
    expect(first.event_seq).toBeLessThan(second.event_seq);
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([true, false])("typing during a Ctrl-G review returns to the composer with the keys (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const sent = () => service.getRoomEvents({ room_id: joined.room_id, after_event_seq: 0, limit: 200 })
    .filter(event => event.event_type === "message_sent" && event.from_agent_id?.startsWith("human:")).length;
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "first for op" });
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "second for op" });
    await until(() => bytes.includes("second for op"));
    await new Promise(resolve => setTimeout(resolve, 30));
    input.write("half typed\u001b[D\u001b[D\u001b[D\u001b[D\u001b[D");
    await new Promise(resolve => setTimeout(resolve, 60));
    input.write("\u0007");
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(screen().join("\n")).toContain("type to reply");
    // The first key leaves the review; the whole chunk lands at the cursor.
    input.write("n q");
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(screen().join("\n")).not.toContain("type to reply");
    expect(screen().some(line => line.includes("> half n qtyped"))).toBe(true);
    // Enter leaves a review without sending the draft.
    input.write("\u0007");
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(screen().join("\n")).toContain("type to reply");
    input.write("\r");
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(screen().join("\n")).not.toContain("type to reply");
    expect(screen().some(line => line.includes("> half n qtyped"))).toBe(true);
    expect(sent()).toBe(0);
  } finally { input.end(); await session; vt.dispose(); }
});

test("the badge count matches the attention bar's count", () => {
  const { root, service } = setupService();
  const room = service.joinPath({ agent_id: "codex:aa", context_path: root });
  service.joinPath({ agent_id: "human:op:chat:deadbeef", context_path: root });
  service.joinPath({ agent_id: "claude:bb", context_path: root });
  service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, to_agent_id: "human:op:chat:deadbeef", body: "for op" });
  service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, body: "broadcast" });
  service.sendMessage({ agent_id: "codex:aa", room_id: room.room_id, to_agent_id: "claude:bb", body: "agents" });
  for (const human of ["human:op", "human:op:chat:0badc0de"]) {
    const input = { room_id: room.room_id, human_id: human };
    expect(service.countHumanAttention(input)).toBe(1);
    expect(service.countHumanAttention(input)).toBe(service.getHumanAttention(input).total);
  }
});

test("room badges count only messages for the human, across consoles, until acknowledged", async () => {
  const { root, service } = setupService();
  const api = path.join(root, "api");
  fs.mkdirSync(path.join(api, ".talking-stick"), { recursive: true });
  fs.writeFileSync(path.join(api, ".talking-stick", "room.toml"), 'name = "api"\n');
  service.joinPath({ agent_id: "claude:root", context_path: root });
  const apiRoom = service.joinPath({ agent_id: "codex:api", context_path: api });
  // Addressed to an earlier console of the same human, which has since left,
  // plus traffic that is not for them.
  service.joinPath({ agent_id: "human:op:chat:deadbeef", context_path: api });
  const earlier = service.sendMessage({ agent_id: "codex:api", room_id: apiRoom.room_id, to_agent_id: "human:op:chat:deadbeef", body: "for an older console" });
  service.leaveRoom({ room_id: apiRoom.room_id, agent_id: "human:op:chat:deadbeef" });
  service.joinPath({ agent_id: "claude:api", context_path: api });
  service.sendMessage({ agent_id: "codex:api", room_id: apiRoom.room_id, body: "broadcast" });
  service.sendMessage({ agent_id: "codex:api", room_id: apiRoom.room_id, to_agent_id: "claude:api", body: "agent to agent" });
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk.toString(); });
  const identity = observerIdentity();
  const run = runChatConsole({ runtime: { commands: new TalkingStickCommands(service), close: () => {} },
    identity, context_path: root, input, output,
    terminal: false, color: false, history: 10, show_turn_events: false, poll_ms: 5 });
  const roomsListing = async () => {
    const from = transcript.length;
    input.write("/rooms\n");
    await until(() => transcript.slice(from).includes("Open with /rooms"));
    return transcript.slice(from);
  };
  await until(() => transcript.includes("In the room: claude"));
  expect(await roomsListing()).toMatch(/api.* · 1 for you/);
  const members = () => service.getRoomState({ room_id: apiRoom.room_id }).members.map(member => member.agent_id);
  await until(() => members().includes(identity.agent_id));
  service.acknowledgeHumanMessage({ room_id: apiRoom.room_id, agent_id: identity.agent_id, event_seq: earlier.event_seq });
  expect(await roomsListing()).not.toContain("for you");
  input.write("/quit\n");
  await run;
});

test("browsing during an unread review never reads context, even after returning live", async () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages.map(event => event.event_seq);
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: false,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "landed target" });
    const context = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "context message" });
    for (let i = 0; i < 30; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `review-flow-${i}` });
    await until(() => bytes.includes("review-flow-29"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    input.write("/unread\r");
    await until(() => pending().length === 1);
    for (let i = 0; i < 6; i++) input.write("\u001b[B"); // Browse down across the context message.
    await new Promise(resolve => setTimeout(resolve, 30));
    input.write("\u001b"); // A lone Escape resolves after the key-sequence wait.
    await new Promise(resolve => setTimeout(resolve, 150)); await flush();
    expect(screen().some(line => line.includes("review-flow-29"))).toBe(true);
    input.write("\u001b[1;2A"); // A one-row live scroll near the tail crosses nothing old.
    await new Promise(resolve => setTimeout(resolve, 60)); await flush();
    expect(pending()).toEqual([context.event_seq]);
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([true, false].flatMap(inline => [undefined, false, true].map(mouse => ({ inline, mouse }))))(
  "pending pins capture mouse only with explicit --mouse (inline=$inline, mouse=$mouse)", async ({ inline, mouse }) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); });
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    mouse, color: false, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "keyboard acknowledgement" });
    await until(() => bytes.includes("keyboard acknowledgement"));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(bytes.includes("\u001b[?1000h")).toBe(mouse === true);
    expect(bytes.includes("\u001b[?1006h")).toBe(mouse === true);
    input.write("/ack\r");
    await until(() => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total === 0);
  } finally { input.end(); await session; }
});

test("upgrading to human attention starts at the migration high-water instead of old messages", () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  service.joinPath({ agent_id: "human:op", context_path: root, process_metadata: { session_kind: "human_chat" } });
  service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "pre-feature backlog" });
  service.db.exec("DROP TABLE human_message_acknowledgements; DROP TABLE human_attention_start; DELETE FROM schema_migrations WHERE id = 25");
  const upgraded = new TalkingStickService({ dbPath: path.join(root, ".state", "rooms.sqlite") });
  try {
    expect(upgraded.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total).toBe(0);
    upgraded.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "after activation" });
    expect(upgraded.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages[0].payload?.body).toBe("after activation");
  } finally { upgraded.close(); }
});

test("theme choices persist for the same human across sessions and database reopens", () => {
  const { root, service } = setupService();
  const first = "human:theme:chat:aaaaaaaa";
  const second = "human:theme:chat:bbbbbbbb";
  const joined = service.joinPath({ agent_id: first, context_path: root, process_metadata: { session_kind: "human_chat" } });
  service.setHumanChatTheme({ room_id: joined.room_id, agent_id: first, theme: "dusk" });
  const reopened = new TalkingStickService({ dbPath: path.join(root, ".state", "rooms.sqlite") });
  try {
    expect(reopened.getHumanChatTheme(second)).toBe("dusk");
    expect(reopened.getHumanChatTheme("human:another")).toBeUndefined();
    expect(() => reopened.setHumanChatTheme({ room_id: joined.room_id, agent_id: "codex:intruder", theme: "tide" })).toThrow();
    expect(reopened.getHumanChatTheme(first)).toBe("dusk");
  } finally { reopened.close(); }
});

test.each([true, false])("bare /ack dismisses all visible pins and clears the final transcript background (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" });
  const backgroundDefault = () => {
    const lines = Array.from({ length: 28 }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i));
    const line = lines.reverse().find(line => line?.translateToString(true).includes("last attention message"))!;
    expect(line).toBeDefined();
    return line.getCell(line.translateToString(true).indexOf("last attention message"))!.isBgDefault();
  };
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    for (let i = 0; i < 5; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id,
      to_agent_id: "human:op", body: i === 4 ? "last attention message" : `attention-${i}` });
    await until(() => bytes.includes("last attention message"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(bytes).not.toContain("\u001b[?1000h"); // Keyboard acknowledgement preserves native mouse behavior.
    expect(backgroundDefault()).toBe(false);
    input.write("/ack\r");
    await until(() => pending().total === 0); // All five originals are visible once, without duplicate pins.
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(backgroundDefault()).toBe(true);
    expect(bytes).not.toContain("\u001b[?1000h");
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([[true, false, true], [false, false, true], [true, true, true], [false, true, true], [true, false, false], [true, true, false]])("one visible highlighted copy remains clickable after layout changes (inline=%s, reflow=%s, cursorReply=%s)", async (inline, reflow, cursorReply) => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  if (cursorReply) vt.onData(data => input.write(data));
  else vt.write("\u001b[6;1H");
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total;
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    mouse: true, color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "click either copy\nWrapped text with 👩🏽‍💻 and 界 plus enough words to cross a narrow row." });
    await until(() => bytes.includes("\u001b[?1000h"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    if (reflow) {
      input.write("\u001b[200~draft first\ndraft second\u001b[201~");
      vt.resize(50, 30); output.columns = 50; output.rows = 30; output.emit("resize");
      service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: "layout changed" });
      await until(() => bytes.includes("layout changed"));
      await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    }
    const target = reflow ? "界" : "click either copy";
    expect(screen().filter(line => line.includes(target))).toHaveLength(1);
    for (let i = 0; i < 25; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `promotion-${i}` });
    await until(() => bytes.includes("promotion-24"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(screen().filter(line => line.includes("click either copy") && !line.includes("for you"))).toHaveLength(0);
    vt.resize(100, 100); output.columns = 100; output.rows = 100; output.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    const copies = screen().map((line, index) => line.includes(target) ? index : -1).filter(index => index >= 0);
    expect(copies).toHaveLength(1);
    const y = copies[0];
    input.write(`\u001b[<0;5;${y + 1}M`);
    await until(() => pending() === 0);
    if (reflow) { await flush(); expect(screen().join("\n")).toContain("draft second"); }
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([true, false])("native Ctrl-click dismisses top pins without capturing scrolling or selection (inline=%s)", async inline => {
  const { sendChatLinkClick } = await import("../src/cli/chat-links.js");
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: 28 }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total;
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5,
    herdr: { pane_id: "w1:p42", runner: () => JSON.stringify({ id: "test", result: { type: "plugin_list", plugins: [{ plugin_id: "talking-stick.chat", enabled: true }] } }) } });
  let url = "";
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "Native acknowledgement target" });
    await until(() => bytes.includes("Native acknowledgement target"));
    await flush();
    expect(bytes).not.toContain("https://talking-stick.invalid/ack/");
    expect(screen().filter(line => line.includes("Native acknowledgement target"))).toHaveLength(1);
    input.write("draft stays put");
    for (let i = 0; i < 25; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `native-flow-${i}` });
    await until(() => bytes.includes("native-flow-24") && bytes.includes("https://talking-stick.invalid/ack/"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    url = /\u001b\]8;;(https:\/\/talking-stick\.invalid\/ack\/[a-f0-9]{32}\/[1-9][0-9]*)\u001b\\/.exec(bytes)![1];
    const pinRow = screen().findIndex(line => line.includes("1 for you"));
    expect(pinRow).toBeLessThan(5);
    expect(screen().map((line, index) => line.includes("Native acknowledgement target") ? index : -1).filter(index => index >= 0)).toEqual([pinRow]);
    expect(await sendChatLinkClick({ url, paneId: "w1:another-pane" })).toBe("ignored");
    expect(pending()).toBe(1);
    expect(screen()[pinRow]).toContain("1 for you");
    expect(screen().join("\n")).toContain("draft stays put");
    expect(vt.modes.mouseTrackingMode).toBe("none");
    expect(bytes).not.toContain("\u001b[?1000h");
    if (inline) {
      expect(vt.buffer.active.type).toBe("normal");
      const history = Array.from({ length: vt.buffer.active.baseY }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "");
      expect(history.filter(line => line.includes("native-flow-0") && !line.includes("native-flow-01"))).toHaveLength(1);
      expect(history.filter(line => line.includes("Native acknowledgement target"))).toHaveLength(1);
    }
    expect(await sendChatLinkClick({ url, paneId: "w1:p42" })).toBe("acked");
    await until(() => pending() === 0);
    expect(await sendChatLinkClick({ url, paneId: "w1:p42" })).toBe("acked"); // Final control returns live.
    if (inline) {
      for (let i = 0; i < 25; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `between-pins-${i}` });
      await until(() => bytes.includes("between-pins-24"));
      service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "Second native pin" });
      await until(() => pending() === 1 && bytes.includes("Second native pin"));
      await new Promise(resolve => setTimeout(resolve, 30)); await flush();
      const history = Array.from({ length: vt.buffer.active.baseY }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "");
      expect(history.filter(line => line.includes("between-pins-0"))).toHaveLength(1);
      input.write("\u0015/ack all\r");
      await until(() => pending() === 0);
    }
  } finally { input.end(); await session; vt.dispose(); }
  expect(await sendChatLinkClick({ url, paneId: "w1:p42" })).toBe("unreachable");
});

test.each(["live", "away", "away-acked", "away-input", "away-disconnect", "away-none", "away-arriving"] as const)("native Herdr scroll preserves the viewport (%s)", async mode => {
  const scrollBeforePromotion = mode !== "live";
  const { NativeScrollLedger } = await import("../src/cli/native-scroll.js");
  const observed: number[] = [];
  const observe = NativeScrollLedger.prototype.observe;
  const scrollSpy = vi.spyOn(NativeScrollLedger.prototype, "observe").mockImplementation(function (this: InstanceType<typeof NativeScrollLedger>, scroll) {
    const result = observe.call(this, scroll);
    observed.push(scroll.offset_from_bottom);
    return result;
  });
  const dir = fs.mkdtempSync("/tmp/tth-");
  const socketPath = path.join(dir, "herdr.sock");
  let herdr: net.Socket | undefined;
  const server = net.createServer(connection => {
    connection.once("data", () => {
      herdr = connection;
      connection.write('{"id":"tt-chat-scroll","result":{"type":"subscription_started"}}\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: 28 }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).total;
  const scroll = async (offset: number) => {
    // Wait for the terminal to consume the last repaint, then for chat to
    // consume this host event. Fixed sleeps can send stale metrics under CI load.
    await flush();
    const count = observed.length;
    herdr!.write(`${JSON.stringify({ event: "pane.scroll_changed", data: { pane_id: "w1:p42",
      scroll: { max_offset_from_bottom: 100 + vt.buffer.active.baseY, offset_from_bottom: offset, viewport_rows: 28 } } })}\n`);
    await until(() => observed.length > count);
    expect(observed[count]).toBe(offset);
  };
  // Existing shell scrollback makes a shallow native scroll expose both
  // history and live-screen rows, which a full repaint must not replace.
  await new Promise<void>(resolve => vt.write(Array.from({ length: 100 }, (_, i) => `host-history-${i}`).join("\r\n") + "\r\n", resolve));
  const nativeViewport = () => Array.from({ length: 28 }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.viewportY + i)?.translateToString(true) ?? "");
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline: true,
    color: true, history: 0, show_turn_events: false, poll_ms: 5,
    herdr: { pane_id: "w1:p42", socket_path: socketPath, runner: () => { throw new Error("no plugin"); } } });
  try {
    await until(() => bytes.includes("Type to message the room") && herdr !== undefined);
    for (let i = 0; i < 40; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `warm-flow-${i}` });
    await until(() => bytes.includes("warm-flow-39"));
    await flush();
    const startsWithoutPin = mode === "away-none" || mode === "away-arriving";
    const target = startsWithoutPin ? null : service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "Scrolled-past target" });
    if (target) await until(() => bytes.includes("Scrolled-past target"));
    const expectCompleteHistory = () => {
      const lines = Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "");
      for (const prefix of ["warm-flow", "scroll-flow"]) {
        for (let i = 0; i < 40; i++) expect(lines.filter(line => new RegExp(`\\b${prefix}-${i}\\b`).test(line)), `${prefix}-${i}`).toHaveLength(1);
      }
    };
    const pinned = () => screen().slice(0, 5).some(line => line.includes("1 for you"));
    if (scrollBeforePromotion) {
      vt.scrollLines(-1);
      await scroll(1); // A shallow scroll still exposes live-screen rows.
      await new Promise(resolve => setTimeout(resolve, 30));
      await flush();
      const written = bytes.length;
      const viewed = nativeViewport();
      const viewportY = vt.buffer.active.viewportY;
      if (mode === "away-arriving") service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "Scrolled-past target" });
      for (let i = 0; i < 40; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `scroll-flow-${i}` });
      await new Promise(resolve => setTimeout(resolve, 100));
      if (mode === "away-acked") {
        service.acknowledgeHumanMessage({ room_id: joined.room_id, agent_id: "human:op", event_seq: target!.event_seq });
        await new Promise(resolve => setTimeout(resolve, 30));
        service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: "Normal output while away" });
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      // Nothing repaints, clears or commits under a scrolled-back view.
      await flush();
      expect(bytes.length).toBe(written);
      expect(nativeViewport()).toEqual(viewed);
      expect(vt.buffer.active.viewportY).toBe(viewportY);
      if (mode === "away-input" || mode === "away-disconnect") {
        if (mode === "away-disconnect") herdr!.destroy();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(nativeViewport()).toEqual(viewed);
        expect(vt.buffer.active.viewportY).toBe(viewportY);
        vt.scrollToBottom();
        input.write("resume draft");
        await until(() => bytes.includes("scroll-flow-39") && bytes.includes("resume draft"));
        await flush();
        expectCompleteHistory();
        expect(pending()).toBe(1);
        if (mode === "away-disconnect") {
          input.write("\u0015/ack all\r");
          await until(() => pending() === 0);
          return;
        }
      }
      vt.scrollToBottom();
      await scroll(0);
      if (mode === "away-acked" || mode === "away-none") {
        await until(() => bytes.includes(mode === "away-acked" ? "Normal output while away" : "scroll-flow-39"));
        await flush();
        expect(pinned()).toBe(false);
        expect(pending()).toBe(0);
        expectCompleteHistory();
        return;
      }
      await until(() => bytes.includes("scroll-flow-39") && pinned());
    } else {
      for (let i = 0; i < 40; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `scroll-flow-${i}` });
      await until(() => bytes.includes("scroll-flow-39"));
    }
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(pinned()).toBe(true);
    expectCompleteHistory();
    // Live-bottom snapshot, then a scroll that brings the committed original into view.
    await scroll(0);
    const history = Array.from({ length: vt.buffer.active.baseY }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "");
    const row = history.findIndex(line => line.includes("Scrolled-past target"));
    expect(row).toBeGreaterThanOrEqual(0);
    await scroll(vt.buffer.active.baseY - row);
    await new Promise(resolve => setTimeout(resolve, 30));
    vt.scrollToBottom();
    await scroll(0);
    if (mode === "live") {
      // Written on the append path before the bar existed, the original went
      // to native scrollback unledgered; doubt keeps the bar, never hides it.
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(pending()).toBe(1);
      input.write("\u0015/ack all\r");
    }
    // Scrolling across a ledgered original reads it durably, not only for this session.
    await until(() => pending() === 0);
    await until(() => !pinned());
  } finally {
    input.end(); await session; vt.dispose();
    scrollSpy.mockRestore();
    server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing a human room view persists a floor without deleting history or acknowledging messages", () => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:clear", context_path: root });
  const first = "human:op:chat:aaaaaaaa";
  const later = "human:op:chat:bbbbbbbb";
  const other = "human:other:chat:cccccccc";
  for (const id of [first, other]) service.joinPath({ agent_id: id, context_path: root,
    process_metadata: { session_kind: "human_chat" } });
  const pending = service.sendMessage({ agent_id: "codex:clear", room_id: joined.room_id, to_agent_id: first, body: "Before clear" });
  const before = service.getRoomEvents({ room_id: joined.room_id, include_all: true });
  expect(() => service.clearHumanChat({ room_id: joined.room_id, agent_id: "codex:clear" })).toThrow(/human console/);
  expect(() => service.clearHumanChat({ room_id: joined.room_id, agent_id: later })).toThrow(/human console/);
  const cleared = service.clearHumanChat({ room_id: joined.room_id, agent_id: first });
  expect(cleared.event_seq).toBe(before.at(-1)!.event_seq);
  expect(service.getHumanChatClearCursor({ room_id: joined.room_id, human_id: later })).toBe(cleared.event_seq);
  expect(service.getHumanChatClearCursor({ room_id: joined.room_id, human_id: other })).toBe(0);
  const nested = path.join(root, "nested");
  fs.mkdirSync(path.join(nested, ".talking-stick"), { recursive: true });
  fs.writeFileSync(path.join(nested, ".talking-stick", "room.toml"), "");
  const nestedRoom = service.joinPath({ agent_id: "claude:nested", context_path: nested });
  expect(nestedRoom.room_id).not.toBe(joined.room_id);
  expect(service.getHumanChatClearCursor({ room_id: nestedRoom.room_id, human_id: later })).toBe(0);
  expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true })).toEqual(before);
  expect(service.getHumanAttention({ room_id: joined.room_id, human_id: later })).toMatchObject({ total: 0, acknowledged: [] });
  expect(before.some(row => row.event_seq === pending.event_seq)).toBe(true);
  const fresh = service.sendMessage({ agent_id: "codex:clear", room_id: joined.room_id, to_agent_id: first, body: "After clear" });
  expect(service.getHumanAttention({ room_id: joined.room_id, human_id: later }).messages.map(row => row.event_seq)).toEqual([fresh.event_seq]);
  expect(service.getRecentRoomEvents({ room_id: joined.room_id, limit: 1, after_event_seq: cleared.event_seq }).map(row => row.event_seq)).toEqual([fresh.event_seq]);
  expect(service.getRecentRoomEvents({ room_id: joined.room_id, limit: 1, after_event_seq: cleared.event_seq,
    before_event_seq: fresh.event_seq })).toEqual([]);
});

test.each([true, false])("/clear erases the pane and a reopened console resumes after its marker (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:clear", context_path: root });
  for (let i = 0; i < 40; i++) service.sendMessage({ agent_id: "codex:clear", room_id: joined.room_id, body: `before-clear-${i}` });
  const open = (commands: TalkingStickCommands, agentId: string) => {
    const input = Object.assign(new PassThrough(), { setRawMode() {} });
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
    const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
    vt.onData(data => input.write(data));
    let bytes = "";
    output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
    const session = runChatSession({ runtime: { commands, close() {} },
      identity: deriveHumanCliIdentity({ agentId, displayName: "op", sessionKind: "human_chat" }),
      context_path: root, input, output, terminal: true, inline, color: true,
      history: 100, show_turn_events: false, poll_ms: 5 });
    return { input, vt, session, bytes: () => bytes,
      flush: () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve)),
      buffer: () => Array.from({ length: vt.buffer.active.length }, (_, i) => vt.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n") };
  };
  const firstId = "human:op:chat:aaaaaaaa";
  const first = open(new TalkingStickCommands(service), firstId);
  try {
    await until(() => first.bytes().includes("before-clear-39"));
    const oldPin = service.sendMessage({ agent_id: "codex:clear", room_id: joined.room_id, to_agent_id: firstId, body: "Old directed message" });
    await until(() => first.bytes().includes("Old directed message"));
    first.input.write("/clear\r");
    await until(() => service.getHumanChatClearCursor({ room_id: joined.room_id, human_id: firstId }) >= oldPin.event_seq);
    await new Promise(resolve => setTimeout(resolve, 30)); await first.flush();
    expect(first.bytes()).toContain("\u001b[3J");
    expect(first.buffer()).not.toContain("before-clear-");
    expect(first.buffer()).not.toContain("Old directed message");
    expect(service.getHumanAttention({ room_id: joined.room_id, human_id: firstId })).toMatchObject({ total: 0, acknowledged: [] });
    service.sendMessage({ agent_id: "codex:clear", room_id: joined.room_id, body: "After-clear message" });
    await until(() => first.bytes().includes("After-clear message"));
    await first.flush();
    expect(first.buffer()).toContain("After-clear message");
    expect(first.buffer()).not.toContain("before-clear-");
  } finally { first.input.end(); await first.session; first.vt.dispose(); }

  // A separate service connection and a fresh console id must recover the marker.
  const restarted = new TalkingStickService({ dbPath: path.join(root, ".state", "rooms.sqlite"), policy: { waitForEventsPollMs: 1 } });
  const second = open(new TalkingStickCommands(restarted), "human:op:chat:bbbbbbbb");
  try {
    await until(() => second.bytes().includes("After-clear message"));
    await second.flush();
    expect(second.buffer()).not.toContain("before-clear-");
    expect(second.buffer()).not.toContain("Old directed message");
    second.input.write("/older\r");
    await until(() => second.bytes().includes("before-clear-"));
    expect(service.getRoomEvents({ room_id: joined.room_id, include_all: true }).some(row => row.payload?.body === "before-clear-0")).toBe(true);
  } finally { second.input.end(); await second.session; second.vt.dispose(); restarted.close(); }
});

test.each([true, false])("Ctrl-G after slash review includes a remaining visible personal message (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  service.joinPath({ agent_id: "claude:peer", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages.map(event => event.event_seq);
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    const first = service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "first for op" });
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: "a broadcast to the room" });
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "claude:peer", body: "agent to agent" });
    for (let i = 0; i < 30; i++) service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, body: `chatter-${i}` });
    const second = service.sendMessage({ agent_id: "claude:peer", room_id: joined.room_id, to_agent_id: "human:op", body: "second for op" });
    await until(() => bytes.includes("second for op"));
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    // Only the two messages addressed to the human count; nothing else does.
    expect(pending()).toEqual([first.event_seq, second.event_seq]);
    input.write("/unread\r");
    await until(() => pending().length === 1);
    expect(pending()).toEqual([second.event_seq]);
    await flush();
    expect(screen().some(line => line.includes("first for op"))).toBe(true);
    input.write("\u0007");
    await until(() => pending().length === 0);
    await new Promise(resolve => setTimeout(resolve, 30)); await flush();
    expect(screen().some(line => line.includes("second for op"))).toBe(true);
  } finally { input.end(); await session; vt.dispose(); }
});

test.each([true, false])("Ctrl-G review does not let composer completions hide the target body (inline=%s)", async inline => {
  const { root, service } = setupService();
  const joined = service.joinPath({ agent_id: "codex:attention", context_path: root });
  const input = Object.assign(new PassThrough(), { setRawMode() {} });
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 28 });
  const vt = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  vt.onData(data => input.write(data));
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); vt.write(chunk.toString()); });
  const flush = () => new Promise<void>(resolve => vt.write("\u001b[0m", resolve));
  const screen = () => Array.from({ length: output.rows }, (_, i) => vt.buffer.active.getLine(vt.buffer.active.baseY + i)?.translateToString(true) ?? "");
  const pending = () => service.getHumanAttention({ room_id: joined.room_id, human_id: "human:op" }).messages.map(event => event.event_seq);
  const session = runChatSession({ runtime: { commands: new TalkingStickCommands(service), close() {} },
    identity: observerIdentity(), context_path: root, input, output, terminal: true, inline,
    color: true, history: 0, show_turn_events: false, poll_ms: 5 });
  try {
    await until(() => bytes.includes("Type to message the room"));
    service.sendMessage({ agent_id: "codex:attention", room_id: joined.room_id, to_agent_id: "human:op", body: "FOCUSED BODY MUST REMAIN VISIBLE" });
    await until(() => bytes.includes("FOCUSED BODY MUST REMAIN VISIBLE"));
    input.write("@co");
    await new Promise(resolve => setTimeout(resolve, 40)); await flush();
    input.write("\u0007");
    await new Promise(resolve => setTimeout(resolve, 80)); await flush();
    expect(screen().join("\n")).toContain("FOCUSED BODY MUST REMAIN VISIBLE");
    await until(() => pending().length === 0);
    await new Promise(resolve => setTimeout(resolve, 40)); await flush();
    expect(screen().join("\n")).toContain("FOCUSED BODY MUST REMAIN VISIBLE");
    // Escape returns live with the same draft.
    input.write("\u001b");
    await new Promise(resolve => setTimeout(resolve, 150)); await flush();
    expect(screen().some(line => line.startsWith("> @co"))).toBe(true);
  } finally { input.end(); await session; vt.dispose(); }
});
