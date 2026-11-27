import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("MCP publishes local, external and escaped refs without weakening any constraint", () => {
  const common =
    "https://raw.githubusercontent.com/harshanandak/forge/main/schemas/common.json";
  const original: SchemaObject = {
    $id: "https://example.invalid/input.json",
    type: "object",
    $defs: {
      Digest: { type: "string", maxLength: 3 },
      "a/b~c": { type: "integer", minimum: 2 },
    },
    properties: {
      local: { $ref: "#/$defs/Digest", minLength: 2 },
      external: { $ref: `${common}#/$defs/Digest` },
      escaped: { $ref: "#/$defs/a~1b~0c" },
      conflict: { $ref: "#/$defs/Digest", type: "integer" },
    },
    additionalProperties: false,
  };
  const tool = createMcpHandlers(
    fakeCatalog([{ ...candidate(), inputSchema: original }]),
  )
    .listTools()
    .find((entry) => entry.name === "sample_echo")!;
  const id = "https://published.invalid/input.json";
  let published: SchemaRegistry | undefined;
  expect(() => {
    published = new SchemaRegistry([{ ...tool.inputSchema, $id: id }]);
  }).not.toThrow();
  const ajv = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  const reference = new SchemaRegistry([...SCHEMA_DOCUMENTS, original]);
  const digest = `sha256:${"0".repeat(64)}`;
  const values = [
    { local: "ab" },
    { local: "a" },
    { local: "abcd" },
    { external: digest },
    { external: "abc" },
    { escaped: 2 },
    { escaped: 1 },
    { escaped: "x" },
    { conflict: 1 },
    { conflict: "ab" },
    { extra: 1 },
  ];
  const verdicts = values.map((value) => ({
    value,
    original: reference.validate(original.$id as string, value).length === 0,
    published: published?.validate(id, value).length === 0,
    ajv: ajv(value).valid,
  }));
  expect(verdicts.filter((entry) => entry.original).length).toBe(3);
  for (const entry of verdicts) {
    expect(entry.published, JSON.stringify(entry.value)).toBe(entry.original);
    expect(entry.ajv, JSON.stringify(entry.value)).toBe(entry.original);
  }
}, 30_000);

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
