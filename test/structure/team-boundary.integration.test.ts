import { expect, test } from "bun:test";
import { posix } from "node:path";
import { scanAdapters } from "./lib/adapters.ts";
import { findDependencyViolations, type PackageJson } from "./lib/imports.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
  type SourceFile,
} from "./lib/repo.ts";

const fixtures = readJson(
  "test/structure/fixtures/team-imports.json",
) as Record<string, string>;
const pkg = readJson("package.json") as PackageJson;
const paths = listRepoFiles();
const { manifests } = scanAdapters(paths);
const boundary = (files: readonly SourceFile[], config: PackageJson = pkg) =>
  findDependencyViolations(files, config, manifests).filter(
    (violation) => violation.rule === "team-boundary",
  );
const fixture = (name: string): string => {
  const text = fixtures[name];
  if (text === undefined) throw new Error(`missing fixture: ${name}`);
  return text;
};

test("the real public tree has no dependency on team", () => {
  expect(
    format(
      boundary(readRepoFiles(paths.filter((path) => CODE_FILE.test(path)))),
    ),
  ).toEqual([]);
}, 30_000);

for (const path of [
  "src/assembly/compose.ts",
  "src/blocks/sample/entry.cts",
  "bin/forge.ts",
  "cloud/src/worker.ts",
  "templates/delivery/load.mjs",
  "tools/build-assets.ts",
  "examples/hello-block/index.ts",
]) {
  for (const name of [
    "static import",
    "type-only import",
    "star re-export",
    "named re-export",
    "literal dynamic import",
    "literal require",
  ]) {
    test(`${path} refuses ${name} into team`, () => {
      const target = posix.relative(posix.dirname(path), "team/secret.ts");
      const text = fixture(name).replace("../../team/secret.ts", target);
      const found = boundary([{ path, text }]);
      expect(found.map((violation) => violation.file)).toEqual([path]);
      expect(found[0]?.message).toContain("team/");
    }, 30_000);
  }
}

for (const path of [
  "src/assembly/compose.ts",
  "bin/forge.ts",
  "cloud/src/worker.ts",
  "templates/delivery/load.mjs",
]) {
  for (const name of [
    "nonliteral import",
    "nonliteral require",
    "computed template import",
  ]) {
    test(`${path} refuses ${name} at composition`, () => {
      expect(
        boundary([{ path, text: fixture(name) }]).map((v) => v.file),
      ).toEqual([path]);
    }, 30_000);
  }
}

test("a public barrel cannot conceal its bridge into team", () => {
  const files = [
    { path: "src/assembly/compose.ts", text: fixture("barrel entry") },
    { path: "src/assembly/bridge.ts", text: fixture("barrel bridge") },
    { path: "team/secret.ts", text: "export const secret = 1;" },
  ];
  expect(boundary(files).map((v) => v.file)).toContain(
    "src/assembly/bridge.ts",
  );
}, 30_000);

for (const name of ["package imports alias", "package exports alias"]) {
  test(`team cannot be reached through a ${name}`, () => {
    const config = {
      ...pkg,
      imports: { "#private/*": { default: "./team/*.ts" } },
      exports: { "./private/*": { import: "./team/*.ts" } },
    };
    expect(
      boundary(
        [{ path: "src/assembly/compose.ts", text: fixture(name) }],
        config,
      ).map((v) => v.file),
    ).toEqual(["src/assembly/compose.ts"]);
  }, 30_000);
}

test("team may import open code and public lookalikes are allowed", () => {
  expect(
    boundary([
      { path: "team/compose.ts", text: "export * from '../src/index.ts';" },
      {
        path: "src/assembly/compose.ts",
        text: "export * from './teamwork.ts';",
      },
      {
        path: "src/assembly/load.ts",
        text: '// import(path);\nconst example = "require(path)";',
      },
      { path: "test/team/example.ts", text: fixture("static import") },
    ]),
  ).toEqual([]);
}, 30_000);
