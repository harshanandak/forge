import { expect, test } from "bun:test";
import { ProcessSpawnError } from "../../../src/adapters/process/errors.ts";
import { planSpawn } from "../../../src/adapters/process/plan.ts";

const env = { SystemRoot: "C:\\Windows" };

test("a program starts directly with its argument array, on every platform", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const plan = planSpawn("/x/tool", ["a b", "c&d"], env, platform);
    expect(plan).toEqual({
      file: "/x/tool",
      args: ["a b", "c&d"],
      windowsVerbatimArguments: false,
    });
  }
  expect(
    planSpawn("C:\\x\\tool.exe", ["a"], env, "win32").windowsVerbatimArguments,
  ).toBe(false);
}, 30_000);

test("a windows .cmd shim goes through cmd.exe with every argument quoted (old issue c4393667)", () => {
  const plan = planSpawn(
    "C:\\Program Files\\nodejs\\npm.cmd",
    ["install", "--save-dev", "left pad", "a&b"],
    env,
    "win32",
  );
  expect(plan.file).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(plan.windowsVerbatimArguments).toBe(true);
  expect(plan.args).toEqual([
    "/d",
    "/v:off",
    "/s",
    "/c",
    '""C:\\Program Files\\nodejs\\npm.cmd" "install" "--save-dev" "left pad" "a&b""',
  ]);
}, 30_000);

test("ComSpec from the child environment names the command interpreter", () => {
  const plan = planSpawn(
    "C:\\x\\t.bat",
    [],
    { ComSpec: "D:\\sys\\cmd.exe" },
    "win32",
  );
  expect(plan.file).toBe("D:\\sys\\cmd.exe");
}, 30_000);

test("a trailing backslash is doubled so it cannot escape the closing quote; empty arguments survive", () => {
  const plan = planSpawn("C:\\x\\t.cmd", ["dir\\", "", "a\\b"], env, "win32");
  expect(plan.args.at(-1)).toBe('""C:\\x\\t.cmd" "dir\\\\" "" "a\\b""');
}, 30_000);

test("arguments cmd.exe would reinterpret are refused, never escaped", () => {
  for (const bad of ["%PATH%", 'say "hi"', "a\nb", "a\rb"]) {
    let failure: unknown;
    try {
      planSpawn("C:\\x\\t.cmd", [bad], env, "win32");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProcessSpawnError);
    expect((failure as ProcessSpawnError).code).toBe("UNSAFE_ARGUMENT");
  }
  // The same text is plain data for a program that does not go through cmd.exe.
  expect(() =>
    planSpawn("C:\\x\\t.exe", ["%PATH%", 'a"b'], env, "win32"),
  ).not.toThrow();
  expect(() =>
    planSpawn("/x/t", ["%PATH%", 'a"b'], env, "linux"),
  ).not.toThrow();
}, 30_000);

test("a NUL character or a non-string argument is refused on every platform", () => {
  for (const platform of ["win32", "linux"] as const) {
    expect(() => planSpawn("/x/t", ["a\0b"], env, platform)).toThrow(
      ProcessSpawnError,
    );
    expect(() =>
      planSpawn("/x/t", [42 as unknown as string], env, platform),
    ).toThrow(ProcessSpawnError);
  }
}, 30_000);

test("metacharacters inside a batch argument stay inside quotes", () => {
  const plan = planSpawn(
    "C:\\x\\t.cmd",
    ["& calc", "| more", "> out.txt", "^x", "(y)"],
    env,
    "win32",
  );
  expect(plan.args.at(-1)).toBe(
    '""C:\\x\\t.cmd" "& calc" "| more" "> out.txt" "^x" "(y)""',
  );
}, 30_000);
