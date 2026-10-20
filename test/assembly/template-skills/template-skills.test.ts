import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";

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
