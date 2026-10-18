import { expect, test } from "bun:test";
import { join } from "node:path";
import { createPackageManagerPort } from "../../../src/adapters/package-manager/index.ts";
import { createMemoryFiles } from "../../../src/blocks/project/index.ts";
import { fakeProcess } from "../process/fake-process.ts";

const fixtures = join(import.meta.dirname, "../../project/fixtures");
const repo = (name: string): string => join(fixtures, name, "repo");
const options = { env: { PATH: "/bin" }, maxOutputBytes: 1000 };

function adapter(known: string[], tree?: Record<string, string>) {
  const process = fakeProcess(known, () => ({ stdout: "ran" }));
  const port = createPackageManagerPort({
    ...options,
    process,
    ...(tree === undefined ? {} : { files: () => createMemoryFiles(tree) }),
  });
  return { port, process };
}

test("detect reports the user's manager from their lockfile, with the evidence file", async () => {
  const { port } = adapter([]);
  expect(await port.detect(repo("npm-vitest"))).toMatchObject({
    kind: "detected",
    name: "npm",
    evidence: [
      {
        key: "/blocks/project/detected/node/packageManager",
        origin: { file: "package-lock.json" },
      },
    ],
  });
  const declared = await port.detect(repo("pnpm-jest-workspace"));
  expect(declared).toMatchObject({
    kind: "detected",
    name: "pnpm",
    version: "9.12.1",
  });
  expect(await port.detect(repo("bun-app"))).toMatchObject({ name: "bun" });
  expect(await port.detect(repo("yarn-hooks-adr"))).toMatchObject({
    name: "yarn",
  });
}, 30_000);

test("detect is Unavailable, with a remedy, when nothing says which manager the project uses", async () => {
  const { port } = adapter([]);
  const conflict = await port.detect(repo("node-conflict"));
  expect(conflict).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("package-lock.json") as string,
    remedy: expect.stringContaining("packageManager") as string,
  });
  expect(await port.detect(repo("go-module"))).toMatchObject({
    kind: "unavailable",
  });
  const bare = adapter([], { "package.json": "{}" });
  expect(await bare.port.detect("/anywhere")).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("no lockfile") as string,
  });
}, 30_000);

test("scripts returns what package.json declares and nothing else", async () => {
  const { port } = adapter([]);
  expect(await port.scripts(repo("npm-vitest"))).toEqual({
    test: "vitest run",
    lint: "eslint .",
    build: "tsc -p .",
    "type-check": "tsc --noEmit",
  });
  expect(await port.scripts(repo("go-module"))).toEqual({});
}, 30_000);

test("runScript runs one declared script with the detected manager, as an argument array", async () => {
  const { port, process } = adapter(["npm"], {
    "package.json": JSON.stringify({
      scripts: { test: "x", "test:unit": "y" },
    }),
    "package-lock.json": "{}",
  });
  const result = await port.runScript(
    "/proj",
    "test:unit",
    ["--grep", "a b"],
    5000,
  );
  expect(result).toMatchObject({ exitCode: 0, stdout: "ran" });
  expect(process.runs).toHaveLength(1);
  expect(process.runs[0]).toMatchObject({
    executable: "/fake/bin/npm",
    args: ["run", "test:unit", "--", "--grep", "a b"],
    options: { cwd: "/proj", timeoutMs: 5000, maxOutputBytes: 1000 },
  });
}, 30_000);

test("each manager gets its own argument shape", async () => {
  for (const [lock, name, expected] of [
    ["pnpm-lock.yaml", "pnpm", ["run", "build", "--watch"]],
    ["yarn.lock", "yarn", ["run", "build", "--watch"]],
    ["bun.lock", "bun", ["run", "build", "--watch"]],
  ] as const) {
    const { port, process } = adapter([name], {
      "package.json": JSON.stringify({ scripts: { build: "x" } }),
      [lock]: "",
    });
    await port.runScript("/p", "build", ["--watch"], 1000);
    expect(process.runs[0]?.args).toEqual(expected);
    expect(process.runs[0]?.executable).toBe(`/fake/bin/${name}`);
  }
}, 30_000);

test("a script the project does not declare is never run, and the declared ones are listed", async () => {
  const { port, process } = adapter(["npm"], {
    "package.json": JSON.stringify({ scripts: { test: "x", lint: "y" } }),
    "package-lock.json": "{}",
  });
  for (const script of ["deploy", "-x", "constructor", "__proto__"]) {
    expect(await port.runScript("/p", script, [], 1000)).toMatchObject({
      kind: "unavailable",
      remedy: "Declared scripts: test, lint.",
    });
  }
  expect(process.runs).toEqual([]);
}, 30_000);

test("a manager that is not installed is Unavailable, not a crash", async () => {
  const { port } = adapter([], {
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "pnpm-lock.yaml": "",
  });
  expect(await port.runScript("/p", "test", [], 1000)).toMatchObject({
    kind: "unavailable",
    reason: expect.stringContaining("pnpm") as string,
  });
}, 30_000);

test("a malformed package.json or an undetectable manager stops the run before anything starts", async () => {
  const bad = adapter(["npm"], {
    "package.json": "{ nope",
    "package-lock.json": "",
  });
  expect(await bad.port.runScript("/p", "test", [], 1000)).toMatchObject({
    kind: "unavailable",
    reason: "package.json is not valid JSON",
  });
  const conflict = adapter(["npm", "yarn"], {
    "package.json": JSON.stringify({ scripts: { test: "x" } }),
    "package-lock.json": "",
    "yarn.lock": "",
  });
  expect(await conflict.port.runScript("/p", "test", [], 1000)).toMatchObject({
    kind: "unavailable",
  });
  expect(bad.process.runs).toEqual([]);
  expect(conflict.process.runs).toEqual([]);
}, 30_000);
