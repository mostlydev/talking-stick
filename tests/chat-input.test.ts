import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { ChatInputController } from "../src/cli/chat-input.js";
import { completeChatInput, getChatCompletions } from "../src/cli/chat-view.js";

function setup(
  menu = false,
  wheel?: (row: number, direction: number) => void,
  extra: { onRoomTree?: () => void; onNextUnread?: () => void; onRightClick?: (column: number, row: number) => void; onEmptyEscape?: () => void; now?: () => number } = {}
) {
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
    onWheel: wheel,
    onRightClick: extra.onRightClick,
    onRoomTree: extra.onRoomTree,
    onNextUnread: extra.onNextUnread,
    onBottom: bottom,
    onChange: vi.fn(),
    onClear: vi.fn(),
    onEmptyEscape: extra.onEmptyEscape,
    now: extra.now,
    completionCount: menu ? (draft) => getChatCompletions(draft, ["codex", "claude"]).length : undefined,
    complete: (draft, index) => menu ? getChatCompletions(draft, ["codex", "claude"])[index]?.draft ?? null : completeChatInput(draft, ["codex", "claude"])
  });
  return { editor, input, submit, quit, scroll, bottom };
}

describe("enhanced keyboard reports", () => {
  test("kitty reports for Ctrl, Alt and Escape act like their legacy keys", () => {
    const onRoomTree = vi.fn();
    const { editor, input, submit } = setup(false, undefined, { onRoomTree });
    try {
      input.write("draft\u001b[99;5u");
      expect(editor.draft.line).toBe("");
      input.write("one\u001b[13;2utwo\u001b[13;3uthree\u001b[13;66ufour");
      expect(editor.draft.line).toBe("one\ntwo\nthree\nfour");
      expect(submit).not.toHaveBeenCalled();
      input.write("\u001b[27u");
      expect(editor.draft.line).toBe("");
      input.write("\u001b[116;5u");
      expect(onRoomTree).toHaveBeenCalledOnce();
      input.write("sent\r");
      expect(submit).toHaveBeenCalledWith("sent");
    } finally { editor.close(); }
  });

  test("Ctrl-G asks for the next message for you and keeps the draft; a pasted ^G stays text", () => {
    const onNextUnread = vi.fn();
    const { editor, input } = setup(false, undefined, { onNextUnread });
    try {
      input.write("half typed\u0007");
      expect(onNextUnread).toHaveBeenCalledOnce();
      expect(editor.draft).toEqual({ line: "half typed", cursor: 10 });
      input.write("\u001b[103;5u"); // The same key as a kitty report.
      expect(onNextUnread).toHaveBeenCalledTimes(2);
      input.write("\u001b[200~a\u0007b\u001b[201~");
      expect(onNextUnread).toHaveBeenCalledTimes(2);
      expect(editor.draft.line).toBe("half typedab"); // Pasted control characters are dropped, never acted on.
    } finally { editor.close(); }
  });

  test("typing dismisses a type-through modal and edits the draft at its cursor", async () => {
    const keys: string[] = [];
    let closes = 0;
    let editor!: ChatInputController;
    const open = () => editor.setModal(key => keys.push(key), undefined, false, () => { closes++; editor.setModal(null); });
    const made = setup(false, undefined, { onNextUnread: open });
    editor = made.editor;
    const { input } = made;
    try {
      input.write("half typed\u001b[D\u001b[D\u001b[D\u001b[D\u001b[D");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(editor.draft).toEqual({ line: "half typed", cursor: 5 });
      open();
      input.write("\u0007\u001b[A\u001b[6~\r\u001b[27u");
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(keys).toEqual(["next_unread", "up", "page_down", "enter", "escape"]);
      // One chunk: the first key closes the modal and none of the rest is lost.
      input.write("hello ");
      expect(closes).toBe(1);
      expect(editor.modalActive).toBe(false);
      expect(editor.draft).toEqual({ line: "half hello typed", cursor: 11 });
      // Letters and Space that drive other modals are plain text here.
      for (const char of ["n", "q", " ", "j"]) { open(); input.write(char); }
      expect(closes).toBe(5);
      expect(editor.draft.line).toBe("half hello nq jtyped");
      open();
      input.write("\u007f");
      expect(editor.draft.line).toBe("half hello nq typed");
      // A paste lands in the draft; its control bytes are never hotkeys.
      open();
      input.write("\u001b[200~x\u0007y\u001b[201~");
      expect(editor.draft.line).toBe("half hello nq xytyped");
      // Ctrl-G from the composer opens the modal; text after it in the same chunk is typed.
      input.write("\u0007ab");
      expect(closes).toBe(8);
      expect(editor.draft.line).toBe("half hello nq xyabtyped");
      expect(keys).toEqual(["next_unread", "up", "page_down", "enter", "escape"]);
    } finally { editor.close(); }
  });

  test("a forwarded Cmd+V inserts the clipboard paste as is", async () => {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const onImagePaste = vi.fn(async () => "[Image #1]");
    const onClipboardPaste = vi.fn(async () => "line one\nline two");
    const editor = new ChatInputController({ input, columns: 40, onSubmit: vi.fn(), onQuit: vi.fn(), onScroll: vi.fn(),
      onBottom: vi.fn(), onChange: vi.fn(), onClear: vi.fn(), onImagePaste, onClipboardPaste, complete: () => null });
    try {
      input.write("a \u001b[118;9u!");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onClipboardPaste).toHaveBeenCalledOnce();
      expect(onImagePaste).not.toHaveBeenCalled();
      expect(editor.draft.line).toBe("a line one\nline two!");
    } finally { editor.close(); }
  });

  test("a modal reads kitty Escape and Ctrl+C as escape", async () => {
    const { editor, input } = setup();
    const keys: string[] = [];
    try {
      editor.setModal((key) => keys.push(key));
      input.write("\u001b[99;5u\u001b[106;1u\u001b[13;2u");
      input.write("\u001b[27u");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(keys).toEqual(["escape", "down", "enter", "escape"]);
    } finally { editor.close(); }
  });
});

describe("full-screen chat input", () => {
  test("modal search consumes shortcut letters and Backspace without changing the composer", () => {
    const { editor, input, submit } = setup();
    const keys: string[] = [];
    let searching = false;
    let query = "";
    try {
      input.write("saved draft");
      editor.setModal(key => { keys.push(key); if (key === "search") searching = true; if (key === "enter") searching = false; }, char => {
        if (!searching) return false;
        if (char === "\u007f") query = [...query].slice(0, -1).join("");
        else if (char >= " ") query += char;
        else return false;
        return true;
      });
      input.write("/sjnqé\u007f\r\t\u007fs");
      expect(query).toBe("sjnq");
      expect(keys).toEqual(["search", "enter", "tab", "parent", "sort"]);
      expect(editor.draft.line).toBe("saved draft");
      expect(submit).not.toHaveBeenCalled();
    } finally { editor.close(); }
  });
  test("Ctrl+C clears and empty Escape interrupts once without quitting", async () => {
    let now = 0;
    const onEmptyEscape = vi.fn();
    const { editor, input, quit } = setup(false, undefined, { onEmptyEscape, now: () => now });
    try {
      input.write("draft\u0003");
      expect(editor.draft.line).toBe("");
      expect(onEmptyEscape).not.toHaveBeenCalled();
      input.write("\u0003");
      expect(quit).not.toHaveBeenCalled();
      expect(onEmptyEscape).not.toHaveBeenCalled();
      input.write("another\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.draft).toEqual({ line: "", cursor: 0 });
      expect(onEmptyEscape).not.toHaveBeenCalled();
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(onEmptyEscape).toHaveBeenCalledOnce();
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(onEmptyEscape).toHaveBeenCalledOnce();
      now = 900;
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      now = 1000;
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(onEmptyEscape).toHaveBeenCalledOnce();
      now = 2000;
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(onEmptyEscape).toHaveBeenCalledTimes(2);
      expect(quit).not.toHaveBeenCalled();
      input.write("\u0004");
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      editor.close();
    }
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("empty Escape dismisses suggestions before interrupting", async () => {
    const onEmptyEscape = vi.fn();
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode: vi.fn() });
    const editor = new ChatInputController({
      input,
      columns: 40,
      onSubmit: vi.fn(),
      onQuit: vi.fn(),
      onScroll: vi.fn(),
      onBottom: vi.fn(),
      onChange: vi.fn(),
      onClear: vi.fn(),
      onEmptyEscape,
      completionCount: () => 1,
      complete: () => null
    });
    try {
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.completionVisible).toBe(false);
      expect(onEmptyEscape).not.toHaveBeenCalled();
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(onEmptyEscape).toHaveBeenCalledOnce();
    } finally {
      editor.close();
    }
  });

  test("two Escape presses buffered together clear the draft then interrupt", async () => {
    const onEmptyEscape = vi.fn();
    const { editor, input } = setup(false, undefined, { onEmptyEscape });
    try {
      input.write("draft\u001b\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.draft.line).toBe("");
      expect(onEmptyEscape).toHaveBeenCalledOnce();
    } finally { editor.close(); }
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
      input.write("\u0010");
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

  test("menu selection, Enter acceptance, and Escape clears a nonempty draft", async () => {
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
      expect(editor.draft.line).toContain("@c");
      input.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(editor.draft).toEqual({ line: "", cursor: 0 });
      expect(editor.completionVisible).toBe(false);
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

test("empty-draft arrows recall prompts and never use chunk boundaries to guess wheel events", () => {
  const { editor, input, scroll } = setup(true);
  try {
    input.write("first\rsecond\rthird\r");
    input.write("\u001b[A\u001b[A");
    expect(editor.draft.line).toBe("second");
    input.write("\u001bOA");
    expect(editor.draft.line).toBe("first");
    input.write("\u001b[B\u001bOB");
    expect(editor.draft.line).toBe("third");
    expect(scroll).not.toHaveBeenCalled();
  } finally { editor.close(); }
});

test("wheel reports retain pointer row across split input without mutating the draft", () => {
  const wheel = vi.fn();
  const { editor, input, scroll } = setup(false, wheel);
  try {
    input.write("draft\u001b[<64;12;");
    input.write("4M\u001b[<65;12;22M\u001b[<64;12;4m");
    expect(wheel.mock.calls).toEqual([[4, -1], [22, 1]]);
    expect(scroll).not.toHaveBeenCalled();
    expect(editor.draft.line).toBe("draft");
    editor.scrollPrompt(-1);
  } finally { editor.close(); }
});

test("Alt+Left/Right asks to switch rooms without sending, and a draft can be restored", () => {
  const input = new PassThrough();
  const submitted: string[] = [];
  const cycles: number[] = [];
  const editor = new ChatInputController({
    input, columns: 80,
    onChange: () => {}, onSubmit: (line) => submitted.push(line), onScroll: () => {}, onBottom: () => {},
    onQuit: () => {}, onClear: () => {}, complete: () => null,
    onCycleRoom: (direction) => cycles.push(direction)
  });
  try {
    input.write("draft for api");
    input.write("\u001b[1;3C\u001b[1;3D");
    input.write("\u001b[1;9C\u001b[1;9D");
    input.write("\u001b\u001b[C\u001b\u001b[D");
    input.write("\u001b[6;5~\u001b[5;5~");
    expect(cycles).toEqual([1, -1, 1, -1, 1, -1, 1, -1]);
    expect(editor.draft.line).toBe("draft for api");
    expect(submitted).toEqual([]);
    input.write("\u001bb");
    expect(editor.draft.cursor).toBe(10); // Meta-b keeps readline's word-back binding in a draft.
    expect(cycles).toHaveLength(8);
    editor.setDraft("restored draft");
    expect(editor.draft).toEqual({ line: "restored draft", cursor: "restored draft".length });
    editor.setDraft("");
    input.write("\u001bf\u001bb");
    expect(cycles.slice(-2)).toEqual([1, -1]);
    input.write("\u001b");
    input.write("\u001b[");
    input.write("C");
    expect(cycles.at(-1)).toBe(1);
  } finally {
    editor.close();
  }
});

test("/go is a keyboard picker: arrows choose a room and one Enter switches", () => {
  const input = new PassThrough();
  const submitted: string[] = [];
  const rooms = [
    { name: "api", description: "api · 1 agent" },
    { name: "docs", description: "docs · 1 agent" },
    { name: "web", description: "web · 1 agent" }
  ];
  const matches = (draft: { line: string; cursor: number }) => getChatCompletions(draft, [], [], rooms);
  const editor = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: (line) => submitted.push(line),
    onScroll: () => {}, onBottom: () => {}, onQuit: () => {}, onClear: () => {},
    completionCount: (draft) => matches(draft).length,
    complete: (draft, index) => matches(draft)[index]?.draft ?? null
  });
  try {
    input.write("/go");
    expect(matches(editor.draft).map((entry) => entry.label)).toEqual(["#api", "#docs", "#web"]);
    input.write("\u001b[B\r");
    expect(submitted).toEqual(["/go docs"]);
    expect(editor.draft.line).toBe("");
    input.write("/go #w");
    expect(editor.draft.line).toBe("/go #w");
    input.write("\r");
    expect(submitted).toEqual(["/go docs", "/go web"]);
  } finally { editor.close(); }
});

test("/go completes room names and path-suffix parts, keeping text after the cursor", () => {
  const rooms = [
    { name: "root", description: ". · 1 agent" },
    { name: "svc/api", description: "svc/api · 2 agents" },
    { name: "web/api", description: "web/api · 0 agents" },
    { name: "docs", description: "docs · 0 agents" }
  ];
  const offered = (line: string) => getChatCompletions({ line, cursor: line.length }, [], [], rooms).map((entry) => entry.label);
  expect(offered("/go")).toEqual(["#root", "#svc/api", "#web/api", "#docs"]);
  expect(offered("/go ")).toEqual(["#root", "#svc/api", "#web/api", "#docs"]);
  expect(offered("/go a")).toEqual(["#svc/api", "#web/api"]);
  expect(offered("/go #we")).toEqual(["#web/api"]);
  expect(getChatCompletions({ line: "/go api", cursor: 7 }, [], [], [
    { name: "api-v2", description: "" }, { name: "api", description: "" }
  ]).map((entry) => entry.label)).toEqual(["#api", "#api-v2"]);
  expect(offered("/go zz")).toEqual([]);
  const [first] = getChatCompletions({ line: "/go do", cursor: 6 }, [], [], rooms);
  expect(first.draft).toEqual({ line: "/go docs ", cursor: 9 });
  expect(offered("/g")).toContain("/go <room|dir>");
});


test("right-click reports retain coordinates and modifiers without entering the draft", () => {
  const click = vi.fn();
  const { editor, input } = setup(false, undefined, { onRightClick: click });
  try {
    input.write("\u001b[<2;12;");
    input.write("24M\u001b[<18;20;24M\u001b[<2;12;24m\u001b[<0;1;1M");
    expect(click.mock.calls).toEqual([[12, 24], [20, 24]]);
    expect(editor.draft.line).toBe("");
  } finally { editor.close(); }
});


test("Ctrl+T opens the room picker without changing a draft or treating paste as a shortcut", () => {
  const open = vi.fn();
  const { editor, input } = setup(false, undefined, { onRoomTree: open });
  try {
    input.write("draft\u0014");
    expect(open).toHaveBeenCalledTimes(1);
    expect(editor.draft.line).toBe("draft");
    input.write("\u001b[200~pasted\u0014text\u001b[201~");
    expect(open).toHaveBeenCalledTimes(1);
  } finally { editor.close(); }
});
