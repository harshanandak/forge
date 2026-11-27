import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../src/contract/schema.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("MCP refuses a declared dialect Forge cannot enforce", () => {
  const entry = candidate();
  const catalog = fakeCatalog([
    {
      ...entry,
      inputSchema: {
        ...entry.inputSchema,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    },
  ]);
  expect(() => createMcpHandlers(catalog).listTools()).toThrow(/dialect/i);
}, 30_000);

test("MCP refuses a ref cycle that makes no progress through the instance", () => {
  const catalog = fakeCatalog([
    {
      ...candidate(),
      inputSchema: { type: "object", not: { $ref: "#" } },
    },
  ]);
  expect(() => createMcpHandlers(catalog).listTools()).toThrow(
    /cycle|recursive/i,
  );
}, 30_000);

test("MCP keeps value-descending recursion local after wrapping the result", () => {
  const entry = candidate();
  const catalog = fakeCatalog([
    {
      ...entry,
      outputSchema: {
        type: "object",
        properties: { next: { $ref: "#" } },
        additionalProperties: false,
      },
    },
  ]);
  const schema = createMcpHandlers(catalog)
    .listTools()
    .find((tool) => tool.name === "sample_echo")?.outputSchema;
  const registry = new SchemaRegistry([schema!]);
  const envelope = { ok: true, status: "OK", op: entry.op, warnings: [] };
  expect(registry.validate("#", { ...envelope, result: { next: {} } })).toEqual(
    [],
  );
  expect(
    registry.validate("#", { ...envelope, result: { next: { wrong: true } } })
      .length,
  ).toBeGreaterThan(0);
}, 30_000);

test("MCP refuses deep schema composition", () => {
  let schema: SchemaObject = { type: "object" };
  for (let i = 0; i < 200; i++) schema = { allOf: [schema] };
  const catalog = fakeCatalog([{ ...candidate(), inputSchema: schema }]);
  expect(() => createMcpHandlers(catalog).listTools()).toThrow(
    /depth|limit|budget/i,
  );
}, 30_000);
