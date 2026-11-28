import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, test } from "bun:test";
import { bundleSchema } from "../../src/contract/schema-bundle.ts";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../src/contract/schema.ts";
import type { McpCandidate } from "../../src/contract/mcp.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

function compile(schema: object | undefined) {
  if (schema === undefined) throw new Error("Missing tool schema");
  return new AjvJsonSchemaValidator().getValidator(schema);
}

test("MCP publication refuses extension anchors before the SDK can throw", () => {
  const base = "https://anchor.invalid/";
  const document = (name: string): SchemaObject => ({
    $id: `${base}${name}`,
    type: "string",
    "x-note": { $anchor: "shared" },
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
  let failure: unknown;
  try {
    createMcpHandlers(fakeCatalog([entry])).listTools();
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof Error))
    throw new Error("Expected Forge publication refusal");
  const message = failure.message;
  expect(message).toMatch(/cannot publish its input schema/);
  expect(message).toMatch(/\$anchor|\$id/);
  expect(message).not.toMatch(/duplicate anchor/i);
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
