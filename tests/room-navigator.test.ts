import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { RoomNavigator, type NavigatorRoom } from "../src/cli/room-navigator.js";
import { roomHierarchyRows } from "../src/cli/room-hierarchy.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tt-nav-")));
  dirs.push(root);
  for (const name of ["one", "two"]) fs.mkdirSync(path.join(root, name, ".git"), { recursive: true });
  const rooms: NavigatorRoom[] = [
    { id: "a", path: path.join(root, "one"), name: "one", agents: 1, consoles: 0, unread: 2, active: true, last_activity_at: "2026-10-20" },
    { id: "b", path: path.join(root, "two"), name: "two", agents: 2, consoles: 1, unread: 0, active: true, last_activity_at: "2026-10-21" },
    { id: "c", path: path.join(root, "gone"), name: "gone", agents: 0, consoles: 0, unread: 0, active: false, last_activity_at: "2026-10-22" }
  ];
  return { root, rooms, nav: new RoomNavigator(rooms[0].path, rooms, rooms[0].path) };
}
test("active host list sorts, filters and keeps selection stable on refresh", () => {
  const { nav, rooms } = fixture();
  expect(nav.view).toBe("folders");
  nav.key("tab");
  expect(nav.render(10, "", false)[0]).toContain("Rooms · Active");
  expect(nav.list().map(room => room.id)).toEqual(["a", "b"]);
  nav.key("all");
  expect(nav.list().map(room => room.id)).toEqual(["c", "a", "b"]);
  nav.key("all");
  expect(nav.selected).toBe(rooms[0].path);
  nav.key("sort");
  expect(nav.list().map(room => room.id)).toEqual(["a", "b"]);
  nav.key("sort");
  expect(nav.list().map(room => room.id)).toEqual(["b", "a"]);
  nav.key("search");
  for (const char of "two") expect(nav.text(char)).toBe(true);
  expect(nav.list().map(room => room.id)).toEqual(["b"]);
  expect(nav.key("enter")).toEqual({ kind: "room", id: "b" });
  nav.rooms = rooms.map(room => ({ ...room, last_activity_at: "2026-10-23" }));
  expect(nav.selected).toBe(rooms[1].path);
  nav.key("search"); nav.text("\u007f");
  expect(nav.query).toBe("tw");
  expect(nav.tree.root).toBe(rooms[0].path);
});
test("folder parent navigation crosses repositories lazily and opens the exact selected path", () => {
  const { nav, root, rooms } = fixture();
  nav.key("parent");
  expect(nav.tree.root).toBe(root);
  expect(nav.tree.children(root)).toContain(rooms[1].path);
  nav.tree.selected = rooms[1].path;
  expect(nav.key("enter")).toEqual({ kind: "go", path: rooms[1].path });
  nav.key("tab");
  expect(nav.view).toBe("rooms");
});
test("arrows and Enter work while filtering; activity ties have deterministic path order", () => {
  const { nav, rooms } = fixture();
  nav.key("tab");
  nav.rooms = rooms.map(room => ({ ...room, last_activity_at: "2026-10-23" }));
  expect(nav.list().map(room => room.id)).toEqual(["a", "b"]);
  nav.key("search");
  nav.key("down");
  expect(nav.searching).toBe(true);
  expect(nav.key("enter")).toEqual({ kind: "room", id: "b" });
});
test("search consumes shortcut letters, empty results are bounded, unavailable live rooms remain visible", () => {
  const { nav, rooms } = fixture();
  nav.key("tab");
  nav.rooms = [...rooms, { ...rooms[2], active: true, agents: 1 }];
  nav.key("search");
  for (const char of "gone") nav.text(char);
  const text = nav.render(7, "", false).join("\n");
  expect(text).toContain("gone");
  expect(text).toContain("unavailable");
  nav.text("z");
  expect(nav.key("down")).toEqual({ kind: "none" });
  nav.key("enter");
  expect(nav.key("enter")).toEqual({ kind: "none" });
  expect(nav.render(3, "", false).length).toBeLessThanOrEqual(3);
  expect(nav.key("escape")).toEqual({ kind: "close" });
});

test("Rooms presents shared ancestors once, preserves nested rooms and filters the hierarchy", () => {
  const { nav, root, rooms } = fixture();
  const child = path.join(rooms[0].path, "api");
  nav.rooms = [...rooms, { ...rooms[0], id: "api", path: child, name: "api" }];
  nav.key("tab");
  const text = nav.render(20, "", false).join("\n");
  expect(text.split(root).length).toBe(2);
  expect(text).toMatch(/▾ one/);
  expect(text).toMatch(/\s+· api/);
  expect(text).toMatch(/· two/);
  nav.key("right");
  expect(nav.selected).toBe(child);
  nav.key("parent");
  expect(nav.selected).toBe(rooms[0].path);
  nav.key("left");
  expect(nav.render(20, "", false).join("\n")).not.toMatch(/· api/);
  nav.key("search");
  for (const char of "api") nav.text(char);
  expect(nav.render(20, "", false).join("\n")).not.toContain("two");
  expect(nav.key("enter")).toEqual({ kind: "room", id: "api" });
});

test("inactive ancestor room boundaries remain as branches and distant rooms do not expose a synthetic root", () => {
  const { rooms, root } = fixture();
  const child = { ...rooms[0], id: "api", path: path.join(rooms[0].path, "api"), name: "api" };
  const remote = { ...rooms[1], path: path.join(path.parse(root).root, "tt-distant-branch", "room") };
  const known = [{ ...rooms[0], active: false }, child, remote];
  const rows = roomHierarchyRows([child, remote], "name", new Set(), new Set(), false, known);
  expect(rows.some(row => row.path === path.parse(root).root)).toBe(false);
  expect(rows.filter(row => row.depth === 0)).toHaveLength(2);
  expect(rows.find(row => row.path === rooms[0].path)).toMatchObject({ room: undefined, children: [child.path] });
  expect(rows.find(row => row.path === child.path)?.room?.id).toBe("api");
});

test("collapsed large branches roll up hidden agents, consoles and unread counts", () => {
  const { nav, rooms, root } = fixture();
  nav.rooms = [rooms[0], ...Array.from({ length: 35 }, (_, index) => ({ ...rooms[1], id: `child-${index}`,
    name: `r${index}`, path: path.join(root, "group", `r${index}`), agents: 1, consoles: 1, unread: 1 }))];
  nav.key("tab");
  const text = nav.render(15, "", false).join("\n");
  expect(text).toContain("▸ group");
  expect(text).toContain("+35 agents · 35 consoles · 35 for you below");
  expect(text).not.toContain("r34");
});

test("sibling sorting uses descendant activity and member totals without flattening branches", () => {
  const { root, rooms } = fixture();
  const data = [
    { ...rooms[0], path: path.join(root, "alpha", "one"), agents: 4, consoles: 0, last_activity_at: "2026-10-20" },
    { ...rooms[0], id: "a2", path: path.join(root, "alpha", "two"), agents: 4, consoles: 0, last_activity_at: "2026-10-21" },
    { ...rooms[1], path: path.join(root, "beta", "one"), agents: 1, consoles: 0, last_activity_at: "2026-10-22" }
  ];
  const children = (sort: "activity" | "members") => roomHierarchyRows(data, sort, new Set(), new Set(), false)
    .filter(row => row.depth === 1).map(row => row.path);
  expect(children("activity")).toEqual([path.join(root, "beta", "one"), path.join(root, "alpha")]);
  expect(children("members")).toEqual([path.join(root, "alpha"), path.join(root, "beta", "one")]);
});

test("search selects the first matching room in tree order rather than alias order", () => {
  const { nav, root, rooms } = fixture();
  nav.rooms = [{ ...rooms[0], path: path.join(root, "aaa"), name: "zzz" },
    { ...rooms[1], path: path.join(root, "zzz"), name: "aaa" }];
  nav.key("tab"); nav.key("search");
  for (const char of path.basename(root)) nav.text(char);
  expect(nav.selected).toBe(path.join(root, "aaa"));
});
