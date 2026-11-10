import { relay } from "../fixtures/owner-approval.ts";
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
import {
  isAgentCallable,
  renamedOperation,
  type McpCandidate,
} from "../../src/contract/mcp.ts";
import {
  CORE_NOUNS,
  cliWords,
  mcpToolName,
  nounRefusal,
} from "../../src/contract/naming.ts";
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
  SKILL_MAX_BYTES,
  lintSkill,
  renderSkills,
} from "../../src/surface/skills.ts";
import { candidate } from "./fixtures/catalog.ts";

const repo = resolve(import.meta.dirname, "../..");
const allBlocks = ["accounts", "agent", "check", "memory", "project", "work"];

function operationSection(text: string, op: string): string {
  const sections = text.split("\n## ").slice(1);
  const found = sections.filter((section) => section.startsWith(`\`${op}\``));
  expect(found, op).toHaveLength(1);
  return found[0]!;
}

/** Read the published call templates, then apply only explicitly printed overrides. */
function skillCalls(text: string, op: string) {
  const shared = text.split("\n## ")[0]!;
  const cli = /CLI: `([^`]+)`/.exec(shared)?.[1];
  const mcp = /MCP: `([^`]+)`/.exec(shared)?.[1];
  expect(cli).toBe("forge <noun> <verb> --input '<json>'");
  expect(mcp).toMatch(/^(?:[a-z][a-z0-9-]*_)?<noun>_<verb>$/);
  expect(shared).toContain("keep hyphens");
  expect(shared).toContain("catalog_call");
  expect(shared).toContain("operation name and input");
  const [noun, verb] = op.split(".");
  const expand = (template: string) =>
    template.replace("<noun>", noun!).replace("<verb>", verb!);
  const section = operationSection(text, op);
  return {
    cli: /^- CLI: `([^`]+)`$/m.exec(section)?.[1] ?? expand(cli!),
    mcp: /^- MCP: `([^`]+)`$/m.exec(section)?.[1] ?? expand(mcp!),
  };
}

test("every generated operation retains its own calling facts and issue has 1024 bytes of headroom", async () => {
  await withProject((assembly) => {
    const catalog = assembly.catalog.list();
    const skills = renderSkills(catalog);
    console.table(
      skills.map(({ noun, text }) => ({
        noun,
        bytes: Buffer.byteLength(text),
      })),
    );
    for (const skill of skills) {
      const entries = catalog.filter(
        (entry) => entry.admitted && entry.op.split(".")[0] === skill.noun,
      );
      for (const entry of entries.filter((c) =>
        isAgentCallable(c.declaration),
      )) {
        const section = operationSection(skill.text, entry.op);
        expect(section).toContain(entry.docs.title);
        expect(section).toContain(entry.docs.summary);
        const schema = entry.argumentSchema ?? entry.inputSchema;
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const [name, field] of Object.entries(
          record(schema.properties) ?? {},
        )) {
          const s = record(field)!;
          const type = Array.isArray(s.enum)
            ? s.enum.map((value) => JSON.stringify(value)).join(" | ")
            : s.type === "array" && typeof record(s.items)?.type === "string"
              ? `${String(record(s.items)?.type)}[]`
              : Array.isArray(s.type)
                ? s.type.join(" | ")
                : typeof s.type === "string"
                  ? s.type
                  : "see schema";
          expect(section, entry.op).toContain(
            `\`${name}\` ${type} (${required.includes(name) ? "required" : "optional"})`,
          );
        }
        if (entry.declaration.effects.length === 0)
          expect(section).toContain("none (read-only)");
        for (const effect of entry.declaration.effects)
          expect(section).toContain(`\`${effect}\``);
        expect(section).toMatch(
          entry.declaration.idempotent
            ? /; idempotent(?:\n|$)/
            : /; not idempotent(?:\n|$)/,
        );
        const replacement = entry.declaration.deprecated?.use;
        if (replacement !== undefined)
          expect(section).toContain(
            `Deprecated: use \`${renamedOperation(replacement, entry.rename)}\`.`,
          );
      }
      for (const entry of entries.filter(
        (c) => !isAgentCallable(c.declaration),
      ))
        expect(skill.text.split("## Human only\n")[1]).toContain(
          `- \`${entry.op}\`: ${entry.docs.summary}`,
        );
    }
    const issue = skills.find((skill) => skill.noun === "issue");
    expect(issue).toBeDefined();
    expect(Buffer.byteLength(issue!.text)).toBeLessThanOrEqual(7168);
  }, allBlocks);
}, 30_000);

test("shared call rules and exceptions resolve every operation, renamed deprecation and missing MCP tool", async () => {
  await withProject((assembly) => {
    const old: McpCandidate = {
      ...candidate("demo.old", {
        stability: "deprecated",
        deprecated: { since: "0.2.0", use: "sample.new" },
      }),
      declaredOp: "sample.old",
      rename: { sample: "demo" },
    };
    const long = candidate(`${"d".repeat(21)}.${"v".repeat(21)}`);
    const missingPrefix = "p".repeat(21);
    const catalog = [
      ...assembly.catalog.list(),
      old,
      candidate("demo.new"),
      long,
      candidate("two-words.read-back"),
    ];
    expect(cliWords(long.op)).toBeDefined();
    expect(mcpToolName(long.op, missingPrefix)).toBeUndefined();
    for (const prefix of [undefined, "forge", missingPrefix]) {
      for (const skill of renderSkills(catalog, prefix)) {
        for (const entry of catalog.filter(
          (c) =>
            c.admitted &&
            isAgentCallable(c.declaration) &&
            c.op.split(".")[0] === skill.noun,
        )) {
          const calls = skillCalls(skill.text, entry.op);
          expect(calls.cli).toBe(
            `forge ${cliWords(entry.op)!.join(" ")} --input '<json>'`,
          );
          expect(calls.mcp).toBe(
            mcpToolName(entry.op, prefix) ?? "catalog_call",
          );
          expect(operationSection(skill.text, entry.op)).not.toContain(
            "- CLI:",
          );
          if (mcpToolName(entry.op, prefix) !== undefined)
            expect(operationSection(skill.text, entry.op)).not.toContain(
              "- MCP:",
            );
        }
      }
      const demo = renderSkills(catalog, prefix).find(
        (skill) => skill.noun === "demo",
      )!;
      expect(operationSection(demo.text, old.op)).toContain(
        "Deprecated: use `demo.new`.",
      );
      if (prefix === missingPrefix) {
        const fallback = renderSkills([long], prefix)[0]!;
        expect(operationSection(fallback.text, long.op)).toContain(
          "- MCP: `catalog_call`",
        );
      }
    }
  }, allBlocks);
}, 30_000);

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
  run: (assembly: Assembly, root: string) => Promise<void> | void,
  admit: readonly string[] = ["work", "memory"],
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "forge-skills-"));
  try {
    const blocks: Record<string, unknown> = {};
    for (const name of new Set(["work", "memory", ...admit])) {
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
          await relay(
            (op, input) => dispatch(assembly.catalog, op, input, call),
            "block.admit",
            { digest },
          ),
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
    const paths = ["decision", "issue", "lane", "memory"].map(
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
    expect(skillCalls(decision, "decision.propose")).toEqual({
      cli: "forge decision propose --input '<json>'",
      mcp: "decision_propose",
    });
    expect(decision).toContain("- Effects: `decision:write`; not idempotent");
    expect(decision).toContain("## `decision.adopt`");
    expect(skillCalls(decision, "decision.adopt").mcp).toBe("decision_adopt");
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
            ".agents/skills/lane/SKILL.md",
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

test("the generated issue skill explains the inclusive timestamp cutoff within its size limit", async () => {
  await withProject((assembly) => {
    const catalog = assembly.catalog.list();
    const text = renderSkills(catalog).find(
      (skill) => skill.noun === "issue",
    )!.text;
    const list = text.split("## `issue.list`")[1]?.split("\n## ")[0];
    expect(list).toContain("inclusive full RFC 3339 timestamp");
    expect(list).toContain("before limit");
    expect(list).toContain("truncated: more matches");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SKILL_MAX_BYTES);
    expect(lintSkill(text, catalog)).toEqual([]);
    for (const entry of catalog.filter((entry) =>
      entry.op.startsWith("issue."),
    )) {
      expect(text).toContain(`## \`${entry.op}\``);
      expect(text.split(`## \`${entry.op}\``)[1]?.split("\n## ")[0]).toContain(
        entry.docs.summary,
      );
    }
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
          written: [
            ".agents/skills/issue/SKILL.md",
            ".agents/skills/lane/SKILL.md",
          ],
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

test("every generated CLI call for the shipped blocks delivers its --input JSON through the real CLI parser", async () => {
  await withProject(async (assembly) => {
    const catalog = assembly.catalog.list();
    const input = { probe: [1, "two words"], nested: { ok: true } };
    const ops: string[] = [];
    for (const skill of renderSkills(catalog))
      for (const [, op = ""] of skill.text.matchAll(/^## `([^`]+)`/gm)) {
        const line = skillCalls(skill.text, op).cli;
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
    // One call per agent-callable block operation, and nothing else.
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
  expect(skillCalls(text, "sample.echo").mcp).toBe("forge_sample_echo");
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
  ["o3", "my_o3_identifier"],
  ["o3", "o3_identifier"],
  ["o3-mini", "my_o3_mini_identifier"],
  ["o1-preview", "prefixo1"],
  ["--model o3-mini", "--model <model id>"],
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
  expect(skillCalls(text, "sample.echo").cli).toBe(
    "forge sample echo --input '<json>'",
  );
  expect(text).toContain(
    '- Input: `value` string (required), `count` integer (optional), `preRelease` boolean (optional), `tags` see schema (optional), `mode` see schema (optional), `level` "low" | "high" (optional), `names` string[] (optional)\n',
  );
  const scalar = render({ type: "string" });
  expect(skillCalls(scalar, "sample.echo")).toEqual({
    cli: "forge sample echo --input '<json>'",
    mcp: "sample_echo",
  });
  expect(scalar).toContain("- Input: string\n");
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
