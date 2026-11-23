import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
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
      const stub = fs.readFileSync(path.join(bundled(legacy), "SKILL.md"), "utf8");
      expect(stub).toMatch(new RegExp(`^---\nname: ${legacy}\n`));
      expect(stub).toContain(`../${current}/SKILL.md`);
      expect(stub).toContain("resolve the link first");
      expect(stub).toContain("tt install --all");
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

  test("an old agy link in ~/.gemini/skills moves to agy's config skills folder", () => {
    const { root, options, shared } = home();
    const legacy = path.join(root, ".gemini", "skills", "talking-stick");
    const target = path.join(root, ".gemini", "config", "skills", "rooms");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(bundled("talking-stick"), legacy, "dir");
    expect(run(options)).toMatchObject([{ status: "renamed", legacyPath: legacy, newPath: target }]);
    expect(fs.lstatSync(legacy, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(bundled("rooms")));
    // agy does not read the shared folder, so nothing is added there.
    expect(fs.existsSync(shared("rooms"))).toBe(false);
  });

  test("a link left dangling by a removed release still moves", () => {
    const { root, options, claude } = home();
    const gone = path.join(root, ".local", "share", "talking-stick", "releases", "0.38.0-abc", "skills", "talking-stick");
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

  test("a link to something that isn't from shrooms is left alone", () => {
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

  test("an install that only exists in a harness's own folder moves to that harness's new location", () => {
    const { root, options, shared } = home();
    const codexOnly = path.join(root, ".codex", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(codexOnly), { recursive: true });
    fs.symlinkSync(bundled("talking-stick"), codexOnly, "dir");
    expect(run(options)).toMatchObject([{ status: "renamed", legacyPath: codexOnly, newPath: shared("rooms") }]);
    expect(fs.lstatSync(codexOnly, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.realpathSync(shared("rooms"))).toBe(fs.realpathSync(bundled("rooms")));
    expect(fs.existsSync(path.join(root, ".codex", "skills", "rooms"))).toBe(false);
  });

  test("an old harness-folder install stays when that harness's new location holds something else", () => {
    const { root, options, shared } = home();
    const codexOnly = path.join(root, ".codex", "skills", "talking-stick");
    fs.mkdirSync(path.dirname(codexOnly), { recursive: true });
    fs.symlinkSync(bundled("talking-stick"), codexOnly, "dir");
    fs.mkdirSync(shared("rooms"));
    fs.writeFileSync(path.join(shared("rooms"), "SKILL.md"), "someone else's rooms\n");
    expect(run(options)).toMatchObject([{ status: "kept_occupied", legacyPath: codexOnly }]);
    expect(fs.existsSync(codexOnly)).toBe(true);
    expect(fs.readFileSync(path.join(shared("rooms"), "SKILL.md"), "utf8")).toBe("someone else's rooms\n");
  });

  test("a dangling link only counts as ours from a known install location or a record", () => {
    const { root, options, claude, shared } = home();
    // Looks like a release layout, but nothing shrooms knows about.
    const elsewhere = path.join(root, ".other", "current", "skills", "talking-stick");
    fs.symlinkSync(elsewhere, claude("talking-stick"), "dir");
    // shrooms recorded this one when it made it, wherever it pointed.
    const recordedLink = shared("talking-stick");
    fs.symlinkSync(path.join(root, ".gone", "skills", "talking-stick"), recordedLink, "dir");
    recordManagedContent(recordedLink, "skill-copy", "f".repeat(64), options);
    const results = run(options);
    expect(results.find((result) => result.legacyPath === claude("talking-stick"))?.status).toBe("kept_customized");
    expect(fs.readlinkSync(claude("talking-stick"))).toBe(elsewhere);
    expect(results.find((result) => result.legacyPath === recordedLink)?.status).toBe("renamed");
  });

  test("a foreign dangling link already at the new name is never replaced", () => {
    const { root, options, claude } = home();
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    const foreign = path.join(root, ".other", "current", "skills", "rooms");
    fs.symlinkSync(foreign, claude("rooms"), "dir");
    expect(run(options)).toMatchObject([{ status: "kept_occupied" }]);
    expect(fs.readlinkSync(claude("rooms"))).toBe(foreign);
    expect(fs.existsSync(claude("talking-stick"))).toBe(true);
  });

  test("if something else appears at the new name during the move, it is kept and so is the old link", () => {
    const { options, claude } = home();
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    const real = fs.symlinkSync;
    const spy = vi.spyOn(fs, "symlinkSync").mockImplementation((target, file, type) => {
      if (String(file) === claude("rooms")) {
        // Another installer wins the race with its own content.
        fs.mkdirSync(claude("rooms"));
        fs.writeFileSync(path.join(claude("rooms"), "SKILL.md"), "raced in\n");
      }
      return real(target, file, type);
    });
    try {
      expect(run(options)).toMatchObject([{ status: "kept_occupied" }]);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(claude("rooms"), "SKILL.md"), "utf8")).toBe("raced in\n");
    expect(fs.realpathSync(claude("talking-stick"))).toBe(fs.realpathSync(bundled("talking-stick")));
  });

  test("even an old dangling link of ours at the new name is left alone, with the old install kept", () => {
    const { root, options, claude } = home();
    fs.symlinkSync(bundled("talking-stick"), claude("talking-stick"), "dir");
    const staleRelease = path.join(root, ".local", "share", "talking-stick", "releases", "0.39.0-gone", "skills", "rooms");
    fs.symlinkSync(staleRelease, claude("rooms"), "dir");
    expect(run(options)).toMatchObject([{ status: "kept_occupied" }]);
    expect(fs.readlinkSync(claude("rooms"))).toBe(staleRelease);
    expect(fs.realpathSync(claude("talking-stick"))).toBe(fs.realpathSync(bundled("talking-stick")));
  });

  test("a copy reserves its folder exclusively, so an empty folder that appears first wins", () => {
    const { options, claude } = home();
    fs.cpSync(bundled("talking-stick"), claude("talking-stick"), { recursive: true });
    recordManagedContent(claude("talking-stick"), "skill-copy", digestDirectory(claude("talking-stick")), options);
    const real = fs.mkdirSync;
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, mode?: fs.MakeDirectoryOptions) => {
      if (String(target) === claude("rooms") && !mode) real(claude("rooms"));
      return real(target, mode);
    }) as typeof fs.mkdirSync);
    try {
      expect(run(options)).toMatchObject([{ status: "kept_occupied" }]);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(claude("rooms"))).toEqual([]);
    expect(fs.existsSync(path.join(claude("talking-stick"), "SKILL.md"))).toBe(true);
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
