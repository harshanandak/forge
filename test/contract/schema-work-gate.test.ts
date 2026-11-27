import { expect, test } from "bun:test";
import { SchemaRegistry } from "../../src/contract/schema.ts";

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
  expect(registry.validate("#", "😀")).toEqual([]);
}, 30_000);

test("compound uniqueness charges the key work even for unequal objects", () => {
  const registry = new SchemaRegistry([{ uniqueItems: true }]);
  const objects = Array.from({ length: 230 }, (_, index) =>
    Object.fromEntries(
      Array.from({ length: 64 }, (_, key) => [`field-${index}-${key}`, 1]),
    ),
  );
  expect(registry.validate("#", objects)[0]?.keyword).toBe("budget");
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
