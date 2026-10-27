import { expect, spyOn, test } from "bun:test";
import * as fsAdapter from "../../../src/adapters/fs/index.ts";
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
import {
  createAssembly,
  localCall,
  type Assembly,
} from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";
import { syncSkills } from "../../../src/assembly/skills.ts";
import { runCli } from "../../../src/surface/cli.ts";
import { validateResultEnvelope } from "../../../src/generated/validators.ts";

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
  run: (root: string, call: Call, assembly: Assembly) => Promise<void>,
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
    await run(root, call, assembly);
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
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(root, RENDERED), `${GENERATED_MARKER}\nold main body\n`);
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
    expect(await call("skills.sync")).toMatchObject({
      skipped: [RENDERED],
      written: [],
    });
    const checked = await call("skills.sync", { check: true });
    expect(checked).toMatchObject({ ok: true, skipped: [RENDERED] });
    expect(JSON.stringify(checked.warnings)).toContain(
      `left alone because Forge did not write them: ${RENDERED}; delete them to let sync write Forge's copies`,
    );
    expect(existsSync(join(root, ".agents/skills/review/agents"))).toBe(false);
  });
}, 30_000);

test("check reports both generated drift and a left-alone template skill", async () => {
  await withTemplate(async (root, call, assembly) => {
    const other = "tpl/skills/other/SKILL.md";
    mkdirSync(dirname(join(root, other)));
    writeFileSync(
      join(root, other),
      REVIEW.replace("name: review", "name: other"),
    );
    await call("skills.sync");
    const edited = `${readFileSync(join(root, RENDERED), "utf8")}\nedit`;
    writeFileSync(join(root, RENDERED), edited);
    const skipped = ".agents/skills/other/SKILL.md";
    writeFileSync(join(root, skipped), "user skill");
    const checked = await runCli(
      assembly.catalog,
      ["skills", "sync", "--check"],
      localCall(assembly),
    );
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain(RENDERED);
    expect(checked.stdout).toContain("run forge skills sync");
    expect(checked.envelope).toMatchObject({
      result: { skipped: [skipped] },
      warnings: [
        {
          code: "SKILLS_SKIPPED",
          message: `left alone because Forge did not write them: ${skipped}; delete them to let sync write Forge's copies`,
        },
      ],
    });
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(edited);
    expect(readFileSync(join(root, skipped), "utf8")).toBe("user skill");
  });
}, 30_000);

test.each(["EACCES", "EBUSY"])(
  "check reports %s reading a skill while sync still repairs other skills",
  async (code) => {
    await withTemplate(async (root, call, assembly) => {
      const companion = "tpl/skills/review/data.txt";
      writeFileSync(join(root, companion), "generated companion");
      await call("skills.sync");
      const original = readFileSync(join(root, RENDERED));
      rmSync(join(root, companion));
      const other = "tpl/skills/other/SKILL.md";
      mkdirSync(dirname(join(root, other)));
      writeFileSync(
        join(root, other),
        REVIEW.replace("name: review", "name: other"),
      );
      const mine = join(root, ".agents/skills/mine/SKILL.md");
      mkdirSync(dirname(mine));
      const oversized = "x".repeat(2 * 1024 * 1024);
      writeFileSync(mine, oversized);
      const real = fsAdapter.nodeConfigFiles;
      const spy = spyOn(fsAdapter, "nodeConfigFiles").mockImplementation(
        (folder) => {
          const files = real(folder);
          return {
            ...files,
            read(path, maxBytes) {
              if (join(folder, path) === join(root, RENDERED))
                throw Object.assign(new Error(`injected ${code}`), { code });
              return files.read(path, maxBytes);
            },
          };
        },
      );
      try {
        expect(await call("skills.sync")).toMatchObject({
          ok: true,
          written: [".agents/skills/other/SKILL.md"],
          skipped: [],
          warnings: [
            {
              code: "SKILLS_READ_FAILED",
              message: `Cannot read skills: ${RENDERED}; see result.readErrors for details`,
            },
          ],
        });
        const checked = await runCli(
          assembly.catalog,
          ["skills", "sync", "--check"],
          localCall(assembly),
        );
        expect(checked.exitCode).toBe(1);
        expect(checked.envelope).toMatchObject({
          result: { skipped: [] },
          warnings: [
            {
              code: "SKILLS_READ_FAILED",
              message: `Cannot read skills: ${RENDERED}; see result.readErrors for details`,
            },
          ],
        });
        expect(checked.stdout).toContain(code);
        expect(checked.stdout).not.toContain("left alone");
        expect(checked.stdout).not.toContain("mine/SKILL.md");
        expect(readFileSync(join(root, RENDERED))).toEqual(original);
        expect(
          readFileSync(join(root, ".agents/skills/review/data.txt"), "utf8"),
        ).toBe("generated companion");
        expect(
          readFileSync(join(root, ".agents/skills/other/SKILL.md"), "utf8"),
        ).toContain(GENERATED_MARKER);
        expect(readFileSync(mine, "utf8")).toBe(oversized);
      } finally {
        spy.mockRestore();
      }
      expect(await call("skills.sync")).toMatchObject({
        ok: true,
        removed: [".agents/skills/review/data.txt"],
      });
      expect(await call("skills.sync", { check: true })).toMatchObject({
        ok: true,
        skipped: [],
        warnings: [],
      });
    });
  },
  30_000,
);

test.each([
  "inside link",
  "outside link",
  "template link",
  "large file",
  "large skill",
])(
  "R1 leaves unrelated user entry %s alone",
  async (kind) => {
    await withTemplate(async (root, call) => {
      await call("skills.sync");
      const outside = mkdtempSync(join(tmpdir(), "forge-user-skill-"));
      const name = kind === "template link" ? "review" : "mine";
      const folder = join(root, ".agents/skills", name);
      try {
        if (kind.endsWith("link")) {
          const target =
            kind === "outside link" ? outside : join(root, "shared");
          mkdirSync(target, { recursive: true });
          writeFileSync(
            join(target, "SKILL.md"),
            `${GENERATED_MARKER}\nuser target\n`,
          );
          if (name === "review") rmSync(folder, { recursive: true });
          symlinkSync(
            target,
            folder,
            process.platform === "win32" ? "junction" : "dir",
          );
        } else if (kind === "large file")
          writeFileSync(folder, "x".repeat(2 * 1024 * 1024));
        else {
          mkdirSync(folder);
          writeFileSync(join(folder, "SKILL.md"), "x".repeat(2 * 1024 * 1024));
        }
        for (const check of [false, true]) {
          const result = await call("skills.sync", { check });
          expect(result).toMatchObject({
            ok: true,
            skipped: name === "review" ? [".agents/skills/review"] : [],
          });
        }
        if (kind.endsWith("link"))
          expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(
            `${GENERATED_MARKER}\nuser target\n`,
          );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  },
  30_000,
);

test.each(["directory", "parent file", "file"])(
  "R1 companion collision %s is skipped without a check repair loop",
  async (kind) => {
    await withTemplate(async (root, call) => {
      const source = join(root, "tpl/skills/review/agents/openai.yaml");
      mkdirSync(dirname(source));
      writeFileSync(source, "generated");
      const folder = join(root, ".agents/skills/review");
      mkdirSync(folder, { recursive: true });
      const target = join(folder, "agents/openai.yaml");
      if (kind === "parent file")
        writeFileSync(join(folder, "agents"), "user parent");
      else {
        mkdirSync(dirname(target));
        if (kind === "directory") mkdirSync(target);
        else writeFileSync(target, "user file");
      }
      expect(await call("skills.sync")).toMatchObject({
        ok: true,
        skipped: [".agents/skills/review/agents/openai.yaml"],
      });
      expect(readFileSync(join(root, RENDERED), "utf8")).not.toContain(
        "forge companions:",
      );
      const result = await call("skills.sync", { check: true });
      expect(result).toMatchObject({
        ok: true,
        skipped: [".agents/skills/review/agents/openai.yaml"],
      });
      expect(JSON.stringify(result.warnings)).toContain(
        "left alone because Forge did not write them:",
      );
      expect(JSON.stringify(result.warnings)).not.toContain(
        "run forge skills sync",
      );
    });
  },
  30_000,
);

test("R1 refuses an alias junction inside a marked skill and names its SKILL.md", async () => {
  await withTemplate(async (root, call) => {
    const folder = join(root, ".agents/skills/review");
    await call("skills.sync");
    mkdirSync(join(folder, "agents"));
    writeFileSync(join(folder, "agents/openai.yaml"), "mine");
    symlinkSync(
      join(folder, "agents"),
      join(folder, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const edited = readFileSync(join(root, RENDERED), "utf8").replace(
      GENERATED_MARKER,
      `${GENERATED_MARKER}\n<!-- forge companions: alias/openai.yaml -->`,
    );
    writeFileSync(join(root, RENDERED), edited);
    const result = await call("skills.sync");
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain(RENDERED);
    expect(readFileSync(join(root, RENDERED), "utf8")).toBe(edited);
  });
}, 30_000);

test.each([false, true])(
  "R1 writes ownership last during file-to-directory companion transition (fail=%s)",
  async (fail) => {
    await withTemplate(async (root, call) => {
      const source = join(root, "tpl/skills/review/data");
      writeFileSync(source, "old");
      await call("skills.sync");
      const original = readFileSync(join(root, RENDERED));
      rmSync(source);
      mkdirSync(source);
      writeFileSync(join(source, "info.txt"), "new");
      const real = fsAdapter.nodeConfigFiles;
      const spy = spyOn(fsAdapter, "nodeConfigFiles").mockImplementation(
        (root) => {
          const files = real(root);
          return {
            ...files,
            write(path, bytes) {
              if (fail && path.endsWith("data/info.txt"))
                throw new Error("injected companion failure");
              files.write(path, bytes);
            },
          };
        },
      );
      try {
        const result = await call("skills.sync");
        expect(result).toMatchObject({ ok: !fail });
        if (fail) expect(readFileSync(join(root, RENDERED))).toEqual(original);
        else {
          expect(
            readFileSync(
              join(root, ".agents/skills/review/data/info.txt"),
              "utf8",
            ),
          ).toBe("new");
          expect(readFileSync(join(root, RENDERED), "utf8")).toContain(
            "forge companions: data/info.txt",
          );
        }
      } finally {
        spy.mockRestore();
      }
    });
  },
  30_000,
);

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

test("R1 a former companion replaced by a user directory never grants ownership of its children", async () => {
  await withTemplate(async (root, call) => {
    const source = join(root, "tpl/skills/review/data");
    writeFileSync(source, "generated old file");
    await call("skills.sync");
    rmSync(source);
    mkdirSync(source);
    writeFileSync(join(source, "info.txt"), "generated new file");
    const target = join(root, ".agents/skills/review/data");
    rmSync(target);
    mkdirSync(target);
    writeFileSync(join(target, "info.txt"), "user file");
    expect(await call("skills.sync")).toMatchObject({
      ok: true,
      skipped: [".agents/skills/review/data/info.txt"],
    });
    expect(readFileSync(join(target, "info.txt"), "utf8")).toBe("user file");
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

test.each([
  "metadata",
  "companion metadata",
  "second read",
  "companion read",
  "second companion read",
  "write",
  "remove",
])(
  "access failures isolate one skill's %s and discard its remaining actions",
  async (operation) => {
    await withTemplate(async (root, call, assembly) => {
      const source = join(root, "tpl/skills/review");
      const folder = join(root, ".agents/skills/review");
      writeFileSync(join(source, "a.txt"), "retired");
      writeFileSync(join(source, "z.txt"), "old");
      await call("skills.sync");
      const original = readFileSync(join(root, RENDERED));
      rmSync(join(source, "a.txt"));
      writeFileSync(join(source, "z.txt"), "new");
      mkdirSync(join(root, "tpl/skills/other"));
      writeFileSync(
        join(root, "tpl/skills/other/SKILL.md"),
        REVIEW.replace("name: review", "name: other"),
      );
      const real = fsAdapter.nodeConfigFiles;
      const realKind = fsAdapter.entryKind;
      let reads = 0;
      let companionReads = 0;
      const fail = (): never => {
        throw Object.assign(new Error(`injected ${operation}`), {
          code: "EPERM",
        });
      };
      const kindSpy = spyOn(fsAdapter, "entryKind").mockImplementation(
        (base, path) => {
          if (
            operation === "metadata" &&
            join(base, path) === join(root, RENDERED)
          )
            fail();
          if (
            operation === "companion metadata" &&
            join(base, path) === join(folder, "z.txt")
          )
            fail();
          return realKind(base, path);
        },
      );
      const spy = spyOn(fsAdapter, "nodeConfigFiles").mockImplementation(
        (base) => {
          const files = real(base);
          return {
            ...files,
            read(path, maxBytes) {
              if (
                join(base, path) === join(root, RENDERED) &&
                ++reads === 2 &&
                operation === "second read"
              )
                fail();
              if (
                join(base, path) === join(folder, "z.txt") &&
                ++companionReads ===
                  (operation === "second companion read" ? 2 : 1) &&
                ["companion read", "second companion read"].includes(operation)
              )
                fail();
              return files.read(path, maxBytes);
            },
            write(path, bytes) {
              if (
                join(base, path) === join(folder, "z.txt") &&
                operation === "write"
              )
                fail();
              files.write(path, bytes);
            },
            remove(path) {
              if (
                join(base, path) === join(folder, "a.txt") &&
                operation === "remove"
              )
                fail();
              files.remove(path);
            },
          };
        },
      );
      try {
        const checked = await runCli(
          assembly.catalog,
          ["skills", "sync", "--check"],
          localCall(assembly),
        );
        expect(checked.exitCode).toBe(1);
        reads = 0;
        companionReads = 0;
        const synced = await runCli(
          assembly.catalog,
          ["skills", "sync"],
          localCall(assembly),
        );
        expect(synced.exitCode).toBe(0);
        expect(synced.envelope.warnings.map((warning) => warning.code)).toEqual(
          ["SKILLS_READ_FAILED"],
        );
        expect(JSON.stringify(synced.envelope)).toContain(RENDERED);
        expect(readFileSync(join(root, RENDERED))).toEqual(original);
        expect(readFileSync(join(folder, "z.txt"), "utf8")).toBe("old");
        if (operation !== "write")
          expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("retired");
        expect(existsSync(join(root, ".agents/skills/other/SKILL.md"))).toBe(
          true,
        );
        if (!["write", "remove"].includes(operation)) {
          expect(
            checked.envelope.warnings.map((warning) => warning.code),
          ).toEqual(["SKILLS_READ_FAILED"]);
          expect(
            JSON.stringify(record(checked.envelope.result)?.unchanged),
          ).not.toContain("review/");
        }
      } finally {
        spy.mockRestore();
        kindSpy.mockRestore();
      }
    });
  },
  30_000,
);

test.each(["marked", "unmarked", "marker beyond limit"])(
  "oversized %s skills retain ownership reporting without writes",
  async (kind) => {
    await withTemplate(async (root, call, assembly) => {
      await call("skills.sync");
      const text =
        kind === "marked"
          ? `${GENERATED_MARKER}\r\n${"x".repeat(2 * 1024 * 1024)}`
          : kind === "marker beyond limit"
            ? `${"x".repeat(2 * 1024 * 1024)}\n${GENERATED_MARKER}`
            : "x".repeat(2 * 1024 * 1024);
      writeFileSync(join(root, RENDERED), text);
      for (const check of [false, true]) {
        const response = await runCli(
          assembly.catalog,
          ["skills", "sync", ...(check ? ["--check"] : [])],
          localCall(assembly),
        );
        expect(response.exitCode).toBe(check && kind !== "unmarked" ? 1 : 0);
        expect(
          response.envelope.warnings.map((warning) => warning.code),
        ).toEqual(kind === "unmarked" ? [] : ["SKILLS_READ_FAILED"]);
        expect(response.stdout.includes(RENDERED)).toBe(kind !== "unmarked");
        expect(readFileSync(join(root, RENDERED), "utf8")).toBe(text);
      }
    });
  },
  30_000,
);

test("many read failures share one bounded warning and keep full diagnostics", async () => {
  await withTemplate(async (root, call, assembly) => {
    for (let i = 0; i < 100; i++) {
      const folder = join(
        root,
        `.agents/skills/locked-${String(i).padStart(3, "0")}`,
      );
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), GENERATED_MARKER);
    }
    const real = fsAdapter.nodeConfigFiles;
    const spy = spyOn(fsAdapter, "nodeConfigFiles").mockImplementation(
      (base) => {
        const files = real(base);
        return {
          ...files,
          read(path, maxBytes) {
            if (base.includes("locked-") && path === "SKILL.md")
              throw Object.assign(new Error("EBUSY ".repeat(1000)), {
                code: "EBUSY",
              });
            return files.read(path, maxBytes);
          },
        };
      },
    );
    try {
      for (const check of [false, true]) {
        const response = await runCli(
          assembly.catalog,
          ["skills", "sync", ...(check ? ["--check"] : [])],
          localCall(assembly),
        );
        expect(response.exitCode).toBe(check ? 1 : 0);
        expect(validateResultEnvelope(response.envelope).ok).toBe(true);
        expect(
          response.envelope.warnings.map((warning) => warning.code),
        ).toEqual(["SKILLS_READ_FAILED"]);
        expect(record(response.envelope.result)?.readErrors).toHaveLength(100);
        expect(
          JSON.stringify(record(response.envelope.result)?.readErrors),
        ).toContain("locked-099/SKILL.md");
      }
      expect(existsSync(join(root, RENDERED))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
}, 30_000);

test("skills check help and input description include read failures", async () => {
  await withTemplate(async (_root, _call, assembly) => {
    const help = await runCli(
      assembly.catalog,
      ["skills", "sync", "--help"],
      localCall(assembly),
    );
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("read failures");
    expect(help.stdout).toContain("Oversized unmarked");
    const described = await runCli(
      assembly.catalog,
      ["skills", "sync", "--help", "--json"],
      localCall(assembly),
    );
    const entries = record(described.envelope.result)?.operations;
    const input = record(
      Array.isArray(entries) ? entries[0] : undefined,
    )?.inputSchema;
    expect(JSON.stringify(input)).toContain("read failures");
    expect(JSON.stringify(input)).toContain("Oversized unmarked");
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
