import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
} from "../../src/contract/schema.ts";

test("schema validation refuses when composition exhausts the work budget", () => {
  const $defs: Record<string, SchemaObject> = { leaf: { type: "object" } };
  let ref = "#/$defs/leaf";
  for (let i = 0; i < 18; i++) {
    $defs[`branch${i}`] = { allOf: [{ $ref: ref }, { $ref: ref }] };
    ref = `#/$defs/branch${i}`;
  }
  const registry = new SchemaRegistry([{ $defs, $ref: ref }]);
  const problems = registry.validate("#", {});
  expect(problems).toHaveLength(1);
  expect(problems[0]?.message).toMatch(/limit|budget/i);
}, 30_000);

test("schema validation budgets const, enum, and uniqueItems comparisons", () => {
  const nested = (): unknown => {
    let value: unknown = "value";
    for (let depth = 0; depth < 20; depth++) value = [value, value];
    return value;
  };
  const expected = nested();
  const actual = nested();
  for (const schema of [{ const: expected }, { enum: [expected] }]) {
    expect(new SchemaRegistry([schema]).validate("#", actual)[0]?.keyword).toBe(
      "budget",
    );
  }
  const registry = new SchemaRegistry([{ type: "array", uniqueItems: true }]);
  const scalars = Array.from({ length: 1500 }, (_, n) => n);
  expect(registry.validate("#", scalars)).toEqual([]);
  expect(registry.validate("#", [[1], [1]])[0]?.keyword).toBe("uniqueItems");
  const compounds = scalars.map((scalar) => [scalar]);
  expect(registry.validate("#", compounds)[0]?.keyword).toBe("budget");
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
