import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ProtocolError } from "./errors.js";
import { ROOM_DECLARATION_FILE, ROOM_DECLARATION_ID, readDeclaration, resolveContextPath } from "./path-resolution.js";
import type { SqliteDatabase } from "./sqlite.js";

const MAX_STORY_BYTES = 32 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export interface RoomHandoffPointer {
  snapshot_id: string;
  source_path: string;
  created_at: string;
  story_count: number;
  missing_count: number;
  inherited: boolean;
}

export interface RoomHandoffStory {
  agent_id: string;
  created_at: string;
  body: string;
}

export interface RoomHandoffLogbook {
  snapshot_id: string;
  source_path: string;
  created_at: string;
  context: string;
  requested: string[];
  stories: RoomHandoffStory[];
}

interface SnapshotRow {
  snapshot_id: string;
  source_room_id: string;
  source_path: string;
  created_at: string;
  context: string;
  requested_json: string;
}

function declarationIdentity(directory: string): { id: string; scope: string } | null {
  if (!fs.existsSync(path.join(directory, ROOM_DECLARATION_FILE))) return null;
  const resolved = resolveContextPath(directory);
  const declaration = resolved.declaration;
  return declaration?.id && !declaration.problem && declaration.directory === resolved.canonical_context_path
    ? { id: declaration.id, scope: declaration.rel_path }
    : null;
}

/** Seed older declarations explicitly. Join and other read paths never write to the checkout. */
export function enableRoomHandoff(directory: string): void {
  const file = path.join(directory, ROOM_DECLARATION_FILE);
  const existing = fs.statSync(file, { throwIfNoEntry: false });
  if (existing && readDeclaration(file).id) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + ".handoff-lock";
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProtocolError("invalid_input", "The room declaration is being updated. Retry after it finishes.");
    }
    throw error;
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const old = fs.statSync(file, { throwIfNoEntry: false });
    if (old) {
      const declaration = readDeclaration(file);
      if (declaration.problem) throw new ProtocolError("invalid_input", declaration.problem);
      if (declaration.id) return;
    }
    const text = old ? fs.readFileSync(file, "utf8") : "# shrooms room boundary.\n";
    fs.writeFileSync(temporary, `${text}${text.endsWith("\n") ? "" : "\n"}id = "${randomUUID()}"\n`,
      { flag: "wx", mode: old?.mode ?? 0o644 });
    if (!old) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

export class RoomHandoffStore {
  constructor(private readonly db: SqliteDatabase) {}

  private lookup(directory: string, snapshotId?: string): SnapshotRow | undefined {
    const identity = declarationIdentity(directory);
    if (!identity) return undefined;
    return this.db.prepare<[string, string, string | null, string | null], SnapshotRow>(`
      SELECT * FROM room_handoff_snapshots
      WHERE declaration_id = ? AND room_scope = ? AND (? IS NULL OR snapshot_id = ?)
      ORDER BY rowid DESC LIMIT 1`)
      .get(identity.id, identity.scope, snapshotId ?? null, snapshotId ?? null);
  }

  pointer(directory: string, roomId: string): RoomHandoffPointer | null {
    const snapshot = this.lookup(directory);
    if (!snapshot) return null;
    const stories = this.stories(snapshot.snapshot_id);
    const authors = new Set(stories.map(story => story.agent_id));
    const requested = JSON.parse(snapshot.requested_json) as string[];
    return { snapshot_id: snapshot.snapshot_id, source_path: snapshot.source_path, created_at: snapshot.created_at,
      story_count: authors.size, missing_count: requested.filter(agent => !authors.has(agent)).length,
      inherited: snapshot.source_room_id !== roomId };
  }

  show(directory: string, snapshotId?: string): RoomHandoffLogbook | null {
    const snapshot = this.lookup(directory, snapshotId);
    if (!snapshot) return null;
    const { snapshot_id, source_path, created_at, context, requested_json } = snapshot;
    return { snapshot_id, source_path, created_at, context, requested: JSON.parse(requested_json) as string[],
      stories: this.stories(snapshot_id) };
  }

  private stories(snapshotId: string): RoomHandoffStory[] {
    return this.db.prepare<[string], RoomHandoffStory>(`
      SELECT agent_id, created_at, body FROM room_handoff_stories WHERE snapshot_id = ? ORDER BY agent_id`).all(snapshotId);
  }

  insert(directory: string, roomId: string, source: Omit<RoomHandoffLogbook, "snapshot_id">): RoomHandoffLogbook {
    const identity = declarationIdentity(directory);
    if (!identity) throw new ProtocolError("invalid_input", "Enable a shrooms declaration for this room first.");
    const snapshotId = randomUUID();
    this.db.prepare(`INSERT INTO room_handoff_snapshots
      (snapshot_id, declaration_id, room_scope, source_room_id, source_path, created_at, context, requested_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshotId, identity.id, identity.scope, roomId, source.source_path, source.created_at, source.context,
        JSON.stringify(source.requested));
    for (const story of source.stories) this.saveStory(snapshotId, story);
    return { ...source, snapshot_id: snapshotId };
  }

  add(directory: string, roomId: string, story: RoomHandoffStory, snapshotId?: string): RoomHandoffStory {
    const snapshot = this.lookup(directory, snapshotId);
    if (!snapshot || snapshot.source_room_id !== roomId) {
      throw new ProtocolError("invalid_input", "Start a room handoff here before contributing a story.");
    }
    const prior = this.db.prepare<[string, string], RoomHandoffStory>(
      "SELECT agent_id, created_at, body FROM room_handoff_stories WHERE snapshot_id = ? AND agent_id = ?")
      .get(snapshot.snapshot_id, story.agent_id);
    if (prior) {
      if (prior.body === story.body) return prior;
      throw new ProtocolError("invalid_input", "This member already contributed to the snapshot. Start another handoff for a new story.");
    }
    this.saveStory(snapshot.snapshot_id, story);
    return story;
  }

  private saveStory(snapshotId: string, story: RoomHandoffStory): void {
    if (!story.body.trim() || Buffer.byteLength(story.body) > MAX_STORY_BYTES) {
      throw new ProtocolError("invalid_input", "A handoff story must contain text and fit in 32 KiB.");
    }
    this.db.prepare(`INSERT INTO room_handoff_stories (snapshot_id, agent_id, created_at, body)
      VALUES (?, ?, ?, ?)`).run(snapshotId, story.agent_id, story.created_at, story.body);
  }
}

export function renderRoomLogbook(logbook: RoomHandoffLogbook): string {
  const lines = ["# Room logbook", "", `Snapshot: ${logbook.snapshot_id}`, `Date: ${logbook.created_at}`,
    `Source room: ${logbook.source_path}`, "", logbook.context, "", "## Individual stories", ""];
  const authors = new Set(logbook.stories.map(story => story.agent_id));
  for (const [index, story] of logbook.stories.entries()) {
    lines.push(`- [${story.agent_id}](story-${index + 1}.md) · ${story.created_at}`);
  }
  const missing = logbook.requested.filter(agent => !authors.has(agent));
  if (missing.length) lines.push("", `Still missing: ${missing.join(", ")}`);
  return lines.join("\n") + "\n";
}

export function exportRoomLogbook(directory: string, logbook: RoomHandoffLogbook): string {
  const encoded = JSON.stringify(logbook);
  if (Buffer.byteLength(encoded) > MAX_BUNDLE_BYTES) throw new Error("This room handoff exceeds the export limit.");
  // Reserve a new directory so an existing CONTEXT.md can never be overwritten.
  fs.mkdirSync(directory, { mode: 0o700 });
  const created: string[] = [];
  try {
    const write = (name: string, value: string) => {
      const file = path.join(directory, name);
      const fd = fs.openSync(file, "wx", 0o600);
      created.push(file);
      try { fs.writeFileSync(fd, value); }
      finally { fs.closeSync(fd); }
    };
    for (const [index, story] of logbook.stories.entries()) {
      write(`story-${index + 1}.md`, `# ${story.agent_id}\n\n${story.created_at}\n\n${story.body}\n`);
    }
    write("handoff.json", encoded);
    write("CONTEXT.md", renderRoomLogbook(logbook));
  } catch (error) {
    for (const file of created) fs.rmSync(file, { force: true });
    try { fs.rmdirSync(directory); } catch { /* A concurrent caller added a file. */ }
    throw error;
  }
  return path.join(directory, "CONTEXT.md");
}

export function readRoomLogbookExport(directory: string): RoomHandoffLogbook {
  const file = path.join(directory, "handoff.json");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error("Invalid room handoff bundle.");
    const bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw new Error("Room handoff changed while being read.");
    value = JSON.parse(bytes.subarray(0, stat.size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
  const parsed = value as Partial<RoomHandoffLogbook> | null;
  const date = (input: unknown): input is string => typeof input === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)
    && Number.isFinite(Date.parse(input));
  const author = (input: unknown): input is string => typeof input === "string" && /^[\w:.-]{1,128}$/.test(input);
  if (!parsed || typeof parsed.snapshot_id !== "string" || !ROOM_DECLARATION_ID.test(parsed.snapshot_id) ||
      typeof parsed.source_path !== "string" || !parsed.source_path || !date(parsed.created_at) ||
      typeof parsed.context !== "string" || !Array.isArray(parsed.requested) || !parsed.requested.every(author) ||
      !Array.isArray(parsed.stories) || !parsed.stories.every(story => story && author(story.agent_id) && date(story.created_at)
        && typeof story.body === "string" && story.body.trim() && Buffer.byteLength(story.body) <= MAX_STORY_BYTES) ||
      new Set(parsed.stories.map(story => story.agent_id)).size !== parsed.stories.length) {
    throw new Error("Invalid room handoff bundle.");
  }
  return { snapshot_id: parsed.snapshot_id, source_path: parsed.source_path, created_at: parsed.created_at,
    context: parsed.context, requested: parsed.requested,
    stories: parsed.stories.map(({ agent_id, created_at, body }) => ({ agent_id, created_at, body })) };
}
