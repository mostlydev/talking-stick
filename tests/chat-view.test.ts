import { describe, expect, test } from "vitest";
import type { RoomEvent } from "../src/types.js";
import { buildNameResolver } from "../src/cli/chat-format.js";
import {
  ChatTranscript,
  completeChatInput,
  diffChatFrame,
  graphemeWidth,
  layoutComposer,
  matchChatCommands,
  renderChatScreen,
  textWidth,
  wrapStyledLine
} from "../src/cli/chat-view.js";

const ESC = String.fromCharCode(27);
const SELF = "human:op:chat:1";
const context = {
  self_agent_id: SELF,
  name_of: buildNameResolver(["codex:aa", "claude:bb", SELF], SELF),
  color: false,
  show_turn_events: false
};

let seq = 0;
function message(body: string, from = "codex:aa"): RoomEvent {
  seq += 1;
  return {
    event_seq: seq,
    event_id: `e${seq}`,
    room_id: "r",
    turn_id: 1,
    event_type: "message_sent",
    from_agent_id: from,
    to_agent_id: null,
    handoff: null,
    reason: null,
    created_at: new Date(2026, 8, 14, 9, 5).toISOString(),
    payload: { body, delivery_hint: "normal" }
  };
}

function stickEvent(event_type: RoomEvent["event_type"]): RoomEvent {
  return {
    ...message(""),
    event_type,
    to_agent_id: "claude:bb",
    payload: null
  };
}

describe("text measurement", () => {
  test("counts wide characters, emoji, and combining marks as terminal cells", () => {
    expect(graphemeWidth("a")).toBe(1);
    expect(graphemeWidth("🇵🇱")).toBe(2);
    expect(graphemeWidth("界")).toBe(2);
    expect(graphemeWidth("\u{1f642}")).toBe(2);
    expect(graphemeWidth("❤\ufe0f")).toBe(2);
    expect(textWidth("e\u0301")).toBe(1);
    expect(textWidth(`${ESC}[1;31mred${ESC}[0m`)).toBe(3);
    expect(textWidth("\u{1f469}\u200d\u{1f4bb}")).toBe(2);
  });

  test("wraps at spaces, keeps indentation, and never exceeds the width", () => {
    expect(wrapStyledLine("  the quick brown fox jumps over", 12)).toEqual([
      "  the quick",
      "  brown fox",
      "  jumps over"
    ]);
    for (const row of wrapStyledLine("界".repeat(9), 7)) {
      expect(textWidth(row)).toBeLessThanOrEqual(7);
    }
    expect(wrapStyledLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("carries color across wrapped rows and resets at each row end", () => {
    const rows = wrapStyledLine(`${ESC}[1;32mgreen words here${ESC}[0m`, 6);
    expect(rows[0]).toBe(`${ESC}[1;32mgreen${ESC}[0m`);
    expect(rows[1]).toBe(`${ESC}[1;32mwords${ESC}[0m`);
  });
});

describe("transcript scrolling", () => {
  test("dims body rows and preserves a conversation gap across automatic cleanup", () => {
    const transcript = new ChatTranscript();
    transcript.appendEvent({ ...message("older body"), created_at: new Date(2026, 8, 15, 8).toISOString() });
    transcript.appendEvent({ ...stickEvent("claim"), event_type: "leave", reason: "process_ended", created_at: new Date(2026, 8, 15, 13).toISOString() });
    transcript.appendEvent({ ...stickEvent("claim"), event_type: "join", created_at: new Date(2026, 8, 15, 13, 1).toISOString() });
    const rows = transcript.viewport(30, 100, { ...context, color: true,
      now: new Date(2026, 8, 15, 14), history_before: new Date(2026, 8, 15, 13, 1).toISOString() });
    expect(rows.find((row) => row.includes("older body"))).toContain("\u001b[2;90m");
    expect(rows.join("\n")).toContain("New conversation · Today");
  });

  test("separates earlier days and refreshes the divider across midnight", () => {
    const transcript = new ChatTranscript();
    transcript.appendEvent({ ...message("old"), created_at: new Date(2026, 8, 14, 12).toISOString() });
    transcript.appendEvent({ ...message("current"), created_at: new Date(2026, 8, 15, 12).toISOString() });
    const first = transcript.viewport(20, 80, { ...context, now: new Date(2026, 8, 15, 14) }).join("\n");
    expect(first).toContain("Earlier activity · Yesterday");
    expect(first).toContain("── Today ──");
    const next = transcript.viewport(20, 80, { ...context, now: new Date(2026, 8, 16, 1) }).join("\n");
    expect(next).toContain("Earlier activity · 2026-09-14");
    expect(next).toContain("Yesterday at 12:00");
    expect(next).not.toContain("── Today ──");
  });

  function filled(count: number) {
    const transcript = new ChatTranscript();
    for (let index = 1; index <= count; index++) {
      transcript.appendEvent(message(`m${index}`));
    }
    return transcript;
  }

  test("follows the newest messages and bottom-aligns a short conversation", () => {
    expect(filled(1).viewport(4, 40, context)).toEqual([
      "",
      "",
      "codex  09:05",
      "  m1"
    ]);
    expect(filled(10).viewport(2, 40, context)).toEqual([
      "codex  09:05",
      "  m10"
    ]);
  });

  test("stays put while new messages arrive and counts them as unread", () => {
    const transcript = filled(10);
    transcript.scrollBy(-6, 5, 40, context);
    const before = transcript.viewport(5, 40, context);
    expect(transcript.following).toBe(false);

    transcript.appendEvent(message("m11"));
    transcript.appendEvent(stickEvent("claim"));
    transcript.appendEvent(message("m12"));
    expect(transcript.viewport(5, 40, context)).toEqual(before);
    expect(transcript.unread).toBe(2);

    transcript.scrollBy(1_000, 5, 40, context);
    expect(transcript.following).toBe(true);
    expect(transcript.unread).toBe(0);
    expect(transcript.viewport(5, 40, context).at(-1)).toBe("  m12");
  });

  test("keeps the same message at the top across a resize", () => {
    const transcript = new ChatTranscript();
    for (let index = 1; index <= 8; index++) {
      transcript.appendEvent(message(`number ${index} carries several words`));
    }
    transcript.scrollBy(-12, 4, 60, context);
    const wide = transcript.viewport(4, 60, context).join("\n");
    const anchoredNumber = /number (\d)/.exec(wide)?.[1];
    const narrow = transcript.viewport(4, 20, context).join("\n");
    expect(anchoredNumber).toBeDefined();
    expect(narrow).toContain(`number ${anchoredNumber}`);
  });

  test("rewrites a notice in place without adding a block", () => {
    const transcript = new ChatTranscript();
    const id = transcript.appendNotice("codex: queued");
    transcript.appendEvent(message("later"));
    expect(transcript.updateNotice(id, "codex: queued → received")).toBe(true);
    expect(transcript.size).toBe(2);
    expect(transcript.viewport(10, 40, context).join("\n")).toContain("codex: queued → received");
    expect(transcript.updateNotice(999, "gone")).toBe(false);
  });

  test("evicts the oldest blocks beyond the cap", () => {
    const transcript = new ChatTranscript(3);
    for (let index = 1; index <= 5; index++) {
      transcript.appendEvent(message(`m${index}`));
    }
    expect(transcript.size).toBe(3);
    expect(transcript.viewport(20, 40, context).join("\n")).not.toContain("m2");
  });
});

describe("composer", () => {
  test("wraps the draft under the prompt and tracks the cursor", () => {
    const layout = layoutComposer({ line: "hello world", cursor: 11 }, 8);
    expect(layout.rows).toEqual(["> hello ", "  world"]);
    expect([layout.cursor_row, layout.cursor_col]).toEqual([1, 7]);

    const middle = layoutComposer({ line: "hello world", cursor: 2 }, 8);
    expect([middle.cursor_row, middle.cursor_col]).toEqual([0, 4]);
  });

  test("measures wide characters and moves a cursor at a full row end down", () => {
    const layout = layoutComposer({ line: "界界界", cursor: 3 }, 8);
    expect(layout.rows).toEqual(["> 界界界", "  "]);
    expect([layout.cursor_row, layout.cursor_col]).toEqual([1, 2]);
  });

  test("caps the composer height and keeps the cursor row visible", () => {
    const line = "x".repeat(60);
    const start = layoutComposer({ line, cursor: 0 }, 12, 3);
    expect(start.rows).toHaveLength(3);
    expect(start.cursor_row).toBe(0);
    const end = layoutComposer({ line, cursor: 60 }, 12, 3);
    expect(end.rows).toHaveLength(3);
    expect(end.cursor_row).toBe(2);
  });
});

describe("commands and completion", () => {
  test("lists matching commands while the command name is typed", () => {
    expect(matchChatCommands("/").length).toBeGreaterThan(3);
    expect(matchChatCommands("/qu").map((command) => command.name)).toEqual([
      "quit"
    ]);
    expect(matchChatCommands("/quit now")).toEqual([]);
    expect(matchChatCommands("hello")).toEqual([]);
  });

  test("tab completes commands and @names", () => {
    expect(completeChatInput({ line: "/qu", cursor: 3 }, [])).toEqual({
      line: "/quit ",
      cursor: 6
    });
    expect(
      completeChatInput({ line: "hey @co", cursor: 7 }, ["codex", "claude"])
    ).toEqual({ line: "hey @codex ", cursor: 11 });
    expect(
      completeChatInput({ line: "@c", cursor: 2 }, ["codex", "claude"])
    ).toBeNull();
  });
});

describe("screen rendering", () => {
  const status = {
    members: [],
    owner: null,
    owner_since: null,
    reserved_for: null,
    now: new Date()
  };

  test("pins rules, composer, and footer to the bottom", () => {
    const transcript = new ChatTranscript();
    transcript.appendEvent(message("hi"));
    const frame = renderChatScreen({
      transcript,
      format: context,
      status,
      draft: { line: "", cursor: 0 },
      hint: null,
      columns: 30,
      rows: 8
    });
    expect(frame.lines).toHaveLength(8);
    expect(frame.lines.slice(-4, -1)).toEqual([
      "─".repeat(29),
      "> ",
      "─".repeat(29)
    ]);
    expect(frame.lines.at(-1)).toMatch(/^0 members\s+\/ for commands$/);
    expect(frame.lines.slice(0, 4).join("\n")).toContain("  hi");
    expect(frame.cursor).toEqual({ row: 5, col: 2 });
    for (const line of frame.lines) {
      expect(textWidth(line)).toBeLessThanOrEqual(29);
    }
  });

  test("keeps every row and the cursor inside tiny terminals", () => {
    const transcript = new ChatTranscript();
    transcript.appendEvent(message("🇵🇱界".repeat(20)));
    for (let columns = 1; columns <= 12; columns++) {
      for (let rows = 1; rows <= 12; rows++) {
        const frame = renderChatScreen({
          transcript,
          format: context,
          status,
          draft: { line: "界\n".repeat(10), cursor: 20 },
          hint: null,
          columns,
          rows
        });
        expect(frame.lines).toHaveLength(rows);
        for (const line of frame.lines)
          expect(textWidth(line)).toBeLessThanOrEqual(Math.max(1, columns - 1));
        expect(frame.cursor.row).toBeLessThan(rows);
        expect(frame.cursor.col).toBeLessThan(columns);
      }
    }
    for (const row of wrapStyledLine("界🇵🇱", 1))
      expect(textWidth(row)).toBeLessThanOrEqual(1);
  });

  test("shows the command menu and the unread indicator", () => {
    const transcript = new ChatTranscript();
    for (let index = 0; index < 10; index++) {
      transcript.appendEvent(message(`m${index}`));
    }
    transcript.scrollBy(-5, 3, 39, context);
    transcript.appendEvent(message("late"));
    const frame = renderChatScreen({
      transcript,
      format: context,
      status,
      draft: { line: "/", cursor: 1 },
      hint: null,
      columns: 40,
      rows: 10
    });
    expect(frame.lines.join("\n")).toContain("/quit  leave the chat");
    expect(frame.lines.at(-1)).toContain("↓ 1 new · ctrl+end");
  });

  test("shows a transient hint in place of the command hint", () => {
    const frame = renderChatScreen({
      transcript: new ChatTranscript(),
      format: context,
      status,
      draft: { line: "", cursor: 0 },
      hint: "type /quit to exit",
      columns: 50,
      rows: 6
    });
    expect(frame.lines.at(-1)).toMatch(/type \/quit to exit$/);
  });

  test("diffs frames to the changed rows only", () => {
    const first = { lines: ["a", "b", "c"], cursor: { row: 2, col: 0 } };
    const second = { lines: ["a", "B", "c"], cursor: { row: 2, col: 1 } };
    expect(diffChatFrame(null, first)).toContain(`${ESC}[2J`);
    const partial = diffChatFrame(first, second);
    expect(partial).not.toContain(`${ESC}[2J`);
    expect(partial).toContain(`${ESC}[2;1H${ESC}[2KB`);
    expect(partial).not.toContain(`${ESC}[1;1H`);
    expect(partial).toContain(`${ESC}[3;2H`);
  });
});
