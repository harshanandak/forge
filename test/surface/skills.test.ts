import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, type Assembly } from "../../src/assembly/index.ts";
import { syncSkills } from "../../src/assembly/skills.ts";
import { lintSkill, renderSkills } from "../../src/surface/skills.ts";
import { candidate } from "./fixtures/catalog.ts";

const repo = resolve(import.meta.dirname, "../..");
const blocks = ["work", "memory", "check"] as const;
const checkConfig = {
  commands: { test: { argv: ["declared", "test"] } },
  timeoutMs: 1000,
  maxOutputBytes: 262144,
  outputHeadBytes: 4096,
  outputTailBytes: 4096,
  maxMetadataBytes: 32768,
  maxReceiptBytes: 524288,
  report: "auto",
  stopOnFailure: false,
  inputs: [],
  maxInputBytes: 1024,
  environment: [],
};

/** The shipped blocks as a project enables them. Listing never runs block code, so entries are stubs. */
async function withProject(
  run: (assembly: Assembly, root: string) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-skills-"));
  try {
    const config: Record<string, unknown> = {};
    for (const name of blocks) {
      const target = join(root, "blocks", name);
      cpSync(join(repo, "src/blocks", name), target, { recursive: true });
      const manifest = JSON.parse(
        readFileSync(join(target, "forge.block.json"), "utf8"),
      ) as { entry: string };
      writeFileSync(join(target, manifest.entry), "module.exports={};");
      config[name] = {
        source: { path: `./blocks/${name}` },
        ...(name === "check" ? { config: checkConfig } : {}),
      };
    }
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge", "config.yaml"),
      JSON.stringify({ schemaVersion: "forge.config/1", blocks: config }),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      expect(assembly.catalog.unavailable()).toEqual([]);
      await run(assembly, root);
    } finally {
      await assembly.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("forge skills sync writes one linted skill per enabled block noun", async () => {
  await withProject((assembly, root) => {
    const first = syncSkills(assembly, ["sync"]);
    expect(first).toMatchObject({
      ok: true,
      result: {
        dir: ".agents/skills",
        written: [
          ".agents/skills/check/SKILL.md",
          ".agents/skills/decision/SKILL.md",
          ".agents/skills/issue/SKILL.md",
          ".agents/skills/memory/SKILL.md",
        ],
        unchanged: [],
      },
    });
    const catalog = assembly.catalog.list();
    for (const noun of ["check", "decision", "issue", "memory"]) {
      const text = readFileSync(
        join(root, ".agents/skills", noun, "SKILL.md"),
        "utf8",
      );
      expect(text.startsWith(`---\nname: ${noun}\ndescription: "`)).toBe(true);
      expect(lintSkill(text, catalog)).toEqual([]);
    }
    const decision = readFileSync(
      join(root, ".agents/skills/decision/SKILL.md"),
      "utf8",
    );
    expect(decision).toContain(
      "- CLI: `forge decision propose <title> <text> [--consequences]`",
    );
    expect(decision).toContain("- MCP: `decision_propose`");
    expect(decision).toContain("- Effects: `decision:write`; not idempotent");
    expect(decision).toContain("- `decision.adopt`: Mark a proposed decision");
    expect(decision).not.toContain("## `decision.adopt`");
    expect(decision.split("\n")[2]).toContain("Record a decision under");
    // Deterministic: a second sync rewrites nothing.
    const again = syncSkills(assembly, ["sync"]);
    expect(again.ok ? again.result : undefined).toEqual({
      dir: ".agents/skills",
      written: [],
      unchanged: first.ok
        ? (first.result as { written: string[] }).written
        : [],
    });
    expect(
      syncSkills(assembly, ["sync", "--dir", "custom/skills/"]),
    ).toMatchObject({
      ok: true,
      result: { dir: "custom/skills" },
    });
    expect(existsSync(join(root, "custom/skills/issue/SKILL.md"))).toBe(true);
    expect(syncSkills(assembly, ["sync", "--dir", "../outside"])).toMatchObject(
      {
        ok: false,
      },
    );
    expect(syncSkills(assembly, ["publish"])).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
  });
}, 30_000);

test("the skill lint rejects unknown operations and oversized skills", () => {
  const catalog = [candidate("sample.echo"), candidate("sample.list")];
  const [skill] = renderSkills(catalog);
  expect(skill?.path).toBe("sample/SKILL.md");
  const text = skill?.text ?? "";
  expect(lintSkill(text, catalog)).toEqual([]);
  expect(renderSkills([...catalog].reverse())).toEqual(renderSkills(catalog));
  for (const planted of [
    "Then call `sample.frobnicate`.",
    "Then call `sample_frobnicate`.",
    "Then run `forge widget make --now`.",
  ])
    expect(lintSkill(`${text}\n${planted}\n`, catalog)).toEqual([
      expect.stringContaining("unknown operation"),
    ]);
  // Not operation names: file names and unknown nouns in dotted form.
  expect(lintSkill(`${text}\nSee \`config.yaml\`.\n`, catalog)).toEqual([]);
  expect(lintSkill(`${text}\n${"x".repeat(8192)}\n`, catalog)).toEqual([
    expect.stringMatching(/bytes; the limit is 8192$/),
  ]);
  expect(lintSkill("# no frontmatter\n", catalog)).toEqual([
    "frontmatter has no name",
    "frontmatter has no description",
  ]);
}, 30_000);

test("core nouns and human-only nouns get no skill; the MCP prefix is applied", () => {
  const skills = renderSkills(
    [
      candidate("config.show"),
      candidate("vault.seal", { callers: ["human"] }),
      candidate("sample.echo"),
    ],
    "forge",
  );
  expect(skills.map((s) => s.noun)).toEqual(["sample"]);
  expect(skills[0]?.text).toContain("- MCP: `forge_sample_echo`");
  expect(
    lintSkill(skills[0]?.text ?? "", [candidate("sample.echo")], "forge"),
  ).toEqual([]);
}, 30_000);
