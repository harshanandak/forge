import { expect, test } from "bun:test";
import {
  SchemaRegistry,
  type SchemaObject,
  type SchemaProblem,
} from "../../src/contract/schema.ts";

const annotation = {
  default: {
    $schema: "http://json-schema.org/draft-07/schema#",
    patternProperties: { "^x$": false },
  },
};

test("registration refuses a reference into annotation data", () => {
  expect(
    () => new SchemaRegistry([{ ...annotation, $ref: "#/default" }]),
  ).toThrow(/does not resolve/);
}, 30_000);

test("validation entrypoints refuse annotation data and accept checked subschemas", () => {
  const registry = new SchemaRegistry([
    { ...annotation, $defs: { value: { type: "integer" } } },
  ]);
  expect(() => registry.validator("#/default")).toThrow(/no schema/);
  expect(() => registry.validate("#/default", { x: 1 })).toThrow(/no schema/);
  expect(registry.validate("#/$defs/value", 1)).toEqual([]);
}, 30_000);

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
