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

const RENDERED = ".agents/skills/review/SKILL.md";

/** A project with no blocks and a template file at tpl/ carrying values and one skill. */
async function withTemplate(
  run: (
    root: string,
    call: (op: string, input?: object) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
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
        skills: ["review"],
      },
    }),
  );
  put("tpl/skills/review/SKILL.md", REVIEW);
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const call = async (
    op: string,
    input: object = {},
  ): Promise<Record<string, unknown>> => {
    const result = await dispatch(
      assembly.catalog,
      op,
      input,
      localCall(assembly),
    );
    return { ...result, ...(record(result.ok ? result.result : {}) ?? {}) };
  };
  const revision = async () => String((await call("config.show")).revision);
  try {
    expect(
      await call("template.import", {
        template: "tpl/forge.template.json",
        expectRevision: await revision(),
      }),
    ).toMatchObject({ ok: true });
    await run(root, async (op, input = {}) =>
      call(
        op,
        "expectRevision" in input
          ? { ...input, expectRevision: await revision() }
          : input,
      ),
    );
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("skills sync renders a template skill from the project's values, and re-renders when one changes", async () => {
  await withTemplate(async (root, call) => {
    expect(
      readFileSync(join(root, ".forge/skills/review/SKILL.md"), "utf8"),
    ).toBe(REVIEW);
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      written: [RENDERED],
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
  });
}, 30_000);

test("an unknown placeholder fails skills sync and names the placeholder", async () => {
  await withTemplate(async (root, call) => {
    writeFileSync(
      join(root, ".forge/skills/review/SKILL.md"),
      `${REVIEW}Merge by {{values.merge.by}}.\n`,
    );
    const failed = await call("skills.sync");
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).toContain("{{values.merge.by}}");
    expect(existsSync(join(root, RENDERED))).toBe(false);
  });
}, 30_000);

test("removing the template removes its generated skill files and leaves hand-written ones", async () => {
  await withTemplate(async (root, call) => {
    await call("skills.sync");
    const mine = join(root, ".agents/skills/mine/SKILL.md");
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "---\nname: mine\ndescription: mine\n---\n");
    expect(
      await call("template.remove", {
        template: "acme/delivery",
        expectRevision: "",
      }),
    ).toMatchObject({ ok: true });
    expect(existsSync(join(root, RENDERED))).toBe(false);
    expect(existsSync(join(root, ".forge/skills/review/SKILL.md"))).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(await call("skills.sync")).toMatchObject({ ok: true, written: [] });
  });
}, 30_000);
