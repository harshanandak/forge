// The user's picks win: saving derived values and removing a template never replace a
// value the project sets, and a config file that is only partly valid still shows its valid part.
// Each case runs the declared operations against a real config file on disk, checking every output
// against its declared schema.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_DOCUMENTS,
  type SchemaObject,
  SchemaRegistry,
  type TemplateDocument,
} from "../../../src/contract/index.ts";
import { createConfigOperations } from "../../../src/core/config/index.ts";
import {
  type Fixture,
  type FixtureOptions,
  makeProject,
} from "./lib/project.ts";

setDefaultTimeout(30_000);

const DIR = new URL("../../../src/core/config/", import.meta.url);
const read = (path: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, DIR)), "utf8"));
const declared = (
  read("operations.json") as {
    operations: Record<string, { input: string; output: string }>;
  }
).operations;
const registry = new SchemaRegistry([
  ...SCHEMA_DOCUMENTS,
  ...readdirSync(fileURLToPath(new URL("schemas/", DIR))).map(
    (name) => read(`schemas/${name}`) as SchemaObject,
  ),
]);
const BASE =
  "https://raw.githubusercontent.com/harshanandak/forge/main/src/core/config/";

type Output = Record<string, unknown>;

const open: Fixture[] = [];
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

function project(options: FixtureOptions = {}) {
  const p = makeProject(options);
  open.push(p);
  const handlers = createConfigOperations(p.env);
  const call = (op: string, input: Output = {}): Output => {
    const declaration = declared[op];
    if (declaration === undefined) throw new Error(op);
    expect(registry.validate(`${BASE}${declaration.input}`, input)).toEqual([]);
    const output = JSON.parse(JSON.stringify(handlers[op]?.(input))) as Output;
    expect({
      op,
      problems: registry.validate(`${BASE}${declaration.output}`, output),
    }).toEqual({ op, problems: [] });
    return output;
  };
  const revision = (): string => call("config.show").revision as string;
  const file = (): string => p.read() ?? "";
  const install = (template: TemplateDocument): void => {
    p.installed.set(template.id, template);
  };
  return { p, call, revision, file, install };
}

function template(
  id: string,
  version: string,
  check: Record<string, unknown>,
): TemplateDocument {
  return {
    schemaVersion: "forge.template/1",
    id,
    version,
    summary: `${id} for tests`,
    config: {
      schemaVersion: "forge.config/1",
      blocks: {
        check: { source: { builtin: "forge/check" }, config: check },
      },
    },
  } as unknown as TemplateDocument;
}

describe("saving derived values", () => {
  test("saving a derived object fills only what the project does not set, at any depth", () => {
    const { call, revision, file } = project({
      detections: () => [
        {
          key: "/blocks/check/config/commands",
          value: { test: "npm test", lint: "npm run lint" },
          origin: { detector: "project.detect", file: "package.json" },
        },
      ],
    });
    call("config.set", {
      path: "check.commands.test",
      value: "pnpm test",
      expectRevision: revision(),
    });
    const saved = call("config.save", { expectRevision: revision() });
    expect(saved.saved).toEqual(["/blocks/check/config/commands"]);
    expect(file()).toContain("test: pnpm test");
    expect(file()).toContain("lint: npm run lint");
    expect(file()).not.toContain("test: npm test");
    const shown = call("config.show");
    expect(shown.effective).toMatchObject({
      blocks: {
        check: {
          config: { commands: { test: "pnpm test", lint: "npm run lint" } },
        },
      },
    });
    // nothing left to fill: a second save writes nothing and says why
    const again = call("config.save", { expectRevision: revision() });
    expect(again.changes).toEqual([]);
  });
});

describe("templates and saved values", () => {
  test("a saved derived value is the user's, even where a template's removed key was", () => {
    const { call, revision, file, install } = project({
      detections: () => [
        {
          key: "/blocks/check/config/timeout",
          value: 300,
          origin: { detector: "project.detect", file: "package.json" },
        },
      ],
    });
    install(template("acme/a", "1.0.0", { timeout: 300, retries: 1 }));
    call("template.import", { template: "acme/a", expectRevision: revision() });
    call("config.apply", {
      patch: [{ op: "remove", path: "check.timeout" }],
      expectRevision: revision(),
    });
    call("config.save", { expectRevision: revision() });
    expect(file()).toContain("timeout: 300");
    // removing the template takes its unchanged keys, not the value the user saved
    call("template.remove", { template: "acme/a", expectRevision: revision() });
    expect(file()).toContain("timeout: 300");
    expect(file()).not.toContain("retries");
  });
});

describe("a schema-invalid config file", () => {
  test("show leaves invalid parts out of the effective view and reports where they are", () => {
    const { p, call } = project();
    mkdirSync(join(p.root, ".forge"), { recursive: true });
    writeFileSync(
      join(p.root, ".forge/config.yaml"),
      [
        "schemaVersion: forge.config/1",
        "blocks:",
        "  check:",
        "    source:",
        "      foo: x",
        "    config:",
        "      commands:",
        "        test: make test",
        "  work:",
        "    source:",
        "      builtin: forge/work",
        "    config:",
        "      scope: project",
        "extra: 1",
        "",
      ].join("\n"),
    );
    const shown = call("config.show") as {
      instances: { name: string }[];
      excluded: { pointer: string; problems: string[] }[];
      problems: string[];
      effective: Record<string, unknown>;
      revision: string;
    };
    expect(shown.instances.map((i) => i.name)).toEqual(["work"]);
    expect(shown.excluded.map((e) => e.pointer)).toEqual([
      "/blocks/check",
      "/extra",
    ]);
    expect(shown.excluded[0]?.problems.join("\n")).toContain(
      ".forge/config.yaml: blocks.check.source.foo:",
    );
    expect(shown.problems.length).toBeGreaterThan(0);
    expect(shown.effective).toEqual({
      blocks: {
        work: {
          source: { builtin: "forge/work" },
          config: { scope: "project" },
        },
      },
    });
  });
});
