import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";
import { syncSkills } from "../../../src/assembly/skills.ts";

const REVIEW = [
  "---",
  "name: review",
  'description: "Use when a PR has new review threads."',
  "---",
  "",
  "# review",
  "",
  "Stop after {{ values.review.rounds }} rounds; fix {{values.review.fix}}.",
  "",
].join("\n");

const SOURCE = "tpl/skills/review/SKILL.md";
const RENDERED = ".agents/skills/review/SKILL.md";

type Call = (op: string, input?: object) => Promise<Record<string, unknown>>;

/** A project with no blocks that imported tpl/forge.template.json, which carries values and one skill. */
async function withTemplate(
  run: (root: string, call: Call) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-template-skills-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(
    ".forge/config.yaml",
    JSON.stringify({ schemaVersion: "forge.config/1", blocks: {} }),
  );
  put(
    "tpl/forge.template.json",
    JSON.stringify({
      schemaVersion: "forge.template/1",
      id: "acme/delivery",
      version: "1.0.0",
      summary: "Delivery loop.",
      config: {
        schemaVersion: "forge.config/1",
        blocks: {},
        values: { review: { rounds: 2, fix: ["P0", "P1"] } },
      },
    }),
  );
  put(SOURCE, REVIEW);
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const raw: Call = async (op, input = {}) => {
    const result = await dispatch(
      assembly.catalog,
      op,
      input,
      localCall(assembly),
    );
    return { ...result, ...(record(result.ok ? result.result : {}) ?? {}) };
  };
  // fills in the current revision for writes
  const call: Call = async (op, input = {}) =>
    raw(
      op,
      "expectRevision" in input
        ? {
            ...input,
            expectRevision: String((await raw("config.show")).revision),
          }
        : input,
    );
  try {
    expect(
      await call("template.import", {
        template: "tpl/forge.template.json",
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    await run(root, call);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("skills sync renders a template skill from the project's values, and re-renders when one changes", async () => {
  await withTemplate(async (root, call) => {
    expect(existsSync(join(root, ".forge/skills"))).toBe(false);
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      written: [RENDERED],
      removed: [],
    });
    const first = readFileSync(join(root, RENDERED), "utf8");
    expect(first).toContain("Stop after 2 rounds; fix P0, P1.");
    expect(first).toContain(`---\n${GENERATED_MARKER}\n\n# review`);
    expect(
      await call("config.set", {
        path: "/values/review/rounds",
        value: 3,
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    expect(await call("skills.sync")).toMatchObject({ written: [RENDERED] });
    expect(readFileSync(join(root, RENDERED), "utf8")).toContain(
      "Stop after 3 rounds;",
    );
    // the template's source is read, never copied: editing it changes the next sync
    writeFileSync(join(root, SOURCE), REVIEW.replace("Stop", "Halt"));
    await call("skills.sync");
    expect(readFileSync(join(root, RENDERED), "utf8")).toContain(
      "Halt after 3",
    );
  });
}, 30_000);

test("sync copies nested binary companions and checks every copy without writing", async () => {
  await withTemplate(async (root, call) => {
    const missing = await call("skills.sync", { check: true });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing)).toContain(RENDERED);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    const source = join(root, "tpl/skills/review/agents");
    mkdirSync(source);
    const bytes = Buffer.from([0, 255, 128, 10]);
    writeFileSync(join(source, "data.bin"), bytes);
    expect(await call("skills.sync")).toMatchObject({ ok: true });
    const companion = join(root, ".agents/skills/review/agents/data.bin");
    expect(readFileSync(companion)).toEqual(bytes);
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: true,
      written: [],
      removed: [],
    });
    const target = join(root, RENDERED);
    writeFileSync(target, `${readFileSync(target, "utf8")}hand edit\n`);
    writeFileSync(companion, "edited companion");
    const before = [readFileSync(target), readFileSync(companion)];
    const checked = await call("skills.sync", { check: true });
    expect(checked.ok).toBe(false);
    for (const path of [
      RENDERED,
      "review/agents/data.bin",
      "run forge skills sync",
    ])
      expect(JSON.stringify(checked)).toContain(path);
    expect([readFileSync(target), readFileSync(companion)]).toEqual(before);
    await call("skills.sync");
    const synced = readFileSync(target);
    writeFileSync(join(root, SOURCE), REVIEW.replace("Stop", "Halt"));
    const stale = await call("skills.sync", { check: true });
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale)).toContain(RENDERED);
    expect(readFileSync(target)).toEqual(synced);
  });
}, 30_000);

test("sync deduplicates normalized adapter directories", async () => {
  await withTemplate((root) => {
    const synced = syncSkills(
      root,
      [],
      undefined,
      [".claude/skills", ".claude/skills/", ".agents/skills"],
      {
        sources: [{ root, file: "tpl/forge.template.json" }],
        values: { review: { rounds: 2, fix: [] } },
      },
    );
    expect(synced.written).toEqual([
      ".claude/skills/review/SKILL.md",
      RENDERED,
    ]);
    expect(synced.unchanged).toEqual([]);
  });
}, 30_000);

test("check reports obsolete companions and sync retires them with their managed skill", async () => {
  await withTemplate(async (root, call) => {
    const companion = "review/old.txt";
    writeFileSync(join(root, "tpl/skills", companion), "old companion");
    await call("skills.sync");
    rmSync(join(root, "tpl/skills", companion));
    const checked = await call("skills.sync", { check: true });
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).toContain(companion);
    expect(readFileSync(join(root, ".agents/skills", companion), "utf8")).toBe(
      "old companion",
    );
    expect(await call("skills.sync")).toMatchObject({
      removed: [`.agents/skills/${companion}`],
    });
    expect(existsSync(join(root, ".agents/skills", companion))).toBe(false);
    writeFileSync(join(root, "tpl/skills", companion), "restored companion");
    await call("skills.sync");
    await call("template.remove", {
      template: "acme/delivery",
      expectRevision: "",
    });
    const retired = await call("skills.sync");
    expect(retired.ok).toBe(true);
    expect(retired.removed).toContain(RENDERED);
    expect(retired.removed).toContain(`.agents/skills/${companion}`);
  });
}, 30_000);

test("sync never adopts an unmarked directory through a new companion", async () => {
  await withTemplate(async (root, call) => {
    writeFileSync(join(root, "tpl/skills/review/custom.txt"), "template");
    mkdirSync(join(root, ".agents/skills/review"), { recursive: true });
    const mine = join(root, ".agents/skills/review/custom.txt");
    writeFileSync(mine, "mine");
    for (let attempt = 0; attempt < 2; attempt++) {
      const synced = await call("skills.sync");
      expect(synced.ok).toBe(true);
      expect(synced.skipped).toContain(RENDERED);
      expect(readFileSync(mine, "utf8")).toBe("mine");
      expect(existsSync(join(root, RENDERED))).toBe(false);
    }
  });
}, 30_000);

for (const link of ["review/link", "linked-skill"])
  test(`retiring companions refuses internal directory symlink ${link}`, async () => {
    await withTemplate(async (root, call) => {
      await call("skills.sync");
      mkdirSync(join(root, "personal"));
      const mine = join(root, "personal/mine.txt");
      writeFileSync(mine, "mine");
      writeFileSync(join(root, "personal/SKILL.md"), GENERATED_MARKER);
      symlinkSync(
        join(root, "personal"),
        join(root, ".agents/skills", link),
        process.platform === "win32" ? "junction" : "dir",
      );
      const refused = await call("skills.sync");
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).toContain("symlink");
      expect(readFileSync(mine, "utf8")).toBe("mine");
    });
  }, 30_000);

for (const kind of ["parent", "absolute", "symlink"] as const)
  test(`sync refuses ${kind} adapter directory before any copy is written`, async () => {
    await withTemplate((root) => {
      const outside = mkdtempSync(join(tmpdir(), "forge-skills-outside-"));
      try {
        if (kind === "symlink")
          symlinkSync(
            outside,
            join(root, "escape"),
            process.platform === "win32" ? "junction" : "dir",
          );
        const bad =
          kind === "parent"
            ? "../outside"
            : kind === "absolute"
              ? outside
              : "escape/skills";
        expect(() =>
          syncSkills(root, [], undefined, ["safe/skills", bad], {
            sources: [{ root, file: "tpl/forge.template.json" }],
            values: { review: { rounds: 2, fix: [] } },
          }),
        ).toThrow(/refusing/);
        expect(existsSync(join(root, "safe"))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }, 30_000);

test("an unknown placeholder fails skills sync and names the placeholder", async () => {
  await withTemplate(async (root, call) => {
    writeFileSync(
      join(root, SOURCE),
      `${REVIEW}Merge by {{values.merge.by}}.\n`,
    );
    const failed = await call("skills.sync");
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).toContain("{{values.merge.by}}");
    expect(existsSync(join(root, RENDERED))).toBe(false);
  });
}, 30_000);

test("removing the template, then syncing, deletes its generated skill and keeps hand-written ones", async () => {
  await withTemplate(async (root, call) => {
    await call("skills.sync", { dir: "custom/skills" });
    const generated = join(root, "custom/skills/review/SKILL.md");
    expect(existsSync(generated)).toBe(true);
    const mine = join(root, "custom/skills/mine/SKILL.md");
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "---\nname: mine\ndescription: mine\n---\n");
    writeFileSync(join(root, "custom/skills/README.md"), "stray file");
    expect(
      await call("template.remove", {
        template: "acme/delivery",
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    expect(await call("skills.sync", { dir: "custom/skills" })).toMatchObject({
      ok: true,
      written: [],
      removed: ["custom/skills/review/SKILL.md"],
    });
    expect(existsSync(generated)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });
}, 30_000);

test("a generated skill converted to CRLF is still recognized: updated when values change, removed with its template", async () => {
  await withTemplate(async (root, call) => {
    await call("skills.sync");
    const target = join(root, RENDERED);
    const toCrlf = (): void =>
      writeFileSync(
        target,
        readFileSync(target, "utf8").replace(/\r?\n/g, "\r\n"),
      );
    toCrlf();
    expect(
      await call("config.set", {
        path: "/values/review/rounds",
        value: 5,
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    expect(await call("skills.sync")).toMatchObject({
      written: [RENDERED],
      skipped: [],
    });
    const updated = readFileSync(target, "utf8");
    expect(updated).toContain("Stop after 5 rounds;");
    expect(updated).not.toContain("\r");
    toCrlf();
    await call("template.remove", {
      template: "acme/delivery",
      expectRevision: "",
    });
    expect(await call("skills.sync")).toMatchObject({ removed: [RENDERED] });
    expect(existsSync(target)).toBe(false);
  });
}, 30_000);

test("a hand-written file at a template skill's target is reported and left untouched", async () => {
  await withTemplate(async (root, call) => {
    const mine = "---\nname: review\ndescription: mine\n---\n";
    mkdirSync(dirname(join(root, RENDERED)), { recursive: true });
    writeFileSync(join(root, RENDERED), mine);
    const checked = await call("skills.sync", { check: true });
    expect(checked.ok).toBe(false);
    expect(JSON.stringify(checked)).toContain(`${RENDERED}: hand-edited copy`);
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(mine);
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      written: [],
      skipped: [RENDERED],
      removed: [],
    });
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(mine);
  });
}, 30_000);
