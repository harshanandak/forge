import { expect, test } from "bun:test";
import { SCHEMA_DOCUMENTS } from "../../src/generated/schemas.ts";
import { markBuildChecked, SchemaRegistry } from "../../src/contract/schema.ts";

test("a document the build checked is not walked again, and an unchecked one still is", () => {
  const broken = { $id: "https://x.invalid/a.json", type: "nonsense" };
  expect(() => new SchemaRegistry([{ ...broken }])).toThrow(/type must name/);
  expect(
    () => new SchemaRegistry(markBuildChecked([{ ...broken }])),
  ).not.toThrow();
}, 5000);

test("a document beside the generated schema list is still checked", () => {
  const inner = { $id: "https://x.invalid/b.json", type: "nonsense" };
  expect(() => new SchemaRegistry([...SCHEMA_DOCUMENTS, inner])).toThrow(
    /type must name/,
  );
  expect(() => new SchemaRegistry([...SCHEMA_DOCUMENTS])).not.toThrow();
}, 5000);

test("a repeated reference resolves and validates the same way", () => {
  const registry = new SchemaRegistry(
    markBuildChecked([
      {
        $id: "https://x.invalid/c.json",
        type: "object",
        properties: { n: { $ref: "#/$defs/N" } },
        $defs: { N: { type: "integer", minimum: 1 } },
      },
    ]),
  );
  const uri = "https://x.invalid/c.json";
  for (let round = 0; round < 3; round += 1) {
    expect(registry.resolve("#/$defs/N", uri)).toBe(`${uri}#/$defs/N`);
    expect(registry.validate(uri, { n: 2 })).toEqual([]);
    expect(registry.validate(uri, { n: 0 }).length).toBe(1);
  }
}, 5000);
