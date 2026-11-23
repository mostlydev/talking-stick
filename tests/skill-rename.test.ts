import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { digestDirectory, recordManagedContent } from "../src/managed-content.js";
import {
  LEGACY_SKILL_RENAMES,
  migrateLegacySkillInstalls,
  resolveBundledSkillPath
} from "../src/skill-install.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skill-rename-"));
  roots.push(root);
  const options = { homeDir: root, dataDir: path.join(root, "data"), env: { XDG_CONFIG_HOME: path.join(root, ".config") } };
  const claude = (name: string) => path.join(root, ".claude", "skills", name);
  const shared = (name: string) => path.join(root, ".agents", "skills", name);
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  return { root, options, claude, shared };
}

const bundled = (name: string) => resolveBundledSkillPath({ skillName: name });
const run = (options: object) => migrateLegacySkillInstalls({ ...options, markOffers: false });

describe("moving skills to their new names", () => {
  test("the bundle ships redirect stubs under the old names, and the new skills beside them", () => {
    expect(LEGACY_SKILL_RENAMES).toEqual([["talking-stick", "rooms"], ["talking-stick-rooms", "rooms-oversee"]]);
    for (const [legacy, current] of LEGACY_SKILL_RENAMES) {
      expect(fs.readFileSync(path.join(bundled(legacy), "SKILL.md"), "utf8")).toContain(`../${current}/SKILL.md`);
      expect(fs.readFileSync(path.join(bundled(current), "SKILL.md"), "utf8")).toMatch(new RegExp(`^---\nname: ${current}\n`));
    }
  });

  test("an unedited managed link moves to the new name, and a second run changes nothing", () => {
    const { options, claude, shared } = home();
    // A link made before 0.39 now resolves to the shipped stub.
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    fs.symlinkSync(bundled("talking-stick-rooms"), shared("talking-stick-rooms"), "dir");
    const results = run(options);
    expect(results.map((result) => [result.status, path.basename(result.legacyPath)]).sort()).toEqual([
      ["renamed", "talking-stick"], ["renamed", "talking-stick-rooms"]
    ]);
    expect(fs.existsSync(claude("talking-stick"))).toBe(false);
    expect(fs.realpathSync(claude("rooms"))).toBe(fs.realpathSync(bundled("rooms")));
    expect(fs.existsSync(shared("talking-stick-rooms"))).toBe(false);
    expect(fs.realpathSync(shared("rooms-oversee"))).toBe(fs.realpathSync(bundled("rooms-oversee")));
    expect(run(options)).toEqual([]);
  });

  test("a link left dangling by a removed release still moves", () => {
    const { root, options, claude } = home();
    const gone = path.join(root, "share", "releases", "0.38.0-abc", "skills", "talking-stick");
    fs.symlinkSync(gone, claude("talking-stick"), "dir");
    expect(run(options)).toMatchObject([{ status: "renamed" }]);
    expect(fs.lstatSync(claude("talking-stick"), { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.realpathSync(claude("rooms"))).toBe(fs.realpathSync(bundled("rooms")));
  });

  test("an unedited copy is replaced by a copy of the new skill; an edited copy stays", () => {
    const { options, claude, shared } = home();
    fs.cpSync(bundled("talking-stick"), claude("talking-stick"), { recursive: true });
    recordManagedContent(claude("talking-stick"), "skill-copy", digestDirectory(claude("talking-stick")), options);
    fs.cpSync(bundled("talking-stick"), shared("talking-stick"), { recursive: true });
    recordManagedContent(shared("talking-stick"), "skill-copy", digestDirectory(shared("talking-stick")), options);
    fs.appendFileSync(path.join(shared("talking-stick"), "SKILL.md"), "\nMy own note.\n");

    const results = run(options);
    expect(results.find((result) => result.legacyPath === claude("talking-stick"))?.status).toBe("renamed");
    expect(fs.lstatSync(claude("rooms")).isDirectory()).toBe(true);
    expect(digestDirectory(claude("rooms"))).toBe(digestDirectory(bundled("rooms")));
    expect(results.find((result) => result.legacyPath === shared("talking-stick"))?.status).toBe("kept_customized");
    expect(fs.readFileSync(path.join(shared("talking-stick"), "SKILL.md"), "utf8")).toContain("My own note.");
    expect(fs.existsSync(shared("rooms"))).toBe(false);
  });

  test("a link to something that isn't from Shrooms is left alone", () => {
    const { root, options, claude } = home();
    const mine = path.join(root, "my-skills", "talking-stick");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: talking-stick\ndescription: mine\n---\n");
    fs.symlinkSync(mine, claude("talking-stick"), "dir");
    expect(run(options)).toMatchObject([{ status: "kept_customized" }]);
    expect(fs.readlinkSync(claude("talking-stick"))).toBe(mine);
    expect(fs.existsSync(claude("rooms"))).toBe(false);
  });

  test("when the new name is already taken by something else, the old link stays and nothing is overwritten", () => {
    const { options, claude } = home();
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    fs.mkdirSync(claude("rooms"));
    fs.writeFileSync(path.join(claude("rooms"), "SKILL.md"), "---\nname: rooms\ndescription: a different rooms skill\n---\n");
    expect(run(options)).toMatchObject([{ status: "kept_occupied" }]);
    expect(fs.existsSync(claude("talking-stick"))).toBe(true);
    expect(fs.readFileSync(path.join(claude("rooms"), "SKILL.md"), "utf8")).toContain("a different rooms skill");
  });

  test("when the new name is already ours, the old link is just removed", () => {
    const { options, claude } = home();
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    fs.symlinkSync(bundled("rooms"), claude("rooms"), "dir");
    expect(run(options)).toMatchObject([{ status: "renamed" }]);
    expect(fs.existsSync(claude("talking-stick"))).toBe(false);
    expect(fs.realpathSync(claude("rooms"))).toBe(fs.realpathSync(bundled("rooms")));
  });

  test("an old duplicate in a harness's own folder is removed without a new copy there", () => {
    const { root, options } = home();
    const codexDuplicate = path.join(root, ".codex", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(codexDuplicate), { recursive: true });
    fs.symlinkSync(bundled("talking-stick"), codexDuplicate, "dir");
    expect(run(options)).toMatchObject([{ status: "renamed", legacyPath: codexDuplicate }]);
    expect(fs.lstatSync(codexDuplicate, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".codex", "skills", "rooms"))).toBe(false);
  });

  test("a new link can point through the installer's current release", () => {
    const { root, options, claude } = home();
    const current = path.join(root, "share", "current", "skills");
    fs.mkdirSync(current, { recursive: true });
    fs.cpSync(bundled("rooms"), path.join(current, "rooms"), { recursive: true });
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    run({ ...options, linkSourceFor: (name: string) => path.join(current, name) });
    expect(fs.readlinkSync(claude("rooms"))).toBe(path.join(current, "rooms"));
  });

  test("a kept old install is mentioned once", () => {
    const { root, options, claude } = home();
    const mine = path.join(root, "my-skills", "talking-stick");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "SKILL.md"), "mine\n");
    fs.symlinkSync(mine, claude("talking-stick"), "dir");
    expect(migrateLegacySkillInstalls(options)).toMatchObject([{ status: "kept_customized", offer: true }]);
    expect(migrateLegacySkillInstalls(options)).toMatchObject([{ status: "kept_customized", offer: false }]);
  });
});
