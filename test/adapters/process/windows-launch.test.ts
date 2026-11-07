import { expect, test } from "bun:test";
import {
  buildWindowsCommandLine,
  buildWindowsEnvironmentBlock,
  quoteWindowsArgument,
} from "../../../src/adapters/process/windows-launch.ts";

// The expected pairs come from the table in libuv's src/win/process.c (quote_cmd_arg).
test("argument quoting matches libuv", () => {
  const table: readonly (readonly [string, string])[] = [
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ["hello\\world", "hello\\world"],
    ["hello\\\\world", "hello\\\\world"],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ["hello world\\", '"hello world\\\\"'],
    ["", '""'],
    ["plain", "plain"],
    ["two words", '"two words"'],
  ];
  for (const [input, expected] of table)
    expect(quoteWindowsArgument(input), input).toBe(expected);
}, 5000);

test("the command line quotes each part, or copies it verbatim for cmd.exe", () => {
  const plan = { file: "C:\\x y\\a.exe", args: ["b c", ""] };
  expect(
    buildWindowsCommandLine({ ...plan, windowsVerbatimArguments: false }),
  ).toBe('"C:\\x y\\a.exe" "b c" ""');
  expect(
    buildWindowsCommandLine({ ...plan, windowsVerbatimArguments: true }),
  ).toBe("C:\\x y\\a.exe b c ");
}, 5000);

function codeOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return "no error";
}

test("environment entries that would be read differently are refused", () => {
  const nul = String.fromCharCode(0);
  const refused = [
    { "": "value" },
    { "A=B": "c" },
    { [`A${nul}B`]: "c" },
    { A: `b${nul}c` },
  ].map((env) => codeOf(() => buildWindowsEnvironmentBlock(env, {})));
  expect(refused).toEqual(Array(4).fill("INVALID_OPTIONS"));
}, 5000);

test("names that differ only by case keep the first in sorted order, like Node", () => {
  const nul = String.fromCharCode(0);
  const block = buildWindowsEnvironmentBlock(
    { Path: "lower", PATH: "upper", foo: "a", FOO: "b" },
    {},
  );
  expect(block.toString("utf16le").split(nul)).toEqual([
    "FOO=b",
    "PATH=upper",
    "",
    "",
  ]);
}, 5000);

test("the environment block is sorted, UTF-16 and gets only libuv's required variables", () => {
  const nul = String.fromCharCode(0);
  const block = buildWindowsEnvironmentBlock(
    { zeta: "1", Alpha: "2", SystemRoot: "C:\\W" },
    { path: "P", Unrelated: "no" },
  );
  expect(block.toString("utf16le").split(nul)).toEqual([
    "Alpha=2",
    "PATH=P",
    "SystemRoot=C:\\W",
    "zeta=1",
    "",
    "",
  ]);
  // An empty block still ends with two NULs, which Windows requires.
  expect(buildWindowsEnvironmentBlock({}, {}).toString("utf16le")).toBe(
    nul + nul,
  );
}, 5000);
