import { expect, setDefaultTimeout, test } from "bun:test";
import { validateWithSchema } from "../../../src/contract/schema.ts";
import { compatibleConfig } from "../../../src/core/config/compatible.ts";
import { formatProblem } from "../../../src/contract/input-error.ts";

setDefaultTimeout(30_000);

for (const keyword of ["oneOf", "anyOf"]) {
  test(`${keyword} preserves keys and typo suggestions declared by sibling alternatives`, () => {
    const argv = { type: "array", items: { type: "string" } };
    const branch = (properties: Record<string, unknown>) => ({
      type: "object",
      required: Object.keys(properties),
      properties,
      additionalProperties: false,
    });
    const schemas = [
      { [keyword]: [branch({ argv }), branch({ script: { type: "string" } })] },
      {
        [keyword]: [
          branch({ argv }),
          branch({ argv, report: { enum: ["json", "exit-code"] } }),
        ],
      },
    ];
    for (const [index, schema] of schemas.entries()) {
      const check = (value: unknown) => validateWithSchema(schema, value);
      for (const config of index === 0
        ? [{ argv: 42, script: "deploy" }]
        : [
            { argv: ["tool"], report: 42 },
            { argv: ["tool"], reporrt: "json" },
          ]) {
        const problems = check(config);
        const warnings: string[] = [];
        const result = compatibleConfig(
          "check",
          config,
          problems,
          (_name, paths) => warnings.push(...paths),
          check,
        );
        expect(result.problems.length).toBeGreaterThan(0);
        expect(result.problems).toEqual(problems);
        expect(result.config).toEqual(config);
        expect(warnings).toEqual([]);
        if ("reporrt" in config) {
          expect(
            result.problems.some(({ suggestion }) => suggestion === "report"),
          ).toBe(true);
          expect(
            result.problems
              .map((problem) =>
                formatProblem(problem, config, "blocks.check.config"),
              )
              .join("\n"),
          ).toContain("did you mean report?");
        }
      }
      const config = { argv: ["tool"], futureOption: true };
      const warnings: string[][] = [];
      const result = compatibleConfig<unknown>(
        "check",
        config,
        check(config),
        (_name, paths) => warnings.push([...paths]),
        check,
      );
      expect(result.problems).toEqual([]);
      expect(result.config).toEqual({ argv: ["tool"] });
      expect(warnings).toEqual([["blocks.check.config.futureOption"]]);
      expect(config.futureOption).toBe(true);
    }
  });

  test(`${keyword} protects nested keys declared through another reachable branch`, () => {
    const schema = {
      [keyword]: [{ $ref: "#/$defs/first" }, { $ref: "#/$defs/second" }],
      $defs: {
        first: {
          type: "object",
          properties: {
            command: {
              type: "object",
              properties: { argv: { type: "array" } },
              required: ["argv"],
              additionalProperties: false,
            },
          },
        },
        second: {
          type: "object",
          properties: {
            command: {
              type: "object",
              properties: { script: { type: "string" } },
              required: ["script"],
              additionalProperties: false,
            },
          },
        },
      },
    };
    const config = { command: { argv: 42, script: "deploy" } };
    const check = (value: unknown) => validateWithSchema(schema, value);
    const problems = check(config);
    const result = compatibleConfig(
      "check",
      config,
      problems,
      undefined,
      check,
    );
    expect(result.problems).toEqual(problems);
    expect(result.config).toEqual(config);
  });

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
