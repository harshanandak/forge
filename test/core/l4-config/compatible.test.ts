import { expect, setDefaultTimeout, test } from "bun:test";
import { validateWithSchema } from "../../../src/contract/schema.ts";
import { compatibleConfig } from "../../../src/core/config/compatible.ts";

setDefaultTimeout(30_000);

for (const keyword of ["oneOf", "anyOf"]) {
  test(`${keyword} compatibility revalidates the whole schema and preserves refusals`, () => {
    const schema = {
      type: "object",
      properties: {
        first: { $ref: "#/$defs/command" },
        second: { $ref: "#/$defs/command" },
      },
      additionalProperties: false,
      $defs: {
        command: {
          [keyword]: [
            { type: "string" },
            {
              type: "object",
              required: ["argv"],
              additionalProperties: false,
              properties: {
                argv: { type: "array", items: { type: "string" } },
              },
            },
          ],
        },
      },
    };
    const check = (value: unknown) => validateWithSchema(schema, value);
    const original = {
      first: { argv: ["tool"], futureOption: true },
      second: { argv: ["tool"], futureOption: false },
    };
    const paths: string[] = [];
    const result = compatibleConfig<unknown>(
      "check",
      original,
      check(original),
      (_name, dropped) => paths.push(...dropped),
      check,
    );
    expect(result.problems).toEqual([]);
    expect(result.config).toEqual({
      first: { argv: ["tool"] },
      second: { argv: ["tool"] },
    });
    expect(paths.sort()).toEqual([
      "blocks.check.config.first.futureOption",
      "blocks.check.config.second.futureOption",
    ]);
    expect(original.first.futureOption).toBe(true);
    expect(original.second.futureOption).toBe(false);

    for (const first of [
      { argv: 42, futureOption: true },
      { argv: ["tool"], argvv: [] },
      { argv: ["tool"], ARGV: [] },
      { futureOption: true },
    ]) {
      const config = { first };
      const problems = check(config);
      const warnings: string[] = [];
      const refused = compatibleConfig(
        "check",
        config,
        problems,
        (_name, dropped) => warnings.push(...dropped),
        check,
      );
      expect(refused.problems).toEqual(problems);
      expect(warnings).toEqual([]);
      expect(refused.config).toEqual(config);
    }
  });
}

test("sanitizing an object alternative cannot make an ambiguous oneOf valid", () => {
  const schema = {
    oneOf: [
      {
        type: "object",
        properties: { labels: { type: "array" } },
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { mode: { type: "string" } },
        additionalProperties: false,
      },
    ],
  };
  const config = { futureOption: true };
  const check = (value: unknown) => validateWithSchema(schema, value);
  const problems = check(config);
  const result = compatibleConfig("work", config, problems, undefined, check);
  expect(result.problems).toEqual(problems);
  expect(config).toEqual({ futureOption: true });
});
