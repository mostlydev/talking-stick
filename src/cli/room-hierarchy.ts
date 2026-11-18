import path from "node:path";
import { isWithinOrSame } from "../path-resolution.js";
import type { NavigatorRoom } from "./room-navigator.js";

export interface RoomHierarchyRow {
  path: string;
  parent?: string;
  depth: number;
  room?: NavigatorRoom;
  hiddenRoom?: NavigatorRoom;
  children: string[];
  expanded: boolean;
  agents: number;
  consoles: number;
  unread: number;
  /** Blocked headless workers here and below. */
  blocked: number;
}
interface Node {
  path: string;
  room?: NavigatorRoom;
  children: Node[];
  activity: string;
  members: number;
  boundary: boolean;
  agents: number;
  consoles: number;
  unread: number;
  blocked: number;
}

/** Virtual folders come only from room paths, never a filesystem walk. */
export function roomHierarchyRows(rooms: NavigatorRoom[], sort: "activity" | "name" | "path" | "members",
  expanded: Set<string>, collapsed: Set<string>, filtered: boolean, knownRooms = rooms): RoomHierarchyRow[] {
  if (!rooms.length) return [];
  let common = knownRooms[0].path;
  while (knownRooms.some(room => !isWithinOrSame(room.path, common))) common = path.dirname(common);
  const boundaries = new Set(knownRooms.map(room => room.path));
  const knownByPath = new Map(knownRooms.map(room => [room.path, room]));
  const nodes = new Map<string, Node>();
  const ensure = (directory: string): Node => {
    const found = nodes.get(directory);
    if (found) return found;
    const node: Node = { path: directory, children: [], activity: "", members: 0,
      boundary: boundaries.has(directory), agents: 0, consoles: 0, unread: 0, blocked: 0 };
    nodes.set(directory, node);
    if (directory !== common) ensure(path.dirname(directory)).children.push(node);
    return node;
  };
  for (const room of rooms) ensure(room.path).room = room;
  const root = nodes.get(common)!;
  const prepare = (node: Node): Node => {
    node.activity = node.room?.last_activity_at ?? "";
    node.members = (node.room?.agents ?? 0) + (node.room?.consoles ?? 0);
    node.agents = node.room?.agents ?? 0;
    node.consoles = node.room?.consoles ?? 0;
    node.unread = node.room?.unread ?? 0;
    node.blocked = node.room?.blocked ?? 0;
    node.children = node.children.map(prepare);
    for (const child of node.children) {
      if (child.activity > node.activity) node.activity = child.activity;
      node.members += child.members;
      node.agents += child.agents;
      node.consoles += child.consoles;
      node.unread += child.unread;
      node.blocked += child.blocked;
    }
    node.children.sort((a, b) => {
      const order = sort === "activity" ? b.activity.localeCompare(a.activity)
        : sort === "members" ? b.members - a.members
        : sort === "name" ? path.basename(a.path).localeCompare(path.basename(b.path))
        : a.path.localeCompare(b.path);
      return order || a.path.localeCompare(b.path);
    });
    // Keep every room boundary, even when it has just one descendant room.
    return !node.boundary && node.children.length === 1 ? node.children[0] : node;
  };
  const rows: RoomHierarchyRow[] = [];
  const visit = (node: Node, depth: number, parent?: string) => {
    const open = !collapsed.has(node.path) && (rooms.length <= 30 || filtered || expanded.has(node.path));
    rows.push({ path: node.path, parent, depth, room: node.room, hiddenRoom: node.room ? undefined : knownByPath.get(node.path), children: node.children.map(child => child.path), expanded: open,
      agents: node.agents, consoles: node.consoles, unread: node.unread, blocked: node.blocked });
    if (open) for (const child of node.children) visit(child, depth + 1, node.path);
  };
  const prepared = prepare(root);
  if (prepared.path === path.parse(prepared.path).root && !prepared.boundary) {
    for (const child of prepared.children) visit(child, 0);
  } else visit(prepared, 0);
  return rows;
}
