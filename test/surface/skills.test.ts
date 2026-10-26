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
import { PassThrough } from "node:stream";
import { isAgentCallable, type McpCandidate } from "../../src/contract/mcp.ts";
import { CORE_NOUNS, nounRefusal } from "../../src/contract/naming.ts";
import {
  createAssembly,
  localCall,
  type Assembly,
} from "../../src/assembly/index.ts";
import type { InvocationRequest } from "../../src/generated/types.ts";
import { runCli } from "../../src/surface/cli.ts";
import { runCommand } from "../../src/surface/command.ts";
import { dispatch, record, success } from "../../src/surface/dispatch.ts";
import {
  GENERATED_MARKER,
  lintSkill,
  renderSkills,
} from "../../src/surface/skills.ts";
import { candidate } from "./fixtures/catalog.ts";

const repo = resolve(import.meta.dirname, "../..");
/** A skill's CLI line; built with RegExp so its backticks do not read as a template literal. */
const CLI_LINE = new RegExp("^- CLI: `([^`]+)`$", "gm");

/** Run `forge <argv>` through the generated CLI against the assembly; returns the parsed envelope. */
async function forge(assembly: Assembly, argv: readonly string[]) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => (text += chunk.toString()));
  await runCommand(argv, {
    catalog: assembly.catalog,
    version: "0.0.0",
    call: localCall(assembly),
    output,
  });
  output.end();
  return JSON.parse(text) as { ok: boolean; result?: unknown };
}

/**
 * The shipped work and memory blocks as a project enables them; entries are stubs, listing never
 * runs them. A human admits the blocks named in `admit`; the rest stay enabled but unadmitted.
 */
async function withProject(
  run: (assembly: Assembly, root: string) => Promise<void>,
  admit: readonly string[] = ["work", "memory"],
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-skills-"));
  try {
    const blocks: Record<string, unknown> = {};
    for (const name of ["work", "memory"]) {
      const target = join(root, "blocks", name);
      cpSync(join(repo, "src/blocks", name), target, { recursive: true });
      const { entry } = JSON.parse(
        readFileSync(join(target, "forge.block.json"), "utf8"),
      ) as { entry: string };
      writeFileSync(join(target, entry), "module.exports={};");
      blocks[name] = { source: { path: `./blocks/${name}` } };
    }
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge", "config.yaml"),
      JSON.stringify({ schemaVersion: "forge.config/1", blocks }),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      const call = localCall(assembly);
      for (const name of admit) {
        const checked = await dispatch(
          assembly.catalog,
          "block.check",
          { path: `./blocks/${name}` },
          call,
        );
        const digest = String(
          record(checked.ok ? checked.result : undefined)?.digest,
        );
        expect(
          await dispatch(assembly.catalog, "block.admit", { digest }, call),
        ).toMatchObject({ ok: true });
      }
      await run(assembly, root);
    } finally {
      await assembly.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("skills.sync writes one linted skill per block noun, deterministically, from CLI and catalog.call", async () => {
  await withProject(async (assembly, root) => {
    const paths = ["decision", "issue", "memory"].map(
      (noun) => `.agents/skills/${noun}/SKILL.md`,
    );
    const first = { dir: ".agents/skills", written: paths, unchanged: [] };
    expect(await forge(assembly, ["skills", "sync"])).toMatchObject({
      result: { ...first, skipped: [] },
    });
    for (const path of paths) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).toContain(GENERATED_MARKER);
      expect(lintSkill(text, assembly.catalog.list())).toEqual([]);
    }
    const decision = readFileSync(join(root, paths[0] ?? ""), "utf8");
    expect(decision).toContain(
      "- CLI: `forge decision propose --input '<json>'`\n- MCP: `decision_propose`",
    );
    expect(decision).toContain("- Effects: `decision:write`; not idempotent");
    expect(decision).toContain("- `decision.adopt`: Mark a proposed decision");
    expect(await forge(assembly, ["skills", "sync"])).toMatchObject({
      result: { written: [], unchanged: paths },
    });
    expect(
      await forge(assembly, ["skills", "sync", "--dir", "../outside"]),
    ).toMatchObject({ ok: false });
    const call = localCall(assembly);
    expect(
      await dispatch(
        assembly.catalog,
        "catalog.call",
        { op: "skills.sync", input: { dir: "agent/skills/" } },
        {
          caller: "agent",
          context: { ...call.context, actor: { kind: "agent", id: "a" } },
        },
      ),
    ).toMatchObject({ ok: true, result: { dir: "agent/skills" } });
    expect(existsSync(join(root, "agent/skills/issue/SKILL.md"))).toBe(true);
  });
}, 30_000);

test("a fresh assembly loads persisted admission only when syncing skills", async () => {
  await withProject(async (_assembly, root) => {
    const reopened = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      expect(
        reopened.catalog.list().find((entry) => entry.op === "memory.add")
          ?.admitted,
      ).toBe(false);
      expect(await forge(reopened, ["skills", "sync"])).toMatchObject({
        ok: true,
        result: {
          written: [
            ".agents/skills/decision/SKILL.md",
            ".agents/skills/issue/SKILL.md",
            ".agents/skills/memory/SKILL.md",
          ],
        },
      });
      expect(
        reopened.catalog.list().find((entry) => entry.op === "memory.add")
          ?.admitted,
      ).toBe(true);
    } finally {
      await reopened.close();
    }
  });
}, 30_000);

test("the generated issue skill lists the resolved issue.create input fields within the size limit", async () => {
  await withProject(async (assembly, root) => {
    expect(await forge(assembly, ["skills", "sync"])).toMatchObject({
      ok: true,
    });
    const text = readFileSync(
      join(root, ".agents/skills/issue/SKILL.md"),
      "utf8",
    );
    const create = text.split("## `issue.create`")[1]?.split("\n## ")[0];
    for (const field of ["title", "kind", "parent", "labels", "body"])
      expect(create).toContain(`\`${field}\``);
    expect(create).toContain("`title` string (required)");
    expect(create).toContain("`kind` string (optional)");
    expect(create).toContain("`parent` string (optional)");
    expect(create).toContain("`labels` string[] (optional)");
    expect(create).toContain("`body` string (optional)");
    expect(lintSkill(text, assembly.catalog.list())).toEqual([]);
  });
}, 30_000);

test("an enabled but unadmitted block gets no skill and none of its text reaches any file", async () => {
  await withProject(
    async (assembly, root) => {
      const catalog = assembly.catalog.list();
      const hidden = catalog.filter((c) => !c.admitted);
      expect(hidden.map((c) => c.op)).toContain("memory.add");
      const sync = await forge(assembly, ["skills", "sync"]);
      expect(sync).toMatchObject({
        ok: true,
        result: {
          written: [".agents/skills/issue/SKILL.md"],
        },
      });
      const text = readFileSync(
        join(root, ".agents/skills/issue/SKILL.md"),
        "utf8",
      );
      for (const noun of ["decision", "memory"])
        expect(existsSync(join(root, `.agents/skills/${noun}`))).toBe(false);
      for (const c of hidden) {
        expect(text).not.toContain(c.op);
        expect(text).not.toContain(c.docs.summary);
      }
    },
    ["work"],
  );
}, 30_000);

test("every generated CLI line for the shipped blocks delivers its --input JSON through the real CLI parser", async () => {
  await withProject(async (assembly) => {
    const catalog = assembly.catalog.list();
    const input = { probe: [1, "two words"], nested: { ok: true } };
    const ops: string[] = [];
    for (const skill of renderSkills(catalog))
      for (const [, line = ""] of skill.text.matchAll(CLI_LINE)) {
        let seen: InvocationRequest | undefined;
        const argv = line
          .split(" ")
          .slice(1)
          .map((t) => (t === "'<json>'" ? JSON.stringify(input) : t));
        await runCli(
          {
            list: () => catalog,
            invoke: (request) => {
              seen = request;
              return Promise.resolve(success(request.op, null));
            },
          },
          argv,
        );
        expect(seen?.input).toEqual(input);
        ops.push(seen?.op ?? line);
      }
    // One line per agent-callable block operation, and nothing else.
    const expected = catalog
      .filter((c) => isAgentCallable(c.declaration))
      .map((c) => c.op)
      .filter((op) => !CORE_NOUNS.includes(op.split(".")[0] ?? ""));
    expect(ops.sort()).toEqual(expected.sort());
    expect(ops.length).toBeGreaterThan(10);
  });
}, 30_000);

test("sync replaces its own files whatever their size and never touches hand-written ones", async () => {
  await withProject(async (assembly, root) => {
    const dir = join(root, ".agents/skills");
    mkdirSync(join(dir, "issue"), { recursive: true });
    mkdirSync(join(dir, "memory"), { recursive: true });
    // A stale generated file past the 16 KiB read cap the first version used.
    const stale = `${GENERATED_MARKER}\n${"OLD LINE\n".repeat(3000)}`;
    writeFileSync(join(dir, "issue/SKILL.md"), stale);
    const mine = "---\nname: memory\ndescription: mine\n---\n# mine\n";
    writeFileSync(join(dir, "memory/SKILL.md"), mine);
    expect(await forge(assembly, ["skills", "sync"])).toMatchObject({
      ok: true,
      result: { skipped: [".agents/skills/memory/SKILL.md"] },
    });
    const issue = readFileSync(join(dir, "issue/SKILL.md"), "utf8");
    expect(issue).not.toContain("OLD LINE");
    expect(lintSkill(issue, assembly.catalog.list())).toEqual([]);
    expect(readFileSync(join(dir, "memory/SKILL.md"), "utf8")).toBe(mine);
  });
}, 30_000);

test("the lint rejects unknown operations and oversized skills; core and human-only nouns get no skill", () => {
  const catalog = [
    candidate("sample.echo"),
    candidate("sample.list"),
    candidate("config.show"),
    candidate("vault.seal", { callers: ["human"] }),
  ];
  const skills = renderSkills(catalog, "forge");
  expect(skills.map((s) => s.path)).toEqual(["sample/SKILL.md"]);
  expect(renderSkills([...catalog].reverse(), "forge")).toEqual(skills);
  const text = skills[0]?.text ?? "";
  expect(text).toContain("- MCP: `forge_sample_echo`");
  expect(lintSkill(text, catalog, "forge")).toEqual([]);
  for (const planted of [
    "`sample.frobnicate`",
    "`forge_sample_frobnicate`",
    "`forge widget make --now`",
  ])
    expect(lintSkill(`${text}\n${planted}\n`, catalog, "forge")).toEqual([
      expect.stringContaining("unknown operation"),
    ]);
  expect(lintSkill(`${text}\nSee \`notes.yaml\`.\n`, catalog)).toEqual([]);
  expect(lintSkill(`${text}\n${"x".repeat(8192)}\n`, catalog)).toEqual([
    expect.stringMatching(/bytes; the limit is 8192$/),
  ]);
  expect(lintSkill("# no frontmatter\n", catalog)).toEqual([
    "frontmatter has no name",
    "frontmatter has no description",
  ]);
}, 30_000);

const routingCases: readonly [string, string][] = [
  ["gpt-5", "gpt-custom"],
  ["gpt-6.1-sol", "GPT 6.1 Sol"],
  ["claude-opus-4-6", "claude-code"],
  ["claude-sonnet-4", ".claude-plugin"],
  ["claude-haiku-4", "Claude Code"],
  ["claude-fable-1", "claude-helper"],
  ["claude-3-7", "claude-model"],
  ["gemini-3-pro", "Gemini 3 Pro"],
  ["deepseek-v4", "deepseeker"],
  ["o3", "o3-mini"],
  ["Opus", "opuses"],
  ["Sonnet", "sonnets"],
  ["Haiku", "haikus"],
  ["--model gpt-5", "--model ${MODEL}"],
  ["--model=gpt-5", '--model "$MODEL"'],
  ["-m gpt-5", "git commit -m message"],
  ["-m gpt-5", 'git commit -m "..."'],
  ["python -m gpt-5", "python -m pytest"],
  ["grep -m o3", "grep -m 1"],
  ["--model deepseek-v4", "--model custom"],
  ["--model gpt-5", "Mental model"],
  ["effort: minimal", "effort: minimalism"],
  ["effort: low", "effort: lower"],
  ["effort: medium", "effort: medium-sized"],
  ["effort: high", "Effort: one line"],
  ["effort: xhigh", "effort: xhigher"],
  ["effort: max", "effort: maximum"],
  ["effort=high", "effort=high-level"],
  ["reasoning: high", "reasoning: high-level"],
  ["reasoning=high", "reasoning=high-level"],
  ["reasoning_effort: high", "reasoning_effort: default"],
  ["reasoning_effort=high", "reasoning_effort=default"],
  ["model_reasoning_effort: high", "model_reasoning_effort: default"],
  ["model_reasoning_effort=high", "model_reasoning_effort=default"],
  ["-c effort=high", "-c effort=default"],
  ["-c reasoning=high", "-c reasoning=default"],
  ["-c reasoning_effort=high", "-c reasoning_effort=default"],
  ["-c model_reasoning_effort=high", "-c model_reasoning_effort=default"],
  ["--effort high", "--effort high-level"],
  ["--effort=high", "--effort=default"],
  ["reasoning high", "reasoning high-level"],
  ["reasoning minimal", "reasoning none"],
  ["effort: high", "reasoningEffort: high"],
  ['"effort": "high"', '"effort": "<effort>"'],
  ['{"reasoning": "high"}', '{"reasoning": "<effort>"}'],
  ['model_reasoning_effort="high"', 'model_reasoning_effort="{effort}"'],
  ["gpt-5", "<gpt-5>"],
  ["claude-opus-4-6", "{claude-opus-4-6}"],
  ["gpt-5", "{{gpt-5}}"],
  ["reasoning high", "<reasoning high>"],
  ["effort: high", "effort: {high}"],
  ["<!-- --model gpt-5 -->", "--model <model id>"],
  ["--effort high", "--effort <effort>"],
  ["-m o3", "-m {model}"],
  [
    "reasoning high",
    "Implemented: <display name> (<model id>, reasoning <effort>) via <harness>",
  ],
  ["gpt-5", "Codex and T3 Code select the model."],
];

test.each(routingCases)(
  "the lint rejects literal routing in %s",
  (body) => {
    const front = "---\nname: sample\ndescription: sample\n---\n\n";
    for (const content of [body, `\`${body}\``]) {
      const problems = lintSkill(`${front}${content}\n`, []);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toContain("literal model or effort");
      expect(problems[0]).toContain("line 6");
      expect(problems[0]).toMatch(/in `.+` on line 6$/);
    }
  },
  30_000,
);

test.each(routingCases)(
  "the lint allows the paired alternative to %s: %s",
  (_body, allowed) => {
    const front = "---\nname: sample\ndescription: sample\n---\n\n";
    for (const content of [allowed, `\`${allowed}\``])
      expect(lintSkill(`${front}${content}\n`, [])).toEqual([]);
  },
  30_000,
);

test("input fields are shown for display only; non-object and $ref/anyOf inputs never become syntax", () => {
  const base = candidate("sample.echo");
  const properties = {
    ...record(base.inputSchema.properties),
    tags: { $ref: "#/$defs/tags" },
    mode: { anyOf: [{ type: "string" }, { type: "integer" }] },
    level: { enum: ["low", "high"] },
    names: { type: "array", items: { type: "string" } },
  };
  const render = (inputSchema: McpCandidate["inputSchema"]) =>
    renderSkills([{ ...base, inputSchema }])[0]?.text ?? "";
  const text = render({ ...base.inputSchema, properties });
  expect(text).toContain("- CLI: `forge sample echo --input '<json>'`");
  expect(text).toContain(
    '- Input: `value` string (required), `count` integer (optional), `preRelease` boolean (optional), `tags` see schema (optional), `mode` see schema (optional), `level` "low" | "high" (optional), `names` string[] (optional)\n',
  );
  expect(render({ type: "string" })).toContain(
    "- CLI: `forge sample echo --input '<json>'`\n- MCP: `sample_echo`\n- Input: string\n",
  );
  expect(render({ type: "array", items: { type: "string" } })).toContain(
    "- Input: string[]\n",
  );
}, 30_000);

test("a deprecation's replacement follows the noun rename; blocks cannot claim the skills noun", () => {
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
  expect(
    nounRefusal("skills", "io.github.alice", { firstPartyNouns: [] })?.code,
  ).toBe("NAME_RESERVED");
}, 30_000);
