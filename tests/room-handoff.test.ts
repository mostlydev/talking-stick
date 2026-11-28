import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { TalkingStickService } from "../src/index.js";
import { exportRoomLogbook, readRoomLogbookExport } from "../src/room-handoff.js";
import { readDeclaration, ROOM_DECLARATION_FILE } from "../src/path-resolution.js";

const ALPHA = "claude:first";
const BETA = "codex:second";
const OPERATOR = "human:operator";
const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "room-handoff-"));
  clean.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const project = path.join(root, "old project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const service = new TalkingStickService({ dataDir, processLivenessChecker: () => "alive" });
  clean.push(() => service.close());
  return { root, project, service };
}

test("after a physical rename, the new room inherits stories but no live state", () => {
  const { root, project, service } = setup();
  const original = service.joinPath({ context_path: project, agent_id: ALPHA });
  const oldRoom = original.room_id;
  service.joinPath({ context_path: project, agent_id: BETA });
  const marker = path.join(project, ROOM_DECLARATION_FILE);
  fs.mkdirSync(path.dirname(marker));
  fs.writeFileSync(marker, 'name = "workshop"\n');
  const snapshot = service.startRoomHandoff(oldRoom, OPERATOR);
  expect(snapshot.requested).toEqual([ALPHA, BETA]);
  expect(readDeclaration(marker)).toMatchObject({ id: expect.any(String), name: "workshop", problem: null });
  const direct = service.getRoomEvents({ room_id: oldRoom, agent_id: OPERATOR, include_all: true })
    .filter(event => event.event_type === "message_sent");
  expect(direct.map(event => event.to_agent_id)).toEqual([ALPHA, BETA]);
  expect(direct.every(event => event.payload?.body?.includes(snapshot.snapshot_id))).toBe(true);
  expect(() => service.addRoomHandoffStory(oldRoom, "codex:visitor", "Cannot add")).toThrow("Join");
  const story = service.addRoomHandoffStory(oldRoom, ALPHA, "From my seat, the work is ready.", snapshot.snapshot_id);
  expect(service.addRoomHandoffStory(oldRoom, ALPHA, story.body, snapshot.snapshot_id)).toEqual(story);
  expect(() => service.addRoomHandoffStory(oldRoom, ALPHA, "Overwrite")).toThrow("already contributed");
  expect(service.roomHandoffPointer(oldRoom)).toMatchObject({ story_count: 1, missing_count: 1, inherited: false });

  // Removing the old room row must not remove the authored material.
  service.leaveRoom({ room_id: oldRoom, agent_id: ALPHA });
  service.leaveRoom({ room_id: oldRoom, agent_id: BETA });
  const destination = path.join(root, "new project");
  fs.renameSync(project, destination);
  const joined = service.joinPath({ context_path: destination, agent_id: "agy:new" });
  expect(joined.room_id).not.toBe(oldRoom);
  expect(joined.members.map(member => member.agent_id)).toEqual(["agy:new"]);
  expect(joined.room_state.owner).toBeNull();
  expect(joined.room_handoff).toMatchObject({ inherited: true, snapshot_id: snapshot.snapshot_id, source_path: original.canonical_path });
  expect(service.showRoomHandoff(joined.room_id)?.stories).toEqual([story]);
  expect(service.joinPath({ context_path: destination, agent_id: "agy:new" }).room_handoff).toBeUndefined();
  expect(() => service.addRoomHandoffStory(joined.room_id, "agy:new", "Old snapshot")).toThrow("Start a room handoff here");
});

test("even a copied ID is scoped to the declared workshop", () => {
  const { project, service } = setup();
  const folder = path.join(project, "one");
  fs.mkdirSync(folder);
  const firstMarker = path.join(folder, ROOM_DECLARATION_FILE);
  fs.mkdirSync(path.dirname(firstMarker));
  const declaration = 'id = "682636d6-a073-4ccc-a3fd-f1d47dffd39a"\n';
  fs.writeFileSync(firstMarker, declaration);
  const first = service.joinPath({ context_path: folder, agent_id: ALPHA });
  service.startRoomHandoff(first.room_id, OPERATOR);
  service.addRoomHandoffStory(first.room_id, ALPHA, "One workshop only.");

  const sibling = path.join(project, "two");
  const secondMarker = path.join(sibling, ROOM_DECLARATION_FILE);
  fs.mkdirSync(path.dirname(secondMarker), { recursive: true });
  fs.writeFileSync(secondMarker, declaration);
  const second = service.joinPath({ context_path: sibling, agent_id: BETA });
  expect(second.room_handoff).toBeUndefined();
  expect(service.showRoomHandoff(second.room_id)).toBeNull();
});

test("export and import preserve dates and authors and never overwrite an existing directory", () => {
  const { root, project, service } = setup();
  const source = service.joinPath({ context_path: project, agent_id: ALPHA }).room_id;
  service.startRoomHandoff(source, OPERATOR);
  const story = service.addRoomHandoffStory(source, ALPHA, "A first-person account.");
  const output = path.join(root, "portable");
  const pathToContext = exportRoomLogbook(output, service.showRoomHandoff(source)!);
  expect(fs.readFileSync(pathToContext, "utf8")).toMatch(/\[claude:first\]\(story-1.md\)/);
  expect(fs.readFileSync(path.join(output, "story-1.md"), "utf8")).toContain(story.body);
  expect(() => exportRoomLogbook(output, service.showRoomHandoff(source)!)).toThrow(/EEXIST/);
  const past = readRoomLogbookExport(output);
  expect(past.stories).toEqual([story]);

  const other = path.join(root, "other");
  fs.mkdirSync(other);
  const target = service.joinPath({ context_path: other, agent_id: BETA }).room_id;
  service.startRoomHandoff(target, OPERATOR);
  const imported = service.importRoomHandoff(target, OPERATOR, past);
  expect(service.showRoomHandoff(target)).toEqual(imported);
  expect(imported.snapshot_id).not.toBe(past.snapshot_id);
  expect(imported.stories).toEqual([story]);
  expect(imported.created_at).toBe(past.created_at);
});
