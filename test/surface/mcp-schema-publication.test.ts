import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, test } from "bun:test";
import { bundleSchema } from "../../src/contract/schema-bundle.ts";
import {
  SchemaRegistry,
  type JsonSchema,
  type SchemaObject,
} from "../../src/contract/schema.ts";
import type { McpCandidate } from "../../src/contract/mcp.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

function compile(schema: object | undefined) {
  if (schema === undefined) throw new Error("Missing tool schema");
  return new AjvJsonSchemaValidator().getValidator(schema);
}

function listTools(entry: McpCandidate) {
  return createMcpHandlers(fakeCatalog([entry])).listTools();
}

test.each(["$anchor", "$dynamicAnchor"])(
  "MCP publication refuses duplicate extension %s before the SDK can throw",
  (anchor) => {
    const base = "https://anchor.invalid/";
    const document = (name: string): SchemaObject => ({
      $id: `${base}${name}`,
      type: "string",
      "x-note": { [anchor]: "shared" },
    });
    const registry = new SchemaRegistry([
      {
        $id: `${base}root.json`,
        type: "object",
        properties: {
          a: { $ref: "a.json" },
          b: { $ref: "b.json" },
        },
      },
      document("a.json"),
      document("b.json"),
    ]);
    const publication = bundleSchema(registry, `${base}root.json`);
    const entry: McpCandidate & { projectSchema: () => SchemaObject } = {
      ...candidate(),
      inputSchema: publication,
      projectSchema: () => publication,
    };
    expect(() => compile(publication)).toThrow(
      /resolves to more than one schema/,
    );
    expect(() => listTools(entry)).toThrow(
      /cannot publish its input schema.*\$(?:dynamicAnchor|anchor|id)/,
    );
  },
  30_000,
);

test("MCP publication refuses a single invalid extension dynamic anchor", () => {
  const entry = {
    ...candidate(),
    inputSchema: { type: "object", "x-note": { $dynamicAnchor: "bad anchor" } },
  };
  expect(() => listTools(entry)).toThrow(
    /cannot publish its input schema.*\$dynamicAnchor/,
  );
}, 30_000);

test.each([
  { value: [{ $anchor: "shared" }, { $id: "https://literal.invalid/a" }] },
  { value: { const: { $id: "literal" } } },
])(
  "MCP publication preserves extensions the SDK treats as data ($value)",
  ({ value }) => {
    const entry = {
      ...candidate(),
      inputSchema: { type: "object", "x-note": value },
    };
    expect(() => listTools(entry)).not.toThrow();
    const schema = listTools(entry).find(
      (tool) => tool.name === "sample_echo",
    )?.inputSchema;
    expect(schema?.["x-note"]).toEqual(value);
    expect(() => compile(schema)).not.toThrow();
  },
  30_000,
);

test("MCP publication refuses resource IDs in a composition inside an extension", () => {
  const entry = {
    ...candidate(),
    inputSchema: {
      type: "object",
      "x-note": { allOf: [{ $id: "https://literal.invalid/a" }] },
    },
  };
  expect(() => listTools(entry)).toThrow(
    /cannot publish its input schema.*\$id/,
  );
}, 30_000);

test("MCP listing refuses a referenced date-time schema expanded past its budget", () => {
  const id = "https://timestamp.invalid/root.json";
  const inputSchema = {
    $id: id,
    type: "object",
    properties: { at: { $ref: "timestamp.json" } },
  };
  const registry = new SchemaRegistry([
    inputSchema,
    {
      $id: "https://timestamp.invalid/timestamp.json",
      allOf: Array.from({ length: 2_048 }, () => ({ format: "date-time" })),
    },
  ]);
  expect(() => bundleSchema(registry, id)).not.toThrow();
  const entry = {
    ...candidate(),
    inputSchema,
    projectSchema: () => bundleSchema(registry, id),
  };
  expect(() => listTools(entry)).toThrow(
    /cannot publish its input schema.*work budget exceeded/i,
  );
}, 30_000);

test("MCP listing counts the output envelope toward the schema depth limit", () => {
  const output = (depth: number) =>
    Array.from({ length: depth }).reduce<JsonSchema>(
      (items) => ({ items }),
      true,
    ) as SchemaObject;
  expect(() =>
    listTools({ ...candidate(), outputSchema: output(62) }),
  ).not.toThrow();
  expect(() => listTools({ ...candidate(), outputSchema: output(64) })).toThrow(
    /cannot publish its output schema.*depth limit exceeded \(64\)/i,
  );
}, 30_000);

test("MCP publication keeps anchor and id text inside assertion literals", () => {
  const literal = { $anchor: "literal", $id: "literal" };
  const entry = {
    ...candidate(),
    inputSchema: {
      type: "object",
      properties: {
        value: { const: literal, enum: [literal], default: literal },
      },
    },
  };
  const schema = createMcpHandlers(fakeCatalog([entry]))
    .listTools()
    .find((tool) => tool.name === "sample_echo")?.inputSchema;
  expect(() => compile(schema)).not.toThrow();
  const value = (schema as SchemaObject).properties as {
    value: { const: unknown; enum: unknown[]; default: unknown };
  };
  expect(value.value.const).toEqual(literal);
  expect(value.value.enum).toEqual([literal]);
  expect(value.value.default).toEqual(literal);
}, 30_000);

test("MCP listing refuses a schema cycle instead of publishing it", () => {
  const catalog = fakeCatalog([
    { ...candidate(), inputSchema: { type: "object", not: { $ref: "#" } } },
  ]);
  expect(() => createMcpHandlers(catalog).listTools()).toThrow(
    /cannot publish its input schema.*cycle/i,
  );
}, 30_000);
