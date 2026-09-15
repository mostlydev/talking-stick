import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { ChatInputController } from "../src/cli/chat-input.js";
import { completeChatInput, getChatCompletions } from "../src/cli/chat-view.js";

function setup(menu = false) {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode: vi.fn()
  });
  const submit = vi.fn();
  const quit = vi.fn();
  const scroll = vi.fn();
  const bottom = vi.fn();
  const editor = new ChatInputController({
    input,
    columns: 40,
    onSubmit: submit,
    onQuit: quit,
    onScroll: scroll,
    onBottom: bottom,
    onChange: vi.fn(),
    onClear: vi.fn(),
    completionCount: menu ? (draft) => getChatCompletions(draft, ["codex", "claude"]).length : undefined,
    complete: (draft, index) => menu ? getChatCompletions(draft, ["codex", "claude"])[index]?.draft ?? null : completeChatInput(draft, ["codex", "claude"])
  });
  return { editor, input, submit, quit, scroll, bottom };
}

describe("full-screen chat input", () => {
  test("Ctrl+C and Escape clear without quitting, even on an empty draft", async () => {
    const { editor, input, quit } = setup();
    try {
      input.write("draft\u0003\u0003");
      expect(editor.draft.line).toBe("");
      input.write("another\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.draft).toEqual({ line: "", cursor: 0 });
      expect(quit).not.toHaveBeenCalled();
      input.write("\u0004");
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      editor.close();
    }
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("split mouse and navigation reports never enter the draft", () => {
    const { editor, input, scroll, bottom } = setup();
    try {
      input.write("draft\u001b[<6");
      input.write("4;12;3M\u001b[<65;12;3M");
      input.write("\u001b[5~\u001b[6~\u001b[1;2A\u001b[1;5F");
      expect(editor.draft.line).toBe("draft");
      expect(scroll.mock.calls).toEqual([
        ["lines", -3],
        ["lines", 3],
        ["pages", -1],
        ["pages", 1],
        ["lines", -1]
      ]);
      expect(bottom).toHaveBeenCalledOnce();
    } finally {
      editor.close();
    }
  });

  test("multiline paste is atomic, keeps exact order, and recalls correctly", () => {
    const { editor, input, submit } = setup();
    try {
      input.write("before ");
      input.write("\u001b[20");
      input.write("0~one\r\ntwo 界🙂\n/quit\u001b[20");
      input.write("1~");
      const body = "before one\ntwo 界🙂\n/quit";
      expect(editor.draft.line).toBe(body);
      expect(submit).not.toHaveBeenCalled();
      input.write("\u0001\u0005\r");
      expect(submit).toHaveBeenLastCalledWith(body);
      input.write("\u001b[A");
      expect(editor.draft.line).toBe(body);
      input.write("\r");
      expect(submit).toHaveBeenLastCalledWith(body);
    } finally {
      editor.close();
    }
  });

  test("UTF-8 chunk boundaries, cursor editing, and completion preserve text", () => {
    const { editor, input, submit } = setup();
    try {
      const bytes = Buffer.from("界🙂");
      for (const byte of bytes) input.write(Buffer.from([byte]));
      input.write("\u001b[DZ\r");
      expect(submit).toHaveBeenLastCalledWith("界Z🙂");
      input.write("/qu\t");
      expect(editor.draft.line).toBe("/quit ");
      editor.clear();
      input.write("@cod\t");
      expect(editor.draft.line).toBe("@codex ");
    } finally {
      editor.close();
    }
  });

  test("arrows edit multiline drafts with a sticky column and never recall history at their edges", () => {
    const { editor, input } = setup();
    try {
      input.write("history\r\u001b[200~abcdef\nx\nabcdef\u001b[201~");
      input.write("\u001b[A");
      expect(editor.draft.cursor).toBe(8);
      input.write("\u001b[A");
      expect(editor.draft.cursor).toBe(6);
      input.write("\u001b[A");
      expect(editor.draft.line).toBe("abcdef\nx\nabcdef");
      expect(editor.draft.cursor).toBe(6);
      input.write("\u001bOB\u001bOB\u001bOB");
      expect(editor.draft.cursor).toBe(15);
      input.write("\u001b[A\u001b[D\u001b[A");
      expect(editor.draft.cursor).toBe(0);
    } finally { editor.close(); }
  });

  test("menu selection, Enter acceptance, Escape dismissal, and multiline editing cooperate", async () => {
    const { editor, input, submit } = setup(true);
    try {
      input.write("@c\u001b[B\t");
      expect(editor.draft.line).toBe("@claude ");
      expect(submit).not.toHaveBeenCalled();
      editor.clear();
      input.write("/he\r");
      expect(editor.draft.line).toBe("/help ");
      expect(submit).not.toHaveBeenCalled();
      input.write("\r");
      expect(submit).toHaveBeenLastCalledWith("/help ");
      input.write("line one\u001b\r@c\u001b[B");
      expect(editor.completionIndex).toBe(1);
      const before = editor.draft.line;
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.draft.line).toBe(before);
      expect(editor.completionVisible).toBe(false);
      input.write("\u001b[A");
      expect(editor.draft.cursor).toBe(2);
      expect(editor.draft.line).toBe(before);
    } finally { editor.close(); }
  });

  test("Enter sends an already-complete mention and executes an exact command", () => {
    const { editor, input, submit } = setup(true);
    try {
      input.write("hey @codex\r");
      expect(submit).toHaveBeenLastCalledWith("hey @codex");
      input.write("/qu\r");
      expect(editor.draft.line).toBe("/quit ");
      expect(submit).toHaveBeenCalledTimes(1);
      editor.clear();
      input.write("/quit\r");
      expect(submit).toHaveBeenLastCalledWith("/quit");
    } finally { editor.close(); }
  });

  test("wrapped arrows and newline keys preserve graphemes and avoid submission", () => {
    const { editor, input, submit } = setup();
    try {
      editor.resize(8);
      input.write("界🙂abcdef");
      input.write("\u001b[A");
      expect(editor.draft.cursor).toBe(3);
      input.write("\u001b[B");
      expect(editor.draft.cursor).toBe(9);
      input.write("\u001b[13;2u");
      expect(editor.draft.line).toBe("界🙂abcdef\n");
      expect(submit).not.toHaveBeenCalled();
    } finally { editor.close(); }
  });

  test("restoration is idempotent and retains an already-raw input mode", () => {
    const { editor, input } = setup();
    editor.close();
    editor.close();
    expect(input.setRawMode).toHaveBeenCalledTimes(2);
    input.isRaw = true;
    const second = new ChatInputController({
      input,
      columns: 40,
      onChange() {},
      onSubmit() {},
      onScroll() {},
      onBottom() {},
      onQuit() {},
      onClear() {},
      complete: () => null
    });
    second.close();
    expect(input.setRawMode).toHaveBeenLastCalledWith(true);
  });
});
