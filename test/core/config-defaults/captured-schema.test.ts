import { expect, setDefaultTimeout, test } from "bun:test";
import type { JsonSchema } from "../../../src/contract/schema.ts";
import { captureBlock } from "../../../src/core/catalog/index.ts";
import { schemaDefaults, schemaMaps } from "../../../src/core/config/short.ts";

setDefaultTimeout(5000);

function capture(
  schema: JsonSchema,
  dependencies: Record<string, JsonSchema> = {},
) {
  const files: Record<string, string> = {
    "block.json": JSON.stringify({
      schemaVersion: "forge.block/1",
      id: "example.org/sample",
      version: "1.0.0",
      authorAbi: "forge.author/v2",
      profile: "trusted-action/v2",
      entry: "entry.cjs",
      docs: "docs.json",
      configSchema: "config.json",
      files: Object.keys(dependencies),
      operations: {
        "sample.run": {
          input: "value.json",
          output: "value.json",
          context: "stateless",
          effects: [],
          idempotent: true,
          callers: ["human"],
          stability: "experimental",
        },
      },
    }),
    "entry.cjs": "module.exports={}",
    "value.json": "true",
    "docs.json": JSON.stringify({ operations: {} }),
    "config.json": JSON.stringify(schema),
    ...Object.fromEntries(
      Object.entries(dependencies).map(([name, value]) => [
        name,
        JSON.stringify(value),
      ]),
    ),
  };
  return captureBlock("fixture", {
    open: () => ({
      ownership: "borrowed",
      value: { read: (name) => new TextEncoder().encode(files[name]) },
    }),
  });
}

test("captured root and property siblings compose in their own document bases", () => {
  const block = capture(
    {
      $ref: "defs.json#/$defs/Config",
      $defs: { commands: { type: "object", default: { manual: "run" } } },
      required: ["tone"],
      properties: {
        commands: { $ref: "#/$defs/commands" },
        tone: { type: "string", default: "calm" },
      },
    },
    {
      "defs.json": {
        $defs: {
          Config: {
            type: "object",
            required: ["commands"],
            properties: { commands: { $ref: "#/$defs/commands" } },
          },
          commands: {
            type: "object",
            additionalProperties: { type: "string" },
            minProperties: 1,
          },
        },
      },
    },
  );
  const schema = block.resolvedSchema("config.json");
  expect(schema).toMatchObject({
    required: ["commands", "tone"],
    properties: {
      commands: {
        type: "object",
        minProperties: 1,
        additionalProperties: { type: "string" },
        default: { manual: "run" },
      },
    },
  });
  expect(schemaMaps(schema)).toEqual(["commands"]);
  expect(schemaDefaults(schema)).toEqual([
    { key: "commands", value: { manual: "run" } },
    { key: "tone", value: "calm" },
  ]);
  expect(
    block.problems("config.json", {
      commands: { manual: "run" },
      tone: "calm",
    }),
  ).toEqual([]);
});

test("property reference siblings keep fixed and closed objects out of maps", () => {
  const block = capture({
    type: "object",
    $defs: { map: { type: "object", additionalProperties: true } },
    properties: {
      fixed: {
        $ref: "#/$defs/map",
        properties: { manual: { type: "string" } },
      },
      closed: { $ref: "#/$defs/map", additionalProperties: false },
      open: { $ref: "#/$defs/map", default: {} },
      plain: { type: "object" },
    },
  });
  expect(schemaMaps(block.resolvedSchema("config.json"))).toEqual([
    "open",
    "plain",
  ]);
  expect(schemaDefaults(block.resolvedSchema("config.json"))).toEqual([
    { key: "open", value: {} },
  ]);
  expect(
    block.problems("config.json", { closed: { manual: "run" } }),
  ).not.toEqual([]);
});

test("recursive root and property references retain the bounded reading projection", () => {
  const root = capture({ $ref: "#" });
  expect(root.resolvedSchema("config.json")).toMatchObject({ $ref: "#" });
  const property = capture({
    type: "object",
    $defs: { recursive: { $ref: "#/$defs/recursive" } },
    properties: { commands: { $ref: "#/$defs/recursive" } },
  });
  expect(schemaMaps(property.resolvedSchema("config.json"))).toEqual([]);
  expect(property.resolvedSchema("config.json")).toMatchObject({
    properties: { commands: { $ref: "#/$defs/recursive" } },
  });
});

test("uncaptured references are still refused by the shared registry", () => {
  expect(() =>
    capture({
      type: "object",
      properties: { commands: { $ref: "missing.json" } },
    }),
  ).toThrow("does not resolve");
});
