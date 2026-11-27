import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../src/contract/schema.ts";

test("detailed diagnostics charge value rendering before repeated formatting", () => {
  const registry = new SchemaRegistry([
    { allOf: Array.from({ length: 80 }, () => ({ type: "number" })) },
  ]);
  expect(registry.validate("#", "x".repeat(120_000), true)[0]?.keyword).toBe(
    "budget",
  );
}, 30_000);

test("repeated string assertions use the work budget", () => {
  const registry = new SchemaRegistry([
    { allOf: Array.from({ length: 80 }, () => ({ minLength: 1 })) },
  ]);
  expect(registry.validate("#", "x".repeat(120_000))[0]?.keyword).toBe(
    "budget",
  );
  const unicode = new SchemaRegistry([{ minLength: 1, maxLength: 1 }]);
  expect(unicode.validate("#", "\u{1F600}")).toEqual([]);
}, 30_000);

test("name suggestions respect the shared work budget", () => {
  const properties = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `${"a".repeat(512)}${index}`,
      true,
    ]),
  );
  const registry = new SchemaRegistry([
    { properties, additionalProperties: false },
  ]);
  expect(
    registry.validate("#", { ["b".repeat(512)]: 0 }, true)[0]?.keyword,
  ).toBe("budget");
}, 30_000);

test("schema validation bounds diagnostics with shared alternatives", () => {
  let schema: SchemaObject = { type: "string" };
  for (let i = 0; i < 14; i++) schema = { anyOf: [schema] };
  const registry = new SchemaRegistry([schema]);
  expect(registry.validate("#", {})[0]?.keyword).toBe("budget");
}, 30_000);
