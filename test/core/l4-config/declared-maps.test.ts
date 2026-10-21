// A map key in a block's config schema (check's commands) is declared as a whole: detection fills
// it only while the project declares none of its entries.
import { afterEach, expect, test } from "bun:test";
import type { JsonSchema } from "../../../src/contract/schema.ts";
import { getIn } from "../../../src/core/config/pointer.ts";
import { schemaMaps } from "../../../src/core/config/short.ts";
import { type Fixture, makeProject, readJsonAt } from "./lib/project.ts";

const checkSchema = readJsonAt(
  "src/blocks/check/schemas/config.json",
) as JsonSchema;
const detected = (name: string, value: unknown) => ({
  key: `/blocks/check/config/commands/${name}`,
  value,
  origin: {
    detector: "project.detect",
    file: "package.json",
    pointer: `/scripts/${name}`,
  },
});
const detections = () => [
  detected("test", "bun test"),
  detected("lint", "bun run lint"),
  detected("build", "bun run build"),
  detected("format", "bun run format"),
];

const open: Fixture[] = [];
function project(
  schema: JsonSchema = checkSchema,
  observations = detections,
): Fixture {
  const made = makeProject({
    detections: observations,
    configSchema: (name) => (name === "check" ? schema : undefined),
  });
  open.push(made);
  return made;
}

for (const layer of ["project", "invocation"] as const) {
  test(`an empty ${layer} map entry suppresses detected siblings`, () => {
    const p = project(
      {
        type: "object",
        properties: {
          commands: {
            type: "object",
            additionalProperties: { type: "object" },
          },
        },
      },
      () => [detected("auto", {})],
    );
    p.config.set({
      path: "/blocks/check/enabled",
      value: true,
      expectRevision: p.config.show().revision,
    });
    if (layer === "project") {
      p.config.set({
        path: "check.commands",
        value: { manual: {} },
        expectRevision: p.config.show().revision,
      });
    }
    const shown = p.config.show(
      layer === "invocation"
        ? {
            invocation: [
              { op: "set", path: "check.commands.manual", value: {} },
            ],
          }
        : {},
    );
    expect(
      getIn(shown.effective, ["blocks", "check", "config", "commands"]),
    ).toEqual({ manual: {} });
    const derived = shown.values.filter((entry) => entry.layer === "derived");
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      pointer: "/blocks/check/config/commands/auto",
      active: false,
      overriddenBy: { layer, pointer: "/blocks/check/config/commands" },
    });
  }, 5000);
}

const openMaps = [
  {
    name: "empty properties",
    schema: {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    },
  },
  {
    name: "true additionalProperties",
    schema: { type: "object", additionalProperties: true },
  },
  {
    name: "empty properties and true additionalProperties",
    schema: { type: "object", properties: {}, additionalProperties: true },
  },
  { name: "implicit additionalProperties", schema: { type: "object" } },
  {
    name: "empty properties and implicit additionalProperties",
    schema: { type: "object", properties: {} },
  },
] as const;

for (const { name, schema } of openMaps) {
  test(`a map with ${name} replaces detected entries`, () => {
    const p = project({ type: "object", properties: { commands: schema } });
    declare(p);
    expect(p.config.explain({ path: "check.commands" }).value).toEqual({
      typecheck: "bun run check",
      test: "bun run test:unit",
    });
    expect(p.config.explain({ path: "check.commands.lint" })).toMatchObject({
      set: false,
      entries: [
        expect.objectContaining({
          active: false,
          overriddenBy: {
            layer: "project",
            pointer: "/blocks/check/config/commands",
          },
        }),
      ],
    });
  }, 5000);
}

test("fixed and closed objects are not declared maps", () => {
  expect(
    schemaMaps({
      type: "object",
      properties: {
        fixed: {
          type: "object",
          properties: { manual: { type: "string" } },
          additionalProperties: true,
        },
        closed: { type: "object", additionalProperties: false },
        emptyClosed: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    }),
  ).toEqual([]);
}, 5000);
afterEach(() => {
  for (const made of open.splice(0)) made.cleanup();
});

function declare(p: Fixture): void {
  p.config.set({
    path: "check.commands",
    value: { typecheck: "bun run check", test: "bun run test:unit" },
    expectRevision: p.config.show().revision,
  });
}

test("with no declared commands, the detected commands are the commands", () => {
  const p = project();
  expect(p.config.explain({ path: "check.commands" }).value).toEqual({
    test: "bun test",
    lint: "bun run lint",
    build: "bun run build",
    format: "bun run format",
  });
}, 5000);

test("declared commands are the commands: detection adds none, and explain shows why", () => {
  const p = project();
  declare(p);
  expect(p.config.explain({ path: "check.commands" }).value).toEqual({
    typecheck: "bun run check",
    test: "bun run test:unit",
  });
  expect(p.config.explain({ path: "check.commands.typecheck" })).toMatchObject({
    value: "bun run check",
    source: "project",
  });
  const lint = p.config.explain({ path: "check.commands.lint" });
  expect(lint.set).toBe(false);
  expect(lint.entries).toEqual([
    {
      pointer: "/blocks/check/config/commands/lint",
      value: "bun run lint",
      layer: "derived",
      origin: {
        detector: "project.detect",
        file: "package.json",
        pointer: "/scripts/lint",
      },
      active: false,
      overriddenBy: {
        layer: "project",
        pointer: "/blocks/check/config/commands",
      },
    },
  ]);
}, 5000);

test("save does not write back detected commands the project's declaration replaced", () => {
  const p = project();
  declare(p);
  const saved = p.config.save({ expectRevision: p.config.show().revision });
  expect(saved.saved).toEqual([]);
  expect(p.read()).not.toContain("bun run lint");
}, 5000);

for (const layer of ["project", "invocation"] as const) {
  test(`an explicitly empty ${layer} command map suppresses detected commands`, () => {
    const p = project();
    p.config.set({
      path: layer === "project" ? "check.commands" : "check.timeoutMs",
      value: layer === "project" ? {} : 1000,
      expectRevision: p.config.show().revision,
    });
    const shown = p.config.show(
      layer === "invocation"
        ? { invocation: [{ op: "set", path: "check.commands", value: {} }] }
        : {},
    );
    expect(
      getIn(shown.effective, ["blocks", "check", "config", "commands"]),
    ).toEqual({});
    const derived = shown.values.filter((entry) => entry.layer === "derived");
    expect(derived).toHaveLength(detections().length);
    for (const entry of derived) {
      expect(entry).toMatchObject({
        active: false,
        overriddenBy: { layer, pointer: "/blocks/check/config/commands" },
      });
    }
  }, 5000);
}
