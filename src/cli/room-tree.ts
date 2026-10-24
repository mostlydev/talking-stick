import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { insideNestedRepository, isWithinOrSame, ROOM_DECLARATION_FILE } from "../path-resolution.js";
import { sanitizeChatText } from "./chat-format.js";
import type { ChatModalKey } from "./chat-input.js";

export interface TreeRoom { path: string; agents: number; unread: number }
export interface TreeRow { path: string; depth: number }
export type TreeAction = { kind: "none" | "close" } | { kind: "go" | "create"; path: string };

export class RoomTree {
  readonly expanded = new Set<string>();
  private readonly childrenCache = new Map<string, string[]>();
  selected: string;
  confirm: string | null = null;
  notice: string | null = null;
  rooms: TreeRoom[];

  constructor(public root: string, rooms: TreeRoom[], readonly current: string, private readonly crossRepositories = false) {
    this.rooms = rooms;
    this.selected = isWithinOrSame(current, root) ? current : root;
    this.expanded.add(root);
    let ancestor = path.dirname(this.selected);
    while (isWithinOrSame(ancestor, root)) {
      this.expanded.add(ancestor);
      if (ancestor === root) break;
      ancestor = path.dirname(ancestor);
    }
  }

  children(directory: string): string[] {
    const cached = this.childrenCache.get(directory);
    if (cached) return cached;
    const known = this.rooms.filter(room => isWithinOrSame(room.path, directory) && room.path !== directory)
      .map(room => path.join(directory, path.relative(directory, room.path).split(path.sep)[0]));
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== ".git" && entry.name !== ".talking-stick")
        .map(entry => path.join(directory, entry.name));
    } catch { /* A removed or unreadable folder has no children. */ }
    const candidates = [...new Set([...entries, ...known])];
    const ignored = new Set<string>();
    if (candidates.length) {
      try {
        const result = execFileSync("git", ["-C", this.root, "check-ignore", "-z", "--stdin"],
          { input: candidates.join("\0") + "\0", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
        for (const item of result.split("\0").filter(Boolean)) ignored.add(item);
      } catch (error) {
        // Exit 1 means no ignored paths; other failures (non-Git roots) also
        // leave the filesystem listing available.
        const output = (error as { stdout?: string }).stdout;
        if (output) for (const item of String(output).split("\0").filter(Boolean)) ignored.add(item);
      }
    }
    const children = candidates.filter(candidate => isWithinOrSame(candidate, this.root) &&
      (this.crossRepositories || !insideNestedRepository(candidate, this.root)) &&
      ((!ignored.has(candidate) && !path.basename(candidate).startsWith(".")) || known.includes(candidate) || fs.existsSync(path.join(candidate, ROOM_DECLARATION_FILE))))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    this.childrenCache.set(directory, children);
    return children;
  }

  rows(): TreeRow[] {
    const rows: TreeRow[] = [];
    const visit = (directory: string, depth: number) => {
      rows.push({ path: directory, depth });
      if (this.expanded.has(directory)) for (const child of this.children(directory)) visit(child, depth + 1);
    };
    visit(this.root, 0);
    return rows;
  }

  ownRoom(directory: string): boolean {
    return (!this.crossRepositories && directory === this.root) || this.rooms.some(room => room.path === directory) ||
      fs.existsSync(path.join(directory, ROOM_DECLARATION_FILE));
  }

  parent(): void {
    const previous = this.root;
    const parent = path.dirname(previous);
    if (parent === previous) return;
    this.root = parent;
    this.childrenCache.clear();
    this.expanded.clear();
    this.expanded.add(parent);
    this.selected = previous;
  }

  key(key: ChatModalKey): TreeAction {
    this.notice = null;
    if (this.confirm) {
      if (key === "yes") return { kind: "create", path: this.confirm };
      if (key === "no" || key === "escape") this.confirm = null;
      return { kind: "none" };
    }
    const rows = this.rows();
    const index = Math.max(0, rows.findIndex(row => row.path === this.selected));
    if (key === "escape") return { kind: "close" };
    if (key === "up" || key === "down") this.selected = rows[Math.max(0, Math.min(rows.length - 1, index + (key === "up" ? -1 : 1)))].path;
    if (key === "right") {
      if (!this.expanded.has(this.selected) && this.children(this.selected).length) this.expanded.add(this.selected);
      else this.selected = this.children(this.selected)[0] ?? this.selected;
    }
    if (key === "left") {
      if (this.expanded.has(this.selected)) this.expanded.delete(this.selected);
      else if (this.selected !== this.root) this.selected = path.dirname(this.selected);
      else if (this.crossRepositories) this.parent();
    }
    if (key === "enter") return { kind: "go", path: this.selected };
    if (key === "no" && !this.ownRoom(this.selected)) this.confirm = this.selected;
    return { kind: "none" };
  }

  render(maxLines: number, resolvedRoom: string, color: boolean): string[] {
    const dim = (text: string) => color ? `\u001b[2m${text}\u001b[0m` : text;
    if (this.confirm) return ["Create a room boundary?", sanitizeChatText(path.join(this.confirm, ROOM_DECLARATION_FILE)), "y create and open · n / Esc cancel"];
    const rows = this.rows();
    const selected = Math.max(0, rows.findIndex(row => row.path === this.selected));
    const capacity = Math.max(1, maxLines - 2);
    const start = Math.max(0, selected - capacity + 1);
    const lines = rows.slice(start, start + capacity).map(row => {
      const room = this.rooms.find(room => room.path === row.path);
      const own = this.ownRoom(row.path);
      const below = this.rooms.filter(room => room.path !== row.path && isWithinOrSame(room.path, row.path))
        .reduce((count, room) => count + room.agents, 0);
      const name = sanitizeChatText(row.path === this.root ? path.basename(this.root) : path.basename(row.path));
      const marker = row.path === this.current ? " *" : "";
      const counts = own ? ` ● ${room?.agents ?? 0}${room?.unread ? ` · ${room.unread} for you` : ""}` : "";
      const rollup = !this.expanded.has(row.path) && below ? dim(` +${below} below`) : "";
      return `${row.path === this.selected ? "›" : " "} ${"  ".repeat(row.depth)}${this.childrenCache.get(row.path)?.length === 0 ? "·" : this.expanded.has(row.path) ? "▾" : "▸"} ${own ? name : dim(name)}${marker}${counts}${rollup}`;
    });
    return ["Rooms · ↑↓ select · ←→ expand · Enter open · n new · Esc close", ...lines,
      this.notice ?? `Room: ${sanitizeChatText(resolvedRoom)}`];
  }
}
