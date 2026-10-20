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
import type { McpCandidate } from "../../src/contract/mcp.ts";
import { nounRefusal, propertyFromFlag } from "../../src/contract/naming.ts";
import { createAssembly, type Assembly } from "../../src/assembly/index.ts";
import { syncSkills } from "../../src/assembly/skills.ts";
import { mapArguments } from "../../src/surface/cli.ts";
import { record } from "../../src/surface/dispatch.ts";
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

/** A skill's CLI usage line; built with RegExp so its backticks do not read as a template literal. */
const CLI_LINE = new RegExp("^- CLI: `([^`]+)`$", "gm");

/** A value the CLI parser accepts for a property of this schema. */
function sample(schema: unknown): string {
  const s = record(schema);
  if (Array.isArray(s?.enum)) return String(s.enum[0]);
  switch (s?.type) {
    case "integer":
    case "number":
      return "1";
    case "boolean":
      return "true";
    case "array":
      return "[]";
    case "object":
      return "{}";
    default:
      return "x";
  }
}

/**
 * Run a skill's `- CLI:` line through the real CLI argument parser, with every optional part
 * included and each placeholder filled with a value of the property's type.
 */
function parseCliLine(
  line: string,
  catalog: readonly McpCandidate[],
): Record<string, unknown> {
  const [noun, verb, ...rest] = line.split(" ").slice(1);
  const entry = catalog.find((c) => c.op === `${noun}.${verb}`);
  if (entry === undefined) throw new Error(`no operation for ${line}`);
  const properties = record(entry.inputSchema.properties) ?? {};
  const positions = entry.declaration.args ?? [];
  const tokens = rest
    .join(" ")
    .replace(/[[\]]/g, "")
    .split(" ")
    .filter(Boolean);
  let position = 0;
  let flag: string | undefined;
  const filled = tokens.map((token) => {
    if (token.startsWith("--")) {
      flag = propertyFromFlag(token.slice(2));
      return token;
    }
    const key = flag ?? positions[position++] ?? "";
    flag = undefined;
    return token.startsWith("<") ? sample(properties[key]) : token;
  });
  const input = mapArguments(filled, entry) as Record<string, unknown>;
  const required = entry.inputSchema.required;
  for (const key of Array.isArray(required) ? required : [])
    expect(Object.keys(input)).toContain(String(key));
  return input;
}

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
      // Every CLI line an agent copies must parse with the real CLI parser.
      for (const [, line = ""] of text.matchAll(CLI_LINE))
        expect(() => parseCliLine(line, catalog)).not.toThrow();
    }
    const decision = readFileSync(
      join(root, ".agents/skills/decision/SKILL.md"),
      "utf8",
    );
    expect(decision).toContain(
      "- CLI: `forge decision propose <title> <text> [--consequences <text>]`",
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

test("CLI lines give value flags a placeholder, keep booleans bare and mark what is optional", () => {
  const base = candidate("sample.echo");
  const entry: McpCandidate = {
    ...base,
    inputSchema: {
      ...base.inputSchema,
      properties: {
        ...record(base.inputSchema.properties),
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["fast", "slow"] },
      },
      required: ["value", "mode"],
    },
  };
  const text = renderSkills([entry])[0]?.text ?? "";
  const line =
    "forge sample echo <value> --mode <text> [--count <number>] [--pre-release] [--tags <json>]";
  expect(text).toContain(`- CLI: \`${line}\``);
  expect(parseCliLine(line, [entry])).toEqual({
    value: "x",
    mode: "fast",
    count: 1,
    preRelease: true,
    tags: [],
  });
  // The old shape: a value flag with no value is refused by the parser.
  expect(() => mapArguments(["x", "--count"], entry)).toThrow(
    "Missing value for --count.",
  );
}, 30_000);

test("a block cannot declare the skills noun the CLI reserves for skills sync", () => {
  expect(
    nounRefusal("skills", "io.github.alice", { firstPartyNouns: [] })?.code,
  ).toBe("NAME_RESERVED");
}, 30_000);

test("a deprecation's replacement follows the instance's noun rename", () => {
  const old: McpCandidate = {
    ...candidate("demo.old", {
      stability: "deprecated",
      deprecated: { since: "0.2.0", use: "sample.new" },
    }),
    rename: { sample: "demo" },
  };
  const catalog = [old, candidate("demo.new")];
  const text = renderSkills(catalog)[0]?.text ?? "";
  expect(text).toContain("Deprecated: use `demo.new`.");
  expect(lintSkill(text, catalog)).toEqual([]);
}, 30_000);
