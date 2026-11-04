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
import { createAssembly, localCall } from "../../../src/assembly/index.ts";
import { dispatch, record } from "../../../src/surface/dispatch.ts";
import { GENERATED_MARKER, lintSkill } from "../../../src/surface/skills.ts";
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
const inventory: Rule[] = rules;
const limits: Budgets = budgets;

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

test("delivery skill contracts: shape, links, rules, budgets, lint and mirrors", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-skill-contract-"));
  try {
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "p", scripts: { test: "node test.js" } }),
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
        const revision = await dispatch(
          first.catalog,
          "config.show",
          {},
          localCall(first),
        );
        return dispatch(
          first.catalog,
          op,
          {
            ...input,
            expectRevision: String(record(revision.result)?.revision ?? ""),
          },
          localCall(first),
        );
      };
      expect(
        await call("template.import", { template: "delivery" }),
      ).toMatchObject({ ok: true });
      for (const name of ["work", "memory", "check", "agent"]) {
        const target = join(root, "blocks", name);
        cpSync(join(repo, "src/blocks", name), target, { recursive: true });
        const { entry } = JSON.parse(
          readFileSync(join(target, "forge.block.json"), "utf8"),
        ) as { entry: string };
        writeFileSync(join(target, entry), "module.exports={};");
        expect(
          await call("config.set", {
            path: `/blocks/${name}/source`,
            value: { path: `./blocks/${name}` },
          }),
        ).toMatchObject({ ok: true });
      }
      expect(
        await call("config.set", {
          path: "/blocks/agent/config/adapters",
          value: [
            { id: "agents", detect: [], skills: ".agents/skills" },
            { id: "claude", detect: [], skills: ".claude/skills" },
          ],
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await first.close();
    }
    const assembly = await open();
    try {
      expect(
        await dispatch(
          assembly.catalog,
          "skills.sync",
          {},
          localCall(assembly),
        ),
      ).toMatchObject({ ok: true });
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
      for (const [path, text] of Object.entries(rendered)) {
        const wrapped = path.endsWith("/SKILL.md")
          ? text
          : `---\nname: reference\ndescription: Reference lint\n---\n${text}`;
        for (const problem of lintSkill(wrapped, assembly.catalog.list()))
          problems.push(`${path}: ${problem}`);
      }
      expect(problems, problems.join("\n")).toEqual([]);
      expect(inventory).toHaveLength(43);
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
      const checked = await dispatch(
        assembly.catalog,
        "skills.sync",
        { check: true },
        localCall(assembly),
      );
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

test("rule checker detects deletion, duplication and rewording until inventory changes", () => {
  expect(checkRules(fixture, [row])).toEqual([]);
  expect(checkRules({ ...fixture, [row.home]: "# Detail\n" }, [row])).toEqual([
    "rule example: not found in forge-example/detail.md",
  ]);
  expect(
    checkRules({ ...fixture, "forge-example/extra.md": fixture[row.home]! }, [
      row,
    ]),
  ).toEqual(["rule example: duplicate in forge-example/extra.md"]);
  expect(
    checkRules({ ...fixture, [row.home]: fixture[row.home]! + row.anchor }, [
      row,
    ]),
  ).toEqual(["rule example: duplicate in forge-example/detail.md"]);
  const rewritten = {
    ...fixture,
    [row.home]: "# Detail\n\nSave the evidence.\n",
  };
  expect(checkRules(rewritten, [row])).toHaveLength(1);
  expect(
    checkRules(rewritten, [{ ...row, anchor: "Save the evidence." }]),
  ).toEqual([]);
  expect(checkRules(fixture, [row, row])).toContain(
    "rule example: duplicate id",
  );
  const copied = { ...fixture, "forge-other/SKILL.md": row.anchor };
  expect(
    checkRules(copied, [{ ...row, copies: ["forge-other/SKILL.md"] }]),
  ).toEqual([]);
}, 5_000);

test("shape and link checkers reject missing sections, preamble reads and broken targets", () => {
  expect(checkShape(fixture, ["forge-example"])).toEqual([]);
  expect(checkLinks(fixture)).toEqual([]);
  const path = "forge-example/SKILL.md";
  expect(
    checkShape(
      { ...fixture, [path]: fixture[path]!.replace("## Steps", "## Work") },
      ["forge-example"],
    ),
  ).toContain(`${path}: missing ## Steps`);
  expect(
    checkShape(
      { ...fixture, [path]: fixture[path]!.replace("1. Read", "Read") },
      ["forge-example"],
    ),
  ).toContain(`${path}: step link has no trigger`);
  expect(
    checkShape(
      {
        ...fixture,
        [path]: fixture[path]!.replace(
          "# forge-example\n",
          "# forge-example\n[read](detail.md)\n",
        ),
      },
      ["forge-example"],
    ),
  ).toContain(`${path}: link outside Steps or Read on demand`);
  expect(
    checkLinks({
      ...fixture,
      [path]: fixture[path]!.replace("detail.md#detail", "missing.md"),
    }),
  ).toContain(`${path}: broken link missing.md`);
  expect(
    checkLinks({
      ...fixture,
      [path]: fixture[path]!.replace("#detail", "#missing"),
    }),
  ).toContain(`${path}: missing anchor detail.md#missing`);
  expect(
    checkLinks({ ...fixture, "forge-example/orphan.md": "# Orphan\n" }),
  ).toContain("forge-example/orphan.md: orphan reference");
  expect(
    checkLinks({
      ...fixture,
      [path]: fixture[path]!.replace("detail.md#detail", "../../outside.md"),
    }),
  ).toContain(`${path}: invalid cross-skill link ../../outside.md`);
}, 5_000);

test("budget and neutral-text checkers reject growth and harness-specific instructions", () => {
  const policy: Budgets = {
    migrated: ["forge-example"],
    router: 2_560,
    reference: 6_144,
    description: 300,
    routes: {
      example: {
        files: Object.keys(fixture),
        bytes: Object.values(fixture).reduce((n, text) => n + bytes(text), 0),
      },
    },
  };
  expect(checkBudgets(fixture, fixture, policy)).toEqual([]);
  const big = { ...fixture, "forge-example/detail.md": "x".repeat(6_145) };
  expect(checkBudgets(big, big, policy)).toContain(
    "forge-example/detail.md: exceeds 6144 source bytes",
  );
  expect(
    checkBudgets(big, big, policy).some((e) => e.includes("route bytes")),
  ).toBe(true);
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
    expect(checkNeutral({ "example.md": text })).toEqual([
      "example.md: non-neutral text",
    ]);
}, 5_000);
