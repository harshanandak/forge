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
  run: (root: string, call: Call) => Promise<void>,
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

test("marker ownership adopts main copies, preserves user files, restores missing skills and compares text once", async () => {
  await withTemplate(async (root, call) => {
    const folder = dirname(join(root, RENDERED));
    const companion = join(folder, "agents/openai.yaml");
    mkdirSync(dirname(join(root, SOURCE, "../agents/openai.yaml")), {
      recursive: true,
    });
    writeFileSync(
      join(root, "tpl/skills/review/agents/openai.yaml"),
      "policy: false\n",
    );
    await call("skills.sync");
    expect(readFileSync(join(root, RENDERED), "utf8")).toContain(
      `${GENERATED_MARKER}\n<!-- forge companions: agents/openai.yaml -->\n`,
    );
    writeFileSync(join(folder, "NOTES.md"), "mine");
    const crlf = readFileSync(join(root, RENDERED), "utf8").replace(
      /\n/g,
      "\r\n",
    );
    writeFileSync(join(root, RENDERED), crlf);
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: true,
    });
    expect(await call("skills.sync")).toMatchObject({ written: [] });
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(crlf);
    writeFileSync(join(root, RENDERED), `${crlf}\nedit`);
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    expect(await call("skills.sync")).toMatchObject({ written: [RENDERED] });
    rmSync(join(root, RENDERED));
    expect(await call("skills.sync")).toMatchObject({ written: [RENDERED] });
    expect(readFileSync(companion, "utf8")).toBe("policy: false\n");
    expect(readFileSync(join(folder, "NOTES.md"), "utf8")).toBe("mine");
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: true,
    });
  });
}, 30_000);

test("only listed companions are overwritten or retired and empty generated directories are pruned", async () => {
  await withTemplate(async (root, call) => {
    const source = join(root, "tpl/skills/review/agents/openai.yaml");
    const target = join(root, ".agents/skills/review/agents/openai.yaml");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, "first\n");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "user collision\n");
    expect(await call("skills.sync")).toMatchObject({
      skipped: [".agents/skills/review/agents/openai.yaml"],
    });
    expect(readFileSync(join(root, RENDERED), "utf8")).not.toContain(
      "forge companions:",
    );
    expect(readFileSync(target, "utf8")).toBe("user collision\n");
    writeFileSync(target, "first\n");
    await call("skills.sync");
    writeFileSync(target, "edited listed file");
    await call("skills.sync");
    expect(readFileSync(target, "utf8")).toBe("first\n");
    rmSync(source);
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    await call("skills.sync");
    expect(existsSync(dirname(target))).toBe(false);
    writeFileSync(join(root, ".agents/skills/review/NOTES.md"), "mine");
    await call("template.remove", {
      template: "acme/delivery",
      expectRevision: "",
    });
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    await call("skills.sync");
    expect(existsSync(join(root, RENDERED))).toBe(false);
    expect(
      readFileSync(join(root, ".agents/skills/review/NOTES.md"), "utf8"),
    ).toBe("mine");
  });
}, 30_000);

test("unmarked SKILL.md protects its entire folder, including companions", async () => {
  await withTemplate(async (root, call) => {
    mkdirSync(dirname(join(root, RENDERED)), { recursive: true });
    writeFileSync(join(root, RENDERED), "user skill");
    mkdirSync(join(root, "tpl/skills/review/agents"));
    writeFileSync(
      join(root, "tpl/skills/review/agents/openai.yaml"),
      "generated",
    );
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    expect(await call("skills.sync")).toMatchObject({
      skipped: [RENDERED],
      written: [],
    });
    expect(existsSync(join(root, ".agents/skills/review/agents"))).toBe(false);
  });
}, 30_000);

test("invalid companion lists refuse the whole sync before writes, including internal junctions", async () => {
  await withTemplate(async (root, call) => {
    await call("skills.sync");
    const original = readFileSync(join(root, RENDERED), "utf8");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "x"), "untouched");
    symlinkSync(
      outside,
      join(root, ".agents/skills/review/link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of [
      "../x",
      "SKILL.md",
      "agents\\openai.yaml",
      "link/x",
      "/x",
      "a//x",
      "./x",
    ]) {
      const edited = original.replace(
        GENERATED_MARKER,
        `${GENERATED_MARKER}\n<!-- forge companions: ${path} -->`,
      );
      writeFileSync(join(root, RENDERED), edited);
      const result = await call("skills.sync");
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).toContain(path.replace(/\\/g, "\\\\"));
      expect(readFileSync(join(root, RENDERED), "utf8")).toBe(edited);
      expect(readFileSync(join(outside, "x"), "utf8")).toBe("untouched");
    }
  });
}, 30_000);

test("NUL companions compare byte-exact while text companions normalize CRLF", async () => {
  await withTemplate(async (root, call) => {
    const source = join(root, "tpl/skills/review/data.bin");
    const target = join(root, ".agents/skills/review/data.bin");
    writeFileSync(source, Buffer.from([0, 13, 10, 255]));
    await call("skills.sync");
    writeFileSync(source, Buffer.from([0, 10, 255]));
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    await call("skills.sync");
    expect(readFileSync(target)).toEqual(Buffer.from([0, 10, 255]));
  });
}, 30_000);

test("ambiguous companion names cannot turn user files into owned paths", async () => {
  await withTemplate(async (root, call) => {
    for (const name of ["NOTES, extra.md", " leading.md"]) {
      const source = join(root, "tpl/skills/review", name);
      writeFileSync(source, "companion");
      expect(await call("skills.sync")).toMatchObject({ ok: false });
      expect(existsSync(join(root, RENDERED))).toBe(false);
      rmSync(source);
    }
  });
}, 30_000);

test("distinct adapter dirs sync once and retiring a whole generated tree leaves no empty folders", async () => {
  await withTemplate(async (root, call) => {
    const dirs = [
      ".agents/skills",
      "./.agents/skills/",
      ...(["win32", "darwin"].includes(process.platform)
        ? [".AGENTS/skills"]
        : []),
    ];
    const result = syncSkills(root, [], undefined, dirs, {
      sources: [{ root, file: "tpl/forge.template.json" }],
      values: { review: { rounds: 2, fix: ["P0", "P1"] } },
    });
    expect(result.written).toHaveLength(1);
    const retired = join(root, ".agents/skills/old");
    mkdirSync(join(retired, "agents"), { recursive: true });
    writeFileSync(
      join(retired, "SKILL.md"),
      `${GENERATED_MARKER}\n<!-- forge companions: agents/openai.yaml -->\n`,
    );
    writeFileSync(join(retired, "agents/openai.yaml"), "old");
    expect(await call("skills.sync", { check: true })).toMatchObject({
      ok: false,
    });
    await call("skills.sync");
    expect(existsSync(retired)).toBe(false);
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
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      written: [],
      skipped: [RENDERED],
      removed: [],
    });
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(mine);
  });
}, 30_000);
