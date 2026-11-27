import { expect, test } from "bun:test";
import { SchemaRegistry } from "../../src/contract/schema.ts";

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

test("repeated string comparisons spend from the shared budget", () => {
  const expected = "x".repeat(120_000);
  const registry = new SchemaRegistry([
    { allOf: Array.from({ length: 80 }, () => ({ const: expected })) },
  ]);
  expect(registry.validate("#", expected)[0]?.keyword).toBe("budget");
  const example = new SchemaRegistry([{ const: "same" }]);
  expect(example.validate("#", "same")).toEqual([]);
  expect(example.validate("#", "other")[0]?.keyword).toBe("const");
}, 30_000);
