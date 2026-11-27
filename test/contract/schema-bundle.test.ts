import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { expect, setDefaultTimeout, test } from "bun:test";
import { bundleSchema } from "../../src/contract/schema-bundle.ts";
import {
  SCHEMA_DIALECT,
  SchemaRegistry,
  withDateTimeAssertion,
  type SchemaObject,
} from "../../src/contract/schema.ts";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";

setDefaultTimeout(30_000);
const ID = "https://example.org/tools/tool.json";
const registryOf = (schema: object, ...more: SchemaObject[]) =>
  new SchemaRegistry([{ $id: ID, ...schema }, ...more]);
const bundle = (schema: object, reference = ID) =>
  bundleSchema(registryOf(schema), reference);
const accepts = (schema: object, value: unknown) =>
  new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const forgeAccepts = (registry: SchemaRegistry, value: unknown) =>
  registry.validate(ID, value).length === 0;
const nest = (levels: number, inner: object): object =>
  levels === 0 ? inner : { allOf: [nest(levels - 1, inner)] };
const chain = (order: number[]) => ({
  type: "object",
  $defs: Object.fromEntries(
    Array.from({ length: 71 }, (_, n) => [
      `D${n}`,
      n === 0 ? { type: "string" } : { $ref: `#/$defs/D${n - 1}` },
    ]),
  ),
  properties: Object.fromEntries(
    order.map((n) => [`p${n}`, { $ref: `#/$defs/D${n}` }]),
  ),
});
const forward = Array.from({ length: 71 }, (_, n) => n);

test("the same target is bundled once under every spelling and a trailing # stays in the pointer", () => {
  const schema = {
    type: "object",
    $defs: { "Value#": { const: "strict" }, Value: { type: "string" } },
    properties: {
      a: { $ref: "#/$defs/Value#" },
      b: { $ref: "#/$defs/Value%23" },
      c: { $ref: "#/$defs/Value" },
      d: { $ref: `${ID}#/$defs/Value` },
    },
  };
  const registry = registryOf(schema);
  const out = bundleSchema(registry, ID);
  const props = out.properties as Record<string, { $ref: string }>;
  expect(props.a!.$ref).toBe(props.b!.$ref);
  expect(props.c!.$ref).toBe(props.d!.$ref);
  expect(props.a!.$ref).not.toBe(props.c!.$ref);
  expect(Object.keys(out.$defs as object)).toHaveLength(2);
  for (const [value, ok] of [
    [{ a: "strict", c: "x" }, true],
    [{ a: "loose" }, false],
    [{ b: "loose" }, false],
    [{ c: 1 }, false],
  ] as const) {
    expect(forgeAccepts(registry, value)).toBe(ok);
    expect(accepts(out, value)).toBe(ok);
  }
});

test("distinct targets with the same label in different documents never collide", () => {
  const doc = (dir: string, type: string): SchemaObject => ({
    $id: `https://example.org/${dir}/common.json`,
    $defs: { Item: { type } },
  });
  const registry = registryOf(
    {
      type: "object",
      properties: {
        x: { $ref: "../a/common.json#/$defs/Item" },
        y: { $ref: "https://example.org/b/common.json#/$defs/Item" },
      },
    },
    doc("a", "string"),
    doc("b", "integer"),
  );
  const out = bundleSchema(registry, ID);
  const props = out.properties as Record<string, { $ref: string }>;
  expect(props.x!.$ref).not.toBe(props.y!.$ref);
  expect(Object.keys(out.$defs as object)).toHaveLength(2);
  expect(JSON.stringify(out)).not.toContain('"$id"');
  for (const [value, ok] of [
    [{ x: "s", y: 1 }, true],
    [{ x: 1 }, false],
    [{ y: "s" }, false],
  ] as const) {
    expect(forgeAccepts(registry, value)).toBe(ok);
    expect(accepts(out, value)).toBe(ok);
  }
});

test("a reference chain over the depth limit is refused in either insertion order", () => {
  for (const order of [forward, [...forward].reverse()])
    expect(() => bundle(chain(order))).toThrow(
      "Schema depth limit exceeded (64)",
    );
  expect(() => bundle(chain(forward.slice(0, 60)))).not.toThrow();
});

test("composition fragments under the limit that join across references over it are refused", () => {
  const joined = (levels: number) => ({
    type: "object",
    $defs: {
      A: nest(levels, { $ref: "#/$defs/B" }),
      B: nest(levels, { type: "string" }),
    },
    properties: { v: { $ref: "#/$defs/A" } },
  });
  expect(() => bundle(joined(40))).toThrow("Schema depth limit exceeded (64)");
  const out = bundle(joined(20));
  expect(accepts(out, { v: "s" })).toBe(true);
  expect(accepts(out, { v: 1 })).toBe(false);
});

test("literal work counts toward the budget and small extensions are kept", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 20_001 }, (_, n) => [`x-note-${n}`, 0]),
  );
  expect(() => bundle({ type: "object", ...wide })).toThrow(
    "Schema work budget exceeded (20000 nodes)",
  );
  expect(bundle({ type: "object", "x-note": { a: [1, "b"] } })).toEqual({
    $schema: SCHEMA_DIALECT,
    type: "object",
    "x-note": { a: [1, "b"] },
  });
});

test("a $ref inside const, default or an annotation is copied and never followed", () => {
  const schema = {
    type: "object",
    default: { $ref: "#/$defs/missing" },
    "x-meta": { $ref: "https://example.org/nowhere.json" },
    properties: { a: { const: { $ref: "#/nope" } } },
  };
  const out = bundle(schema);
  expect(out).toEqual({ $schema: SCHEMA_DIALECT, ...schema });
  expect(out.$defs).toBeUndefined();
});

test("bundled definitions keep format and annotations, so the date-time step reaches them", () => {
  const common = SCHEMA_DOCUMENTS.find((doc) =>
    String(doc.$id).endsWith("/schemas/common.json"),
  )!;
  const timestamp = (common.$defs as Record<string, object>).Timestamp!;
  const registry = new SchemaRegistry([
    ...SCHEMA_DOCUMENTS,
    {
      $id: ID,
      type: "object",
      properties: { at: { $ref: `${String(common.$id)}#/$defs/Timestamp` } },
    },
  ]);
  const out = bundleSchema(registry, ID);
  expect((out.$defs as Record<string, object>).Timestamp).toEqual(timestamp);
  const asserted = withDateTimeAssertion(out);
  for (const [at, ok] of [
    ["2016-12-31T23:59:59Z", true],
    ["2016-12-31T23:59:60Z", false],
  ] as const) {
    expect(forgeAccepts(registry, { at })).toBe(ok);
    expect(accepts(asserted, { at })).toBe(ok);
  }
});

test("a reference cycle that never descends is refused and a descending one is bundled", () => {
  const cycle = {
    type: "object",
    $defs: {
      A: { allOf: [{ $ref: "#/$defs/B" }] },
      B: { $ref: "#/$defs/A" },
    },
    properties: { v: { $ref: "#/$defs/A" } },
  };
  expect(() => bundle(cycle)).toThrow(/cycle at .* does not descend/);
  const tree = {
    $defs: {
      Node: {
        type: "object",
        properties: { next: { $ref: "#/$defs/Node" } },
        additionalProperties: false,
      },
    },
    $ref: "#/$defs/Node",
  };
  const out = bundle(tree);
  expect(accepts(out, { next: { next: {} } })).toBe(true);
  expect(accepts(out, { next: { next: 1 } })).toBe(false);
});

test("refusal is deterministic and leaves the source schema untouched", () => {
  for (const [schema, reference, message] of [
    [chain(forward), ID, "Schema depth limit exceeded (64)"],
    [{ type: "object" }, `${ID}#/$defs/missing`, "does not resolve"],
  ] as const) {
    const registry = registryOf(schema);
    const before = structuredClone(registry.lookup(ID));
    const errors = [0, 1].map(() => {
      try {
        bundleSchema(registry, reference);
        return "bundled";
      } catch (error) {
        return String(error);
      }
    });
    expect(errors[0]).toContain(message);
    expect(errors[1]).toBe(errors[0]);
    expect(registry.lookup(ID)).toEqual(before);
  }
});

test("a boolean target becomes an object root", () => {
  expect(bundle({ $defs: { F: false } }, `${ID}#/$defs/F`)).toEqual({
    $schema: SCHEMA_DIALECT,
    allOf: [false],
  });
});

test("every shipped schema document and definition bundles within the budget", () => {
  const registry = new SchemaRegistry(SCHEMA_DOCUMENTS);
  for (const doc of SCHEMA_DOCUMENTS)
    for (const name of [undefined, ...Object.keys(doc.$defs ?? {})]) {
      const reference =
        name === undefined
          ? String(doc.$id)
          : `${String(doc.$id)}#/$defs/${name}`;
      expect(bundleSchema(registry, reference).$schema).toBe(SCHEMA_DIALECT);
    }
});
