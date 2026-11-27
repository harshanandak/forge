import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
  type SchemaProblem,
} from "../../src/contract/schema.ts";

test("the registry refuses a declared dialect Forge cannot enforce", () => {
  expect(
    () =>
      new SchemaRegistry([
        { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      ]),
  ).toThrow(/dialect/i);
}, 30_000);

test("the validator refuses a ref cycle under negation without overflowing or passing", () => {
  const registry = new SchemaRegistry([{ type: "object", not: { $ref: "#" } }]);
  let problems: SchemaProblem[] = [];
  expect(() => {
    problems = registry.validate("#", {});
  }).not.toThrow();
  expect(problems[0]).toMatchObject({ keyword: "budget" });
}, 30_000);

test("value-descending recursion validates within the depth budget and refuses beyond it", () => {
  const registry = new SchemaRegistry([
    {
      type: "object",
      properties: { next: { $ref: "#" } },
      additionalProperties: false,
    },
  ]);
  expect(registry.validate("#", { next: {} })).toEqual([]);
  expect(
    registry.validate("#", { next: { wrong: true } }).length,
  ).toBeGreaterThan(0);
  let value: object = {};
  for (let i = 0; i < 140; i++) value = { next: value };
  expect(registry.validate("#", value)[0]).toMatchObject({ keyword: "budget" });
}, 30_000);

test("the registry refuses deep schema composition", () => {
  let schema: SchemaObject = { type: "object" };
  for (let i = 0; i < 200; i++) schema = { allOf: [schema] };
  expect(() => new SchemaRegistry([schema])).toThrow(/depth|limit|budget/i);
}, 30_000);

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

test("schema validation bounds diagnostics with shared alternatives", () => {
  let schema: SchemaObject = { type: "string" };
  for (let i = 0; i < 14; i++) schema = { anyOf: [schema] };
  const registry = new SchemaRegistry([schema]);
  expect(registry.validate("#", {})[0]?.keyword).toBe("budget");
}, 30_000);
