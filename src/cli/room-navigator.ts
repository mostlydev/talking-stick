import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RoomTree, type TreeRoom, type TreeAction } from "./room-tree.js";
import { sanitizeChatText } from "./chat-format.js";
import { paintStyle, themeStyle } from "./theme.js";
import { formatRelativeTime } from "./output.js";
import type { ChatModalKey } from "./chat-input.js";
import { roomHierarchyRows, type RoomHierarchyRow } from "./room-hierarchy.js";

export interface NavigatorRoom extends TreeRoom {
  id: string;
  name: string;
  consoles: number;
  active: boolean;
  last_activity_at: string;
}
export type NavigatorAction = TreeAction | { kind: "room"; id: string };
const SORTS = ["name", "path", "activity", "members"] as const;

export class RoomNavigator {
  tree: RoomTree;
  view: "rooms" | "folders" = "folders";
  query = "";
  searching = false;
  allOpen = false;
  sort: typeof SORTS[number] = "name";
  private selectedPath: string;
  private entries: NavigatorRoom[];
  private readonly expandedRooms = new Set<string>();
  private readonly collapsedRooms = new Set<string>();

  constructor(root: string, rooms: NavigatorRoom[], readonly current: string) {
    this.entries = rooms;
    this.tree = new RoomTree(root, rooms, current, true);
    this.selectedPath = current;
    let ancestor = current;
    for (;;) {
      this.expandedRooms.add(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  get rooms(): NavigatorRoom[] { return this.entries; }
  set rooms(rooms: NavigatorRoom[]) { this.entries = rooms; this.tree.rooms = rooms; }
  get selected(): string { return this.view === "folders" ? this.tree.selected : this.selection()?.path ?? ""; }
  get confirm(): string | null { return this.tree.confirm; }
  set confirm(value: string | null) { this.tree.confirm = value; }
  get notice(): string | null { return this.tree.notice; }
  set notice(value: string | null) { this.tree.notice = value; }

  list(): NavigatorRoom[] {
    const query = this.query.toLocaleLowerCase();
    return this.entries.filter(room => (this.allOpen || room.active || room.path === this.current) &&
      `${room.name}\n${room.path}`.toLocaleLowerCase().includes(query)).sort((a, b) => {
      const primary = this.sort === "activity" ? b.last_activity_at.localeCompare(a.last_activity_at)
        : this.sort === "members" ? (b.agents + b.consoles) - (a.agents + a.consoles)
        : this.sort === "name" ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path);
      return primary || a.path.localeCompare(b.path);
    });
  }

  private rows(rooms = this.list()): RoomHierarchyRow[] {
    return roomHierarchyRows(rooms, this.sort, this.expandedRooms, this.collapsedRooms, Boolean(this.query), this.entries);
  }

  private selection(rows = this.rows()): RoomHierarchyRow | undefined {
    return rows.find(row => row.path === this.selectedPath)
      ?? rows.find(row => row.room) ?? rows[0];
  }

  /** A search consumes literal shortcut letters before the modal key mapping. */
  text(char: string): boolean {
    if (!this.searching) return false;
    if (char === "\u007f" || char === "\b") this.query = [...this.query].slice(0, -1).join("");
    else if (char >= " " && char !== "\u007f") this.query += char;
    else return false;
    this.collapsedRooms.clear();
    this.selectedPath = this.rows().find(row => row.room)?.path ?? "";
    return true;
  }

  key(key: ChatModalKey): NavigatorAction {
    if (this.searching) {
      if (key === "escape") { this.searching = false; return { kind: "none" }; }
      if (key === "enter" || key === "tab") this.searching = false;
      else if (!["up", "down", "left", "right", "page_up", "page_down"].includes(key)) return { kind: "none" };
    }
    if (this.confirm) return this.tree.key(key);
    if (key === "tab") {
      if (this.view === "rooms") {
        const selected = this.selection();
        if (selected) this.tree = treeForSelection(this.tree, selected.path, this.rooms, this.current);
      }
      this.view = this.view === "rooms" ? "folders" : "rooms";
      return { kind: "none" };
    }
    if (key === "escape") return { kind: "close" };
    if (this.view === "folders") {
      if (key === "parent") { this.tree.parent(); return { kind: "none" }; }
      return this.tree.key(key);
    }
    if (key === "search") { this.searching = true; return { kind: "none" }; }
    if (key === "sort") this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
    if (key === "all") this.allOpen = !this.allOpen;
    const rows = this.rows();
    const selected = this.selection(rows);
    if (key === "up" || key === "down" || key === "page_up" || key === "page_down") {
      const delta = key === "up" ? -1 : key === "down" ? 1 : key === "page_up" ? -10 : 10;
      const index = rows.findIndex(row => row.path === selected?.path);
      this.selectedPath = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.path ?? "";
    }
    if (selected && (key === "left" || key === "parent")) {
      if (key === "left" && selected.children.length && selected.expanded) {
        this.expandedRooms.delete(selected.path); this.collapsedRooms.add(selected.path);
      } else this.selectedPath = selected.parent ?? selected.path;
    }
    if (selected && (key === "right" || (key === "enter" && !selected.room))) {
      if (selected.children.length && !selected.expanded) {
        this.expandedRooms.add(selected.path); this.collapsedRooms.delete(selected.path);
      } else if (key === "right") this.selectedPath = selected.children[0] ?? selected.path;
      else { this.expandedRooms.delete(selected.path); this.collapsedRooms.add(selected.path); }
    }
    if (key === "enter" && selected?.room) return { kind: "room", id: selected.room.id };
    return { kind: "none" };
  }

  render(maxLines: number, resolvedRoom: string, color: boolean): string[] {
    const safe = sanitizeChatText;
    const accent = (text: string) => paintStyle(color, themeStyle("accent"), text);
    if (this.view === "folders") {
      const lines = this.tree.render(Math.max(1, maxLines - 1), resolvedRoom, color);
      return [`Folders · Tab rooms · Backspace up · ${safe(this.tree.root)}`, ...lines].slice(0, maxLines);
    }
    const list = this.list();
    const rows = this.rows(list);
    const selected = this.selection(rows);
    const capacity = Math.max(1, maxLines - 3);
    const index = Math.max(0, rows.findIndex(row => row.path === selected?.path));
    const start = Math.max(0, index - capacity + 1);
    const lines = rows.slice(start, start + capacity).map(row => {
      const room = row.room;
      const home = os.homedir();
      const rootLabel = row.path === home ? "~" : row.path.startsWith(home + path.sep) ? path.join("~", path.relative(home, row.path)) : row.path;
      const directory = row.parent ? path.relative(row.parent, row.path) : rootLabel;
      const name = safe(directory) + (room && room.name !== path.basename(row.path) ? ` #${safe(room.name)}` : "");
      const hidden = row.hiddenRoom ? row.hiddenRoom.active ? " (room outside filter)" : " (inactive room)" : "";
      const label = room ? accent(name) : paintStyle(color, themeStyle("muted"), name + hidden);
      const counts = room ? `${row.path === this.current ? " *" : ""} · ${room.agents} agents · ${room.consoles} consoles${room.unread ? ` · ${room.unread} for you` : ""}${fs.existsSync(room.path) ? "" : " (unavailable)"}${room.last_activity_at ? ` · ${formatRelativeTime(room.last_activity_at)}` : " · no events"}` : "";
      const rollup = !row.expanded && row.children.length
        ? ` · +${row.agents - (room?.agents ?? 0)} agents · ${row.consoles - (room?.consoles ?? 0)} consoles${row.unread - (room?.unread ?? 0) ? ` · ${row.unread - (room?.unread ?? 0)} for you` : ""} below` : "";
      return `${row.path === selected?.path ? accent("›") : " "} ${"  ".repeat(row.depth)}${row.children.length ? row.expanded ? "▾" : "▸" : "·"} ${label}${counts}${rollup}`;
    });
    if (!lines.length) lines.push("No matching rooms.");
    return [`Rooms · ${this.allOpen ? "All open" : "Active"} · sort: ${this.sort} · ${list.length} rooms`,
      `${this.searching ? "Filter ›" : "Filter:"} ${safe(this.query) || "—"}`,
      ...lines, this.notice ?? "↑↓ select · ←→ branches · Enter open · / filter · s sort · a active/all · Tab folders · Esc close"].slice(0, maxLines);
  }
}

function treeForSelection(tree: RoomTree, selected: string, rooms: NavigatorRoom[], current: string): RoomTree {
  if (tree.selected === selected) return tree;
  return new RoomTree(selected, rooms, current, true);
}
