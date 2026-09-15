import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { TalkingStickCommands } from "../src/commands.js";
import { deriveHumanCliIdentity } from "../src/identity.js";
import { TalkingStickService, type TalkingStickServiceOptions, type ProcessLiveness } from "../src/service.js";
import type { ProcessMetadata, RoomEvent } from "../src/types.js";
import {
  agentColor,
  buildNameResolver,
  formatChatStatus,
  formatDuration,
  formatChatEvent,
  parseChatInput,
  resolveChatRecipient,
  resolveChatRecipients,
  sanitizeChatText
} from "../src/cli/chat-format.js";
import { createChatIdentity, runChatSession } from "../src/cli/chat.js";

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
      "6 members │ codex holding 12m · claude up next · gemini idle 1h · opencode standby · grok away"
    );
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
    expect(line).toBe("3 members │ codex active · +2");
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
    await until(() => transcript.includes("2 members"));
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
    await until(() => transcript.includes("claude:fast: waiting for agent to read"));
    expect(transcript.match(/claude:fast: queued/g)?.length).toBe(noticesBefore);
    expect(deliveries).toBe(2);
  } finally {
    finishSlow({ outcome: "queued" });
    input.write("/quit\n");
    await session;
  }
});
