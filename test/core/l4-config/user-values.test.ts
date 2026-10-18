// The user's picks win: saving derived values, updating a template and removing one never replace a
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
    expect(again.receipt).toBeNull();
  });
});

describe("template updates and ownership", () => {
  test("a conflict not yet accepted keeps the user's value whole when the template changes its shape", () => {
    const { call, revision, file, install } = project();
    install(template("acme/a", "1.0.0", { timeout: 300 }));
    call("template.import", { template: "acme/a", expectRevision: revision() });
    install(template("acme/a", "2.0.0", { timeout: { seconds: 600 } }));
    const update = call("template.update", {
      template: "acme/a",
      expectRevision: revision(),
    });
    expect(file()).toContain("timeout: 300");
    expect(update.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/blocks/check/config/timeout",
          kind: "remove",
          reason:
            "held until the conflict at /blocks/check/config/timeout/seconds is accepted",
        }),
        expect.objectContaining({
          pointer: "/blocks/check/config/timeout/seconds",
          kind: "conflict",
        }),
      ]),
    );
    // accepting the conflict applies the shape change in one step
    const accepted = call("template.update", {
      template: "acme/a",
      expectRevision: revision(),
      accept: ["/blocks/check/config/timeout/seconds"],
    });
    expect(accepted.conflicts).toEqual([]);
    expect(file()).toContain("seconds: 600");
    expect(file()).not.toContain("timeout: 300");
  });

  test("the reverse shape change also waits: an object the template owned stays until accepted", () => {
    const { call, revision, file, install } = project();
    install(template("acme/a", "1.0.0", { timeout: { seconds: 600 } }));
    call("template.import", { template: "acme/a", expectRevision: revision() });
    install(template("acme/a", "2.0.0", { timeout: 300 }));
    call("template.update", { template: "acme/a", expectRevision: revision() });
    expect(file()).toContain("seconds: 600");
    call("template.update", {
      template: "acme/a",
      expectRevision: revision(),
      accept: ["/blocks/check/config/timeout"],
    });
    expect(file()).toContain("timeout: 300");
    expect(file()).not.toContain("seconds");
  });

  test("an update that drops a shared key hands it to the earliest-imported template that sets it", () => {
    const { call, revision, file, install } = project();
    install(template("acme/a", "1.0.0", { commands: { test: "npm test" } }));
    install(template("acme/b", "1.0.0", { commands: { test: "npm test" } }));
    install(template("acme/c", "1.0.0", { commands: { test: "npm test" } }));
    for (const id of ["acme/a", "acme/c", "acme/b"])
      call("template.import", { template: id, expectRevision: revision() });
    install(template("acme/a", "2.0.0", { timeout: 300 }));
    const update = call("template.update", {
      template: "acme/a",
      expectRevision: revision(),
    });
    expect(update.applied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pointer: "/blocks/check/config/commands/test",
          kind: "kept",
          reason: "acme/c@1.0.0 sets the same value",
        }),
      ]),
    );
    expect(file()).toContain("test: npm test");
    const shown = call("config.show") as {
      values: { pointer: string; owner?: { from: string } }[];
    };
    expect(
      shown.values.find(
        (v) => v.pointer === "/blocks/check/config/commands/test",
      )?.owner?.from,
    ).toBe("acme/c@1.0.0");
    // and removing the new owner hands it on again, to b
    call("template.remove", { template: "acme/c", expectRevision: revision() });
    expect(file()).toContain("test: npm test");
    expect(file()).toContain("from: acme/b@1.0.0");
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
      "/blocks/check/source/foo",
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
