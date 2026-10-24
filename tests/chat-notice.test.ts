import { expect, test } from "vitest";
import { formatChatNotice } from "../src/cli/chat-notice.js";
import { formatChatEvent } from "../src/cli/chat-format.js";
import { isHumanDirected } from "../src/human-attention.js";
import { themeStyle } from "../src/cli/theme.js";
import type { RoomEvent } from "../src/types.js";
import type { HumanAttention } from "../src/cli/chat-attention.js";

test("command results use a common separated gutter with semantic result colors", () => {
  for (const [text, label, token] of [["! Refused", "error", "error"], ["Removed codex", "done", "ok"], ["Theme choices\nsecond line", "info", "ref"]] as const) {
    const plain = formatChatNotice(text, false);
    const colored = formatChatNotice(text, true);
    expect(plain).toContain(`│ ${label} · `);
    expect(plain.startsWith("\n")).toBe(true);
    expect(plain.endsWith("\n")).toBe(false);
    expect(colored).toContain(themeStyle(token));
    expect(colored.replace(/\u001b\[[0-9;]*m/g, "")).toBe(plain);
  }
});

test("human-directed transcript messages have a reset-safe background; broadcasts and visitor replies do not", () => {
  const context = { self_agent_id: "human:op", name_of: (id: string) => id, color: true, show_turn_events: false };
  const event: RoomEvent = { event_seq: 1, event_id: "e1", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: new Date().toISOString(), handoff: null, reason: null, payload: { delivery_hint: "normal", body: "hello #42\nnext line" } };
  const bg = themeStyle("attention", undefined, true);
  const direct = formatChatEvent(event, context)!;
  expect(direct.split("\n").every(line => line.includes(bg) && line.endsWith("\u001b[0m"))).toBe(true);
  expect(formatChatEvent(event, { ...context, human_acknowledged: () => true })).not.toContain(bg);
  expect(formatChatEvent({ ...event, to_agent_id: null }, context)).not.toContain(bg);
  expect(isHumanDirected({ ...event, to_agent_id: null, payload: { delivery_hint: "normal", body: "room", sent_to: ["human:op"] } })).toBe(false);
  expect(isHumanDirected({ ...event, to_agent_id: null, payload: { delivery_hint: "normal", body: "multi", recipients: ["human:op", "codex:bb"] } })).toBe(true);
  expect(isHumanDirected(event, "human:other")).toBe(false);
});

test("missed-message control is one banded row previewing the message it visits next", async () => {
  const { renderAttention } = await import("../src/cli/chat-attention.js");
  const now = new Date("2026-10-23T12:00:00Z");
  const event: RoomEvent = { event_seq: 42, event_id: "e42", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: "2026-10-23T11:56:00Z", handoff: null, reason: null, payload: { delivery_hint: "normal", body: "\n  Oldest first line of the request.\nA second line never shows." } };
  const newer: RoomEvent = { ...event, event_seq: 99, payload: { delivery_hint: "normal", body: "Newer message" } };
  const context = { self_agent_id: "human:op", name_of: (id: string) => id.split(":")[0], color: false, show_turn_events: false, now, pin_link: (seq: number) => `https://example.invalid/${seq}` };
  const attention = { messages: [newer, event], total: 2 };
  for (const width of [4, 20, 100]) for (const rows of [4, 8, 30]) {
    const control = renderAttention(attention, width, rows, context);
    expect(control.lines).toHaveLength(rows >= 8 ? 2 : 1);
    expect(control.lines.slice(1).every(line => line === "")).toBe(true);
    expect(control.lines[0]).not.toContain("second line");
    expect(control.lines[0]).toContain("https://example.invalid/42");
    expect(control.hits).toEqual([{ event_seq: 42, row: 0 }]);
  }
  const plain = (width: number, value: HumanAttention = attention) => renderAttention(value, width, 30, { ...context, pin_link: undefined }).lines[0];
  // The key that opens the bar outlasts the age and the preview at every width it fits.
  expect(plain(100)).toBe(" ▲ 2 for you · codex › Oldest first line of the request. 4m · Ctrl-G ");
  for (const width of [48, 34, 26]) {
    expect(plain(width)).toContain("Ctrl-G");
    expect(plain(width).length).toBeLessThanOrEqual(width);
  }
  expect(plain(22)).toBe(" ▲ 2 for you · Ctrl-G ");
  expect(plain(16)).toBe(" ▲ 2 · Ctrl-G ");
  expect(plain(12)).toBe(" ▲ 2 for you");
  // With Herdr's native link, the bar names both ways to open it while there is room.
  const linked = (width: number) => renderAttention(attention, width, 30, context).lines[0].replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  expect(linked(100)).toContain("Ctrl-G or Ctrl-click");
  expect(linked(34)).toContain("Ctrl-G");
  expect(renderAttention({ messages: [], total: 0 }, 100, 30, context).lines).toEqual([]);
  const reviewing = { messages: [newer], total: 1, reviewing: true, visited: 42, current: event, position: 1, queued: 2 };
  expect(plain(100, reviewing)).toBe(" ▲ 1 of 2 · codex 4m · Ctrl-G next · Esc live ");
  expect(plain(36, reviewing)).toBe(" ▲ 1 of 2 · Ctrl-G next · Esc live ");
  expect(plain(22, reviewing)).toBe(" ▲ 1 of 2 · Ctrl-G ");
  expect(plain(100, { messages: [], total: 0, reviewing: true, visited: 42 })).toBe(" ✓ All caught up · Esc live ");
});

test("the control row carries the unread background across its full width", async () => {
  const { Terminal } = await import("@xterm/headless");
  const { renderAttention } = await import("../src/cli/chat-attention.js");
  const event: RoomEvent = { event_seq: 1, event_id: "e1", room_id: "r", turn_id: 0, event_type: "message_sent", from_agent_id: "codex:aa", to_agent_id: "human:op", created_at: new Date().toISOString(), handoff: null, reason: null, payload: { delivery_hint: "normal", body: "First" } };
  for (const color_mode of ["256", "truecolor"] as const) {
    const control = renderAttention({ messages: [event], total: 1 }, 48, 30, {
      self_agent_id: "human:op", name_of: id => id, color: true, color_mode, show_turn_events: false,
      pin_link: seq => `https://talking-stick.invalid/ack/${"a".repeat(32)}/${seq}`
    });
    expect(control.lines[0]).toContain("\u001b]8;;");
    const vt = new Terminal({ cols: 49, rows: 4, allowProposedApi: true });
    try {
      await new Promise<void>(resolve => vt.write(control.lines[0] + "\r\nLive conversation", resolve));
      const background = vt.buffer.active.getLine(0)!.getCell(0)!;
      expect(background.isBgDefault()).toBe(false);
      for (let col = 0; col < 48; col++) {
        const cell = vt.buffer.active.getLine(0)!.getCell(col)!;
        expect(cell.getBgColorMode()).toBe(background.getBgColorMode());
        expect(cell.getBgColor()).toBe(background.getBgColor());
      }
      expect(vt.buffer.active.getLine(1)!.getCell(0)!.isBgDefault()).toBe(true);
    } finally { vt.dispose(); }
  }
});