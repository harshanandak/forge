import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  failureOf,
  type Fixture,
  type FixtureOptions,
  makeProject,
} from "../l4-config/lib/project.ts";

const open: Fixture[] = [];
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

const REVIEW = "---\nname: review\ndescription: review\n---\n# review\n";
const SHIP = "---\nname: ship\ndescription: ship\n---\n# ship\n";
const TEMPLATE = "tpl/forge.template.json";

/** A project with a template file at tpl/ that carries the review and ship skills. */
function project(options: FixtureOptions = {}): Fixture {
  const p = makeProject(options);
  open.push(p);
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(p.root, path)), { recursive: true });
    writeFileSync(join(p.root, path), text);
  };
  put(
    TEMPLATE,
    JSON.stringify({
      schemaVersion: "forge.template/1",
      id: "acme/delivery",
      version: "1.0.0",
      summary: "Delivery loop.",
      config: {
        schemaVersion: "forge.config/1",
        blocks: {},
        skills: ["review", "ship"],
      },
    }),
  );
  put("tpl/skills/review/SKILL.md", REVIEW);
  put("tpl/skills/ship/SKILL.md", SHIP);
  return p;
}

const importIt = (p: Fixture, expectRevision = p.config.show().revision) =>
  p.templates.importTemplate({ template: TEMPLATE, expectRevision });

test("import refuses when a skill file is already there with other content, naming it and writing nothing", () => {
  const p = project();
  const mine = join(p.root, ".forge/skills/ship/SKILL.md");
  mkdirSync(dirname(mine), { recursive: true });
  writeFileSync(mine, "my own ship skill\n");
  const failure = failureOf(() => importIt(p));
  expect(failure?.code).toBe("INPUT_CONFLICT");
  expect(failure?.message).toContain(".forge/skills/ship/SKILL.md");
  expect(readFileSync(mine, "utf8")).toBe("my own ship skill\n");
  expect(existsSync(join(p.root, ".forge/skills/review/SKILL.md"))).toBe(false);
  expect(p.read()).toBeUndefined();
}, 30_000);

test("import accepts a skill file that is already there with the same content", () => {
  const p = project();
  const same = join(p.root, ".forge/skills/ship/SKILL.md");
  mkdirSync(dirname(same), { recursive: true });
  writeFileSync(same, SHIP);
  expect(importIt(p).template).toBe("acme/delivery@1.0.0");
  expect(
    readFileSync(join(p.root, ".forge/skills/review/SKILL.md"), "utf8"),
  ).toBe(REVIEW);
}, 30_000);

test("a failing skill write leaves the config unchanged and takes back the skills already copied", () => {
  const p = project({
    files: (real) => ({
      ...real,
      write(path, bytes) {
        if (path === ".forge/skills/ship/SKILL.md")
          throw new Error("disk full");
        real.write(path, bytes);
      },
    }),
  });
  expect(() => importIt(p)).toThrow("disk full");
  expect(p.read()).toBeUndefined();
  expect(existsSync(join(p.root, ".forge/skills/review/SKILL.md"))).toBe(false);
}, 30_000);

test("a refused config write takes back the copied skills", () => {
  const p = project();
  const failure = failureOf(() => importIt(p, "stale"));
  expect(failure?.code).toBe("REVISION_CONFLICT");
  expect(existsSync(join(p.root, ".forge/skills/review/SKILL.md"))).toBe(false);
  expect(existsSync(join(p.root, ".forge/skills/ship/SKILL.md"))).toBe(false);
  expect(importIt(p).template).toBe("acme/delivery@1.0.0");
}, 30_000);
