import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import checkSchema from "../../../src/blocks/check/schemas/config.json" with { type: "json" };
import { validateWithSchema } from "../../../src/contract/schema.ts";
import { resolveLayers } from "../../../src/core/config/layers.ts";
import { schemaDefaults } from "../../../src/core/config/short.ts";
import { type Fixture, makeProject } from "../l4-config/lib/project.ts";

setDefaultTimeout(30_000);

const detected = (key: string, value: unknown) => ({
  key: `/blocks/check/config/${key}`,
  value,
  origin: { detector: "project.detect", file: "package.json" },
});
const npmTest = detected("commands/test", "npm test");

const open: Fixture[] = [];
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});
/** A project whose config file holds `text`, with forge/check's real schema. */
function project(text: string, detections: unknown[] = []): Fixture {
  const p = makeProject({
    detections: () => detections,
    configSchema: (_name, source) =>
      "builtin" in source && source.builtin === "forge/check"
        ? checkSchema
        : undefined,
  });
  open.push(p);
  mkdirSync(join(p.root, ".forge"));
  writeFileSync(join(p.root, ".forge/config.yaml"), text);
  return p;
}
const blocks = (p: Fixture) =>
  p.config.show().effective.blocks as Record<
    string,
    { config: Record<string, unknown> }
  >;

test("a short-form check with only commands runs with every other key from its schema", () => {
  const p = project("blocks:\n  check:\n    commands:\n      test: npm test\n");
  const config = blocks(p).check!.config;
  expect(config).toMatchObject({
    commands: { test: "npm test" },
    timeoutMs: 600000,
    report: "auto",
  });
  expect(validateWithSchema(checkSchema, config)).toEqual([]);
  expect(p.config.show().instances).toEqual([
    { name: "check", source: { builtin: "forge/check" }, enabled: true },
  ]);
});

test("default < derived < project file", () => {
  const detections = [
    npmTest,
    detected("timeoutMs", 5),
    detected("maxInputBytes", 6),
  ];
  const p = project("blocks:\n  check:\n    timeoutMs: 7\n", detections);
  expect(blocks(p).check!.config).toMatchObject({
    commands: { test: "npm test" },
    timeoutMs: 7,
    maxInputBytes: 6,
    report: "auto",
  });
});

test("forge/check has a default, within its bounds, for every key but commands", () => {
  const defaults = Object.fromEntries(
    schemaDefaults(checkSchema).map((d) => [d.key, d.value]),
  );
  expect(Object.keys(defaults).sort()).toEqual(
    checkSchema.required.filter((k) => k !== "commands").sort(),
  );
  expect(
    validateWithSchema(checkSchema, { ...defaults, commands: { t: "x" } }),
  ).toEqual([]);
});

test("an explicit empty object wins over an object default", () => {
  const document = {
    schemaVersion: "forge.config/1",
    blocks: { hello: { config: { style: {} } } },
  };
  const style = ["blocks", "hello", "config", "style"];
  const layers = resolveLayers(
    { entries: [], ignored: [] },
    document,
    [],
    [{ segments: style, value: { loud: true } }],
  );
  expect(layers.effective).toEqual({ blocks: document.blocks });
  expect(layers.entries.find((e) => e.layer === "default")?.active).toBe(false);
});

test("with check on and its commands detected, an unrelated edit succeeds", () => {
  const p = project("blocks:\n  check: {}\n", [npmTest]);
  const edit = p.config.set({
    path: "check.stopOnFailure",
    value: false,
    expectRevision: p.config.show().revision,
  });
  expect(edit.receipt).not.toBeNull();
  expect(blocks(p).check!.config).toMatchObject({
    stopOnFailure: false,
    commands: { test: "npm test" },
  });
});

test("explain names each value's source, including a short name's implied source", () => {
  const p = project("blocks:\n  check:\n    timeoutMs: 9\n", [npmTest]);
  const source = (path: string) => p.config.explain({ path }).source;
  expect([
    source("check.report"),
    source("check.commands.test"),
    source("check.timeoutMs"),
  ]).toEqual(["default", "derived", "project"]);
  expect(p.config.explain({ path: "/blocks/check/source" })).toMatchObject({
    value: { builtin: "forge/check" },
    source: "default",
  });
  p.templates.importTemplate({
    template: "forge/starter",
    expectRevision: p.config.show().revision,
  });
  expect(source("/blocks/work/source")).toBe("template");
});

test("short form: use: is a relative path or a package, other keys are config, absolute paths are refused", () => {
  const p = project(
    "blocks:\n  hello:\n    use: ./blocks/hello\n    greeting: hi\n  lint:\n    use: '@acme/lint'\n  far:\n    use: /opt/far\n",
  );
  const show = p.config.show();
  expect(show.instances.map((i) => i.source)).toEqual([
    { path: "./blocks/hello" },
    { package: "@acme/lint" },
  ]);
  expect(p.config.explain({ path: "hello.greeting" }).value).toBe("hi");
  expect(show.excluded).toEqual([
    {
      pointer: "/blocks/far",
      problems: [
        "/blocks/far/use must be a path relative to the project, like ./blocks/far",
      ],
    },
  ]);
});
