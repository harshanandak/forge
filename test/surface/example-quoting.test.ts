import { expect, test } from "bun:test";
import { renderExample } from "../../src/contract/example.ts";
import {
  authoredInputs,
  exampleShells,
  scalarExamples,
} from "./fixtures/scalar-examples.ts";

for (const { name, value, quoted } of scalarExamples) {
  test(`scalar example preserves ${name} in each shell`, () => {
    const commands = quoted.map(
      (argument) => `forge sample echo --value ${argument}`,
    );
    const expected = commands.every((command) => command === commands[0])
      ? commands[0]!
      : commands
          .map((command, index) => `${exampleShells[index]}: ${command}`)
          .join("\n    ");
    expect(
      renderExample(
        "sample.echo",
        { title: "Echo", summary: "Echo.", examples: [{ input: { value } }] },
        { type: "object", properties: { value: { type: "string" } } },
      ),
    ).toBe(expected);
  }, 30_000);
}

test("unchanged safe scalar examples collapse to one line", () => {
  expect(
    renderExample(
      "sample.echo",
      {
        title: "Echo",
        summary: "Echo.",
        examples: [{ input: { value: "hello" } }],
      },
      { type: "object", properties: { value: { type: "string" } } },
    ),
  ).toBe("forge sample echo --value hello");
}, 30_000);

for (const { name, input, quoted } of authoredInputs) {
  test(`authored ${name} input renders JSON in each shell`, () => {
    const commands = quoted.map(
      (argument) => `forge sample run --input ${argument}`,
    );
    const expected = commands.every((command) => command === commands[0])
      ? commands[0]!
      : commands
          .map((command, index) => `${exampleShells[index]}: ${command}`)
          .join("\n    ");
    expect(
      renderExample(
        "sample.run",
        { title: "Run", summary: "Run.", examples: [{ input }] },
        {
          type:
            input === null
              ? "null"
              : Array.isArray(input)
                ? "array"
                : typeof input,
        },
      ),
    ).toBe(expected);
  }, 30_000);
}

test("empty object and missing examples keep their existing fallback", () => {
  for (const examples of [undefined, [{ input: {} }]]) {
    const docs = {
      title: "Run",
      summary: "Run.",
      ...(examples && { examples }),
    };
    expect(renderExample("sample.run", docs, { type: "object" })).toBe(
      "forge sample run",
    );
    expect(
      renderExample("sample.run", docs, {
        type: "object",
        required: ["value"],
      }),
    ).toBe("forge sample run --help --json");
  }
}, 30_000);

test("explicit commands override authored input and retain noun substitution", () => {
  expect(
    renderExample(
      "sample.run",
      {
        title: "Run",
        summary: "Run.",
        examples: [
          { input: "it's ready", command: "forge original run --custom first" },
          { input: false },
          { input: [], command: "forge original run --custom second" },
        ],
      },
      { type: "string" },
    ),
  ).toBe(
    "forge sample run --custom first\n    forge sample run --custom second",
  );
}, 30_000);
