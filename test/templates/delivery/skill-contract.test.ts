import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Assembly,
  createAssembly,
  localCall,
} from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { GENERATED_MARKER } from "../../../src/surface/skills.ts";
import {
  bytes,
  checkBudgets,
  checkLinks,
  checkNeutral,
  checkRules,
  checkShape,
  lf,
  type Budgets,
  type Files,
  type Rule,
} from "./lib/skill-contract.ts";
import budgets from "./budgets.json" with { type: "json" };
import rules from "./rules.json" with { type: "json" };

const repo = resolve(import.meta.dirname, "../../..");
const sourceRoot = join(repo, "templates/delivery/skills");
const inventory: Rule[] = (
  rules as [string, string, string, (string | number | null)?, string[]?][]
).map(([id, home, anchor, value, copies]) => ({
  id,
  home,
  anchor,
  ...(value == null ? {} : { value }),
  ...(copies ? { copies } : {}),
}));
const limits: Budgets = budgets;
const DISPATCH_ORDER =
  /Before dispatch,[^\n]+forge issue call[^\n]+Retry REVISION_CONFLICT[^\n]+Then dispatch the subagent\./;

function tree(root: string, prefix = ""): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, tree(root, `${path}/`));
    else files[path] = readFileSync(join(root, path));
  }
  return files;
}
function markdown(files: Record<string, Buffer>): Files {
  return Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.endsWith(".md"))
      .map(([path, text]) => [path, lf(text.toString())]),
  );
}

function invoke(assembly: Assembly, op: string, input: object = {}) {
  return dispatch(assembly.catalog, op, input, localCall(assembly));
}

test("delivery skill contracts: shape, links, rules, budgets, lint and mirrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-skill-contract-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "p", scripts: { test: "echo fixture" } }),
    );
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({ schemaVersion: "forge.config/1", blocks: {} }),
    );
    const open = async () =>
      createAssembly({ root, deviceRoot: join(root, "device") });
    const first = await open();
    try {
      const call = async (op: string, input: object) => {
        const revision = record(
          (await invoke(first, "config.show")).result,
        )?.revision;
        const expectRevision =
          typeof revision === "string" ? String(revision) : "";
        expect(
          await invoke(first, op, { ...input, expectRevision }),
        ).toMatchObject({ ok: true });
      };
      await call("template.import", { template: "delivery" });
      for (const name of ["accounts", "work", "memory", "check", "agent"]) {
        const target = join(root, "blocks", name);
        cpSync(join(repo, "src/blocks", name), target, { recursive: true });
        const { entry } = JSON.parse(
          readFileSync(join(target, "forge.block.json"), "utf8"),
        ) as { entry: string };
        writeFileSync(join(target, entry), "module.exports={};");
        await call("config.set", {
          path: `/blocks/${name}/source`,
          value: { path: `./blocks/${name}` },
        });
      }
      await call("config.set", {
        path: "/blocks/agent/config/adapters",
        value: [
          { id: "agents", detect: [], skills: ".agents/skills" },
          { id: "claude", detect: [], skills: ".claude/skills" },
        ],
      });
    } finally {
      await first.close();
    }
    const assembly = await open();
    try {
      expect(await invoke(assembly, "skills.sync")).toMatchObject({ ok: true });
      const source = tree(sourceRoot);
      const adopted = tree(join(root, ".agents/skills"));
      const other = tree(join(root, ".claude/skills"));
      const shipped = Object.fromEntries(
        Object.entries(adopted).filter(([path]) => path.startsWith("forge-")),
      );
      const rendered = markdown(shipped);
      const problems = [
        ...checkShape(markdown(source), limits.migrated),
        ...checkLinks(rendered),
        ...checkRules(rendered, inventory),
        ...checkBudgets(markdown(source), rendered, limits),
        ...checkNeutral(rendered),
      ];
      expect(problems, problems.join("\n")).toEqual([]);
      expect(inventory).toHaveLength(88);
      expect(rendered["forge-loop/dispatch.md"]).toMatch(DISPATCH_ORDER);
      expect(Object.keys(shipped).sort()).toEqual(Object.keys(source).sort());
      expect(
        Object.keys(other)
          .filter((path) => path.startsWith("forge-"))
          .sort(),
      ).toEqual(Object.keys(source).sort());
      for (const [path, original] of Object.entries(source)) {
        expect(adopted[path], path).toEqual(other[path]);
        if (!path.endsWith("/SKILL.md"))
          expect(adopted[path], path).toEqual(original);
        else {
          const names = Object.keys(source)
            .filter((p) => p.startsWith(path.slice(0, -8)) && p !== path)
            .map((p) => p.slice(path.length - 8))
            .sort();
          const marker = `${GENERATED_MARKER}\n${names.length ? `<!-- forge companions: ${names.join(", ")} -->\n` : ""}`;
          const expected = lf(original.toString()).replace(
            /^(---\n[\s\S]*?\n---\n)/,
            `$1${marker}`,
          );
          expect(lf(adopted[path]!.toString()), path).toBe(expected);
        }
      }
      const checked = await invoke(assembly, "skills.sync", { check: true });
      expect(checked).toMatchObject({ ok: true });
      expect(record(checked.result)?.differences).toEqual([]);
    } finally {
      await assembly.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

const fixture: Files = {
  "forge-example/SKILL.md":
    '---\nname: forge-example\ndescription: "Use when checking a fixture."\n---\n# forge-example\n\n## Steps\n1. Read [detail](detail.md#detail) when needed.\n\n## Hard rules\nStop at the boundary.\n\n## Read on demand\n- [detail](detail.md): Detail.\n',
  "forge-example/detail.md": "# Detail\n\nKeep the evidence.\n",
};
const row: Rule = {
  id: "example",
  home: "forge-example/detail.md",
  anchor: "Keep the evidence.",
};

function changed(path: string, text: string): Files {
  return { ...fixture, [path]: text };
}
function edit(from: string, to: string): Files {
  const path = "forge-example/SKILL.md";
  return changed(path, fixture[path]!.replace(from, to));
}

test("rule checker detects deletion, duplication and rewording until inventory changes", () => {
  expect(checkRules(fixture, [row])).toEqual([]);
  const bad = [
    changed(row.home, "# Detail\n"),
    changed("extra.md", row.anchor),
    changed(row.home, row.anchor.repeat(2)),
  ];
  for (const files of bad) expect(checkRules(files, [row])).toHaveLength(1);
  const rewritten = changed(row.home, "# Detail\nSave the evidence.");
  expect(checkRules(rewritten, [row])).toHaveLength(1);
  const updated = { ...row, anchor: "Save the evidence." };
  expect(checkRules(rewritten, [updated])).toEqual([]);
  expect(checkRules(fixture, [row, row])).toContain(
    "rule example: duplicate id",
  );
  const copied = changed("other.md", row.anchor);
  expect(checkRules(copied, [{ ...row, copies: ["other.md"] }])).toEqual([]);
}, 5_000);

test("intake contracts reject removed call, limit, prototype isolation and report rules", () => {
  const source = markdown(tree(sourceRoot));
  for (const id of [
    "in.call.count",
    "in.call.limit",
    "in.proto.workspace",
    "in.proto.destination",
  ]) {
    const rule = inventory.find((candidate) => candidate.id === id)!;
    expect(checkRules(source, [rule])).toEqual([]);
    const missing = {
      ...source,
      [rule.home]: source[rule.home]!.replace(rule.anchor, ""),
    };
    expect(checkRules(missing, [rule])).toContain(
      `rule ${id}: not found in ${rule.home}`,
    );
  }
  const intake = source["forge-loop/dispatch.md"]!;
  expect(intake).toMatch(DISPATCH_ORDER);
  const call = inventory.find((rule) => rule.id === "in.call.count")!.anchor;
  for (const instruction of [
    "Retry REVISION_CONFLICT.",
    "Then dispatch the subagent.",
  ]) {
    const reordered = intake
      .replace(instruction, "")
      .replace(call, `${instruction} ${call}`);
    expect(reordered).not.toMatch(DISPATCH_ORDER);
  }
}, 5_000);

test("shape and links reject missing sections, preamble reads and broken targets", () => {
  const shape = (files: Files) => checkShape(files, ["forge-example"]);
  expect(shape(fixture)).toEqual([]);
  expect(checkLinks(fixture)).toEqual([]);
  for (const files of [
    edit("## Steps", "## Work"),
    edit("1. Read", "Read"),
    edit("# forge-example\n", "# forge-example\n[read](detail.md)\n"),
    edit("[detail](detail.md#detail) when needed", "[when](detail.md)"),
    edit("[detail](detail.md#detail) when needed", "[detail](when.md)"),
  ])
    expect(shape(files).length).toBeGreaterThan(0);
  for (const to of ["missing.md", "detail.md#missing", "../../outside.md"])
    expect(checkLinks(edit("detail.md#detail", to)).length).toBeGreaterThan(0);
  expect(
    checkLinks(changed("forge-example/orphan.md", "# Orphan")),
  ).toHaveLength(1);
}, 5_000);

test("budgets and neutrality reject growth and harness-specific instructions", () => {
  const policy: Budgets = {
    migrated: ["forge-example"],
    router: 2560,
    reference: 6144,
    description: 300,
    routes: {
      example: {
        files: Object.keys(fixture),
        bytes: Object.values(fixture).reduce((n, text) => n + bytes(text), 0),
      },
    },
  };
  expect(checkBudgets(fixture, fixture, policy)).toEqual([]);
  const big = changed(row.home, "x".repeat(6145));
  expect(checkBudgets(big, big, policy)).toHaveLength(2);
  const noRoutes = { ...policy, routes: {} };
  expect(checkBudgets(fixture, big, noRoutes)).toEqual([]);
  const path = "forge-example/SKILL.md";
  const marker = `${GENERATED_MARKER}\n`;
  const text = fixture[path]!.padEnd(policy.router - bytes(marker));
  const source = changed(path, text);
  const rendered = changed(path, text + marker);
  expect(checkBudgets(source, rendered, noRoutes)).toEqual([]);
  const oversized = { ...rendered, [path]: rendered[path]! + "x" };
  expect(checkBudgets(source, oversized, noRoutes)).toEqual([
    `${path}: exceeds 2560 rendered bytes`,
  ]);
  expect(checkNeutral(fixture)).toEqual([]);
  for (const text of [
    "watch_pull_request",
    "Claude Code",
    "Codex",
    "T3",
    "templates/",
    "{{value}}",
    "<!-- rule: example -->",
  ])
    expect(checkNeutral({ "example.md": text })).toHaveLength(1);
}, 5_000);
