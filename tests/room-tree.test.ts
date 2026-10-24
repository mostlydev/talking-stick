import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { RoomTree } from "../src/cli/room-tree.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-tree-")));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const dir of ["api/deep", "empty", "ignored", "untracked/.talking-stick", "nested", ".hidden"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
  fs.writeFileSync(path.join(root, "api", "file.ts"), "");
  fs.writeFileSync(path.join(root, "untracked", ".talking-stick", "room.toml"), "");
  execFileSync("git", ["-C", root, "add", "api/file.ts"]);
  execFileSync("git", ["init", "-q", path.join(root, "nested")]);
  return root;
}
test("lazy listing includes empty/untracked rooms, excludes ignored, hidden and nested repositories", () => {
  const root = fixture();
  const tree = new RoomTree(root, [], root);
  expect(tree.children(root).map(dir => path.basename(dir))).toEqual(["api", "empty", "untracked"]);
  expect(tree.ownRoom(path.join(root, "untracked"))).toBe(true);
  fs.mkdirSync(path.join(root, "later"));
  expect(tree.children(root).map(dir => path.basename(dir))).not.toContain("later");
  const fresh = new RoomTree(root, [{ path: path.join(root, "ignored"), agents: 1, unread: 0 }], root);
  expect(fresh.children(root)).toContain(path.join(root, "ignored"));
});
test("arrow navigation expands, enters children, collapses and returns to parent", () => {
  const root = fixture();
  const tree = new RoomTree(root, [], root);
  tree.key("right");
  expect(tree.selected).toBe(path.join(root, "api"));
  tree.key("right");
  tree.key("right");
  expect(tree.selected).toBe(path.join(root, "api/deep"));
  tree.key("left");
  expect(tree.selected).toBe(path.join(root, "api"));
  tree.key("left");
  expect(tree.expanded.has(tree.selected)).toBe(false);
  expect(tree.key("enter")).toEqual({ kind: "go", path: tree.selected });
  tree.key("no");
  expect(tree.confirm).toBe(tree.selected);
  tree.key("escape");
  expect(tree.confirm).toBeNull();
  tree.key("no");
  expect(tree.key("yes")).toEqual({ kind: "create", path: tree.selected });
});
test("render shows own-room counts, unread counts, collapsed totals and current room", () => {
  const root = fixture();
  const tree = new RoomTree(root, [{ path: root, agents: 2, unread: 0 },
    { path: path.join(root, "api/deep"), agents: 3, unread: 4 }], root);
  const text = tree.render(10, root, false).join("\n");
  expect(text).toContain("* ● 2");
  expect(text).toContain("api +3 below");
  tree.selected = path.join(root, "api"); tree.key("right");
  expect(tree.render(10, root, false).join("\n")).toContain("deep ● 3 · 4 for you");
  expect(tree.render(3, root, false)).toHaveLength(3);
});


test("opens focused on current room with ancestors expanded and marks known leaves", () => {
  const root = fixture();
  const current = path.join(root, "api/deep");
  const tree = new RoomTree(root, [{ path: current, agents: 1, unread: 0 }], current);
  expect(tree.selected).toBe(current);
  expect(tree.rows().some(row => row.path === current)).toBe(true);
  tree.key("right");
  expect(tree.expanded.has(current)).toBe(false);
  expect(tree.render(10, current, false).join("\n")).toContain("· deep * ● 1");
});
