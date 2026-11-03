import { expect, test } from "bun:test";
import { renderExample } from "../../src/contract/example.ts";
import { exampleShells, scalarExamples } from "./fixtures/scalar-examples.ts";

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
