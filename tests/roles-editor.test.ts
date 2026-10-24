import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { ChatInputController, type ChatModalKey } from "../src/cli/chat-input.js";
import { createRolesEditor, renderRolesEditor, rolesEditorKey, rolesEditorDraft, rolesEditorDirty, type RolesEditorState } from "../src/cli/roles-editor.js";
import { textWidth } from "../src/cli/chat-view.js";

function editor(): RolesEditorState {
  return createRolesEditor({ agents: ["claude:a", "codex:b"],
    assignments: [{ subject: "agent:codex:b", roles: ["implementer", "lint-czar"] }], userDefaults: {}, version: 2 });
}
function press(state: RolesEditorState, ...keys: ChatModalKey[]) {
  let current = state;
  let action;
  for (const key of keys) ({ state: current, action } = rolesEditorKey(current, key));
  return { state: current, action };
}

test("room rows are exact sessions; harness defaults have their own scope", () => {
  const state = editor();
  expect(state.rows.map(r => r.agent_id)).toEqual(["claude:a", "codex:b"]);
  expect(state.columns).toContain("lint-czar");
  expect(state.rows[1].source).toBe("agent");
  const defaults = press(state, "tab").state;
  expect(defaults.tab).toBe("defaults");
  expect(defaults.defaultRows.map(r => r.label)).toContain("grok");
  expect(renderRolesEditor(defaults, { color: false } as never)[0]).toContain("Harness defaults · all rooms");
});

test("many-to-many toggles stay draft until Enter, and dirty Esc confirms", () => {
  const { state, action } = press(editor(), "down", "right", "right", "space", "enter");
  expect(action).toEqual({ kind: "apply", changes: [{ subject: "agent:codex:b", roles: ["implementer", "lint-czar", "reviewer"] }] });
  expect(rolesEditorDirty(state)).toBe(true);
  const confirm = press(state, "escape");
  expect(confirm.action).toEqual({ kind: "none" });
  expect(confirm.state.confirmDiscard).toBe(true);
  expect(press(confirm.state, "no").state.confirmDiscard).toBe(false);
  expect(press(confirm.state, "yes").action).toEqual({ kind: "cancel" });
  expect(press(editor(), "space", "space", "enter").action).toEqual({ kind: "apply", changes: [] });
});

test("default edits update inherited rows without creating exact-session overrides", () => {
  let state = press(editor(), "tab", "space").state; // Claude default no longer architect
  expect(state.rows[0].roles).toEqual([]);
  expect(rolesEditorDraft(state)).toEqual({ changes: [], defaults: { claude: [] } });
  state = press(state, "tab").state;
  expect(state.rows[1].roles).toEqual(["implementer", "lint-czar"]);
  expect(state.rows[0].edited).toBe(false);
});

test("reset removes an override instead of saving equivalent explicit roles", () => {
  const state = createRolesEditor({ agents: ["codex:a"], assignments: [{ subject: "agent:codex:a", roles: ["reviewer"] }],
    userDefaults: { codex: ["tester"] }, version: 0 });
  const room = press(state, "reset").state;
  expect(room.rows[0].roles).toEqual(["tester"]);
  expect(rolesEditorDraft(room).changes).toEqual([{ subject: "agent:codex:a", roles: null }]);
  const defaults = press(state, "tab", "down", "reset").state;
  expect(rolesEditorDraft(defaults).defaults).toEqual({ codex: null });
});

test("preview/help Enter never applies; project editing is explicit and disabled in defaults", () => {
  expect(press(editor(), "edit").action).toEqual({ kind: "edit_role", name: "architect" });
  expect(press(editor(), "no").action).toEqual({ kind: "new_role" });
  expect(press(editor(), "instructions").action).toEqual({ kind: "edit_instructions" });
  expect(press(editor(), "preview", "enter").action).toEqual({ kind: "none" });
  expect(press(editor(), "help", "enter").action).toEqual({ kind: "none" });
  expect(press(editor(), "tab", "edit").state.notice).toContain("project-scoped");
});

test("fixed panel dimensions and definition/footer anchors survive navigation and changes", () => {
  const initial = editor();
  for (const [height, width] of [[18, 79], [22, 100], [13, 48]]) {
    const a = renderRolesEditor(initial, { color: true } as never, height, width);
    const changed = press(initial, "down", "right", "space").state;
    changed.notifications = ["codex:b +architect", "another room: grok:a -reviewer", "third agent"];
    const b = renderRolesEditor(changed, { color: true } as never, height, width);
    expect(a).toHaveLength(height); expect(b).toHaveLength(height);
    expect(a[height-1]).toContain("Space"); expect(b[height-1]).toContain("Space");
    expect(b[height-10]).toContain("implementer");
    expect([...a,...b].every(line => textWidth(line) <= width)).toBe(true);
  }
});

test("selection scrolls in both axes and wide/untrusted names stay inside the frame", () => {
  const state = createRolesEditor({ agents: Array.from({ length: 20 }, (_, i) => `codex:${i}`), assignments: [], userDefaults: {}, version: 0,
    nameOf: () => "界界界\n\u001b[2Jdisplay", definitions: [{ name: "security-auditor", text: "Verify.", source: "project" }] });
  const last = press(state, "up").state;
  const lines = renderRolesEditor(last, { color: false } as never, 18, 80);
  expect(lines.some(line => line.startsWith("›"))).toBe(true);
  expect(lines.every(line => textWidth(line) <= 80 && !line.includes("\n") && !line.includes("\u001b"))).toBe(true);
  expect(renderRolesEditor(last, { color: false } as never, 8, 30)).toHaveLength(8);
});

test("a modal swallows keys: nothing is submitted and the draft survives", async () => {
  const input = new PassThrough();
  const submitted: string[] = [];
  const keys: ChatModalKey[] = [];
  const controller = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: (line) => submitted.push(line), onScroll: () => {},
    onBottom: () => {}, onQuit: () => {}, onClear: () => {}, complete: () => null
  });
  try {
    input.write("half typed");
    controller.setModal((key) => keys.push(key));
    input.write(" \r\u001b[B\u001b[C dq\r");
    input.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(keys).toEqual(["space", "enter", "down", "right", "space", "default", "quit", "enter", "escape"]);
    controller.setModal(null);
    expect(controller.draft.line).toBe("half typed");
    expect(submitted).toEqual([]);
  } finally {
    controller.close();
  }
});

test("modal keys survive split escape sequences and pasted text is never a command", async () => {
  const input = new PassThrough();
  const keys: ChatModalKey[] = [];
  const controller = new ChatInputController({
    input, columns: 80, onChange: () => {}, onSubmit: () => {}, onScroll: () => {},
    onBottom: () => {}, onQuit: () => {}, onClear: () => {}, complete: () => null
  });
  try {
    controller.setModal((key) => keys.push(key));
    input.write("\u001b");
    input.write("[A");
    input.write("\u001b[200~d \rsecret");
    input.write(" more\r\u001b[2");
    input.write("01~");
    input.write("\u001b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(keys).toEqual(["up", "escape"]);
  } finally {
    controller.close();
  }
});

test("the global next-unread key never changes or discards a roles draft", () => {
  const dirty = press(editor(), "down", "right", "space").state;
  expect(rolesEditorDirty(dirty)).toBe(true);
  const after = rolesEditorKey(dirty, "next_unread");
  expect(after.action).toEqual({ kind: "none" });
  expect(rolesEditorDraft(after.state)).toEqual(rolesEditorDraft(dirty));
});
