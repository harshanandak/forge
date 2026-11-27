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
  for (let i = 0; i < 19; i++) schema = { anyOf: [schema] };
  const registry = new SchemaRegistry([schema]);
  expect(registry.validate("#", {})[0]?.keyword).toBe("budget");
}, 30_000);

test("declaration tracking charges repeated reference keys before serialization", () => {
  const registry = (branches: number) =>
    new SchemaRegistry([
      {
        additionalProperties: {
          type: "string",
          allOf: Array.from({ length: branches }, () => ({
            $ref: "#/$defs/T",
          })),
        },
        $defs: { T: true },
      },
    ]);
  expect(registry(2).validate("#", { abc: 0 })[0]).toMatchObject({
    keyword: "type",
    pointer: "/abc",
  });
  expect(
    registry(2_000).validate("#", { ["a".repeat(262_000)]: 0 })[0]?.keyword,
  ).toBe("budget");
}, 30_000);

test("diagnostic and declaration work keeps an invalid field's problems", () => {
  const branches = Array<boolean>(2_048).fill(false);
  const registry = new SchemaRegistry([
    { properties: { field: { allOf: branches } } },
  ]);
  const problems = registry.validate("#", { field: 1 });
  expect(problems).toHaveLength(branches.length);
  expect(
    problems.every(
      (problem) => problem.pointer === "/field" && problem.keyword === "false",
    ),
  ).toBe(true);
}, 30_000);

test("diagnostics from rejected alternatives leave evaluation visits for the accepting branch", () => {
  const branches = Array<boolean>(2_048).fill(false);
  const registry = new SchemaRegistry([
    { properties: { field: { anyOf: [...branches, true] } } },
  ]);
  expect(registry.validate("#", { field: 1 })).toEqual([]);
}, 30_000);
