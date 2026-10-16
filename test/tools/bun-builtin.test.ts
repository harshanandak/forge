import { expect, test } from "bun:test";
import {
  type BuiltinName,
  bunRunner,
  helpListsBuiltin,
  main,
  missingMessage,
  type Runner,
} from "../../tools/bun-builtin.ts";

const STABLE_HELP = `Commands:
  run       ./my-script.ts       Execute a file with Bun
            lint                 Run a package.json script
  test                           Run unit tests with Bun
  check                          Type check a TypeScript project
`;
const CANARY_HELP = `${STABLE_HELP}  lint                           Lint JavaScript and TypeScript, like ESLint
  fmt                            Format JavaScript and TypeScript, like Prettier
`;

function fake(present: readonly BuiltinName[]): Runner & {
  ran: [BuiltinName, readonly string[]][];
} {
  const ran: [BuiltinName, readonly string[]][] = [];
  return {
    ran,
    has: (name) => present.includes(name),
    run(name, args) {
      ran.push([name, args]);
      return 7;
    },
  };
}

test("help text lists a built-in only as a top-level command", () => {
  expect(helpListsBuiltin(STABLE_HELP, "lint")).toBe(false);
  expect(helpListsBuiltin(STABLE_HELP, "fmt")).toBe(false);
  expect(helpListsBuiltin(CANARY_HELP, "lint")).toBe(true);
  expect(helpListsBuiltin(CANARY_HELP, "fmt")).toBe(true);
}, 30_000);

test("without the built-in it exits non-zero with the upgrade message and never runs it", () => {
  const runner = fake([]);
  const lines: string[] = [];
  const started = performance.now();
  expect(main(["lint", "--type-aware"], runner, (l) => lines.push(l))).toBe(1);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(lines).toEqual([
    "bun lint needs a Bun build with the built-in linter (currently canary: bun upgrade --canary)",
  ]);
  expect(runner.ran).toEqual([]);
  const fmtLines: string[] = [];
  expect(main(["fmt"], runner, (l) => fmtLines.push(l))).toBe(1);
  expect(fmtLines).toEqual([missingMessage("fmt")]);
  expect(fmtLines[0]).toContain("built-in formatter");
}, 30_000);

test("with the built-in it delegates the arguments as an array and returns its exit code", () => {
  const runner = fake(["lint", "fmt"]);
  const lines: string[] = [];
  expect(
    main(["lint", "--type-aware", "--max-warnings", "0"], runner, (l) =>
      lines.push(l),
    ),
  ).toBe(7);
  expect(main(["fmt", "--check"], runner, (l) => lines.push(l))).toBe(7);
  expect(runner.ran).toEqual([
    ["lint", ["--type-aware", "--max-warnings", "0"]],
    ["fmt", ["--check"]],
  ]);
  expect(lines).toEqual([]);
}, 30_000);

test("an unknown or missing built-in name is a usage error", () => {
  const runner = fake(["lint", "fmt"]);
  const lines: string[] = [];
  expect(main(["test"], runner, (l) => lines.push(l))).toBe(2);
  expect(main(["constructor"], runner, (l) => lines.push(l))).toBe(2);
  expect(main([], runner, (l) => lines.push(l))).toBe(2);
  expect(runner.ran).toEqual([]);
  expect(lines).toHaveLength(3);
}, 30_000);

test("the real detector answers from `bun --help` without hanging", () => {
  const started = performance.now();
  expect(typeof bunRunner.has("lint")).toBe("boolean");
  expect(performance.now() - started).toBeLessThan(10_000);
}, 30_000);
