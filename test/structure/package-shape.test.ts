import { expect, test } from "bun:test";
import {
  findNonErasableSyntax,
  findPackageShapeViolations,
} from "./lib/package-shape.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
} from "./lib/repo.ts";

const good = {
  type: "module",
  engines: { node: "^24.15.0 || >=26" },
  packageManager: "bun@1.4.3",
  bin: { forge: "dist/bin/forge.js" },
  scripts: {
    check: "bun check",
    lint: "bun lint --type-aware",
    fmt: "bun fmt --check",
    test: "bun test --timeout 30000",
  },
  devDependencies: { typescript: "7.0.2" },
};
const goodTsconfig = {
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    rewriteRelativeImportExtensions: true,
    module: "nodenext",
  },
};

test("package.json and tsconfig keep the agreed shape", () => {
  const found = findPackageShapeViolations(
    readJson("package.json"),
    readJson("tsconfig.json"),
  );
  expect(format(found)).toEqual([]);
}, 30_000);

test("sources use only syntax Node can strip", () => {
  const paths = listRepoFiles().filter(
    (p) => CODE_FILE.test(p) && !p.startsWith("test/structure/"),
  );
  const files = readRepoFiles(paths);
  expect(
    format(files.flatMap((f) => findNonErasableSyntax(f.path, f.text))),
  ).toEqual([]);
}, 30_000);

test("the guard accepts the agreed shape", () => {
  expect(findPackageShapeViolations(good, goodTsconfig)).toEqual([]);
}, 30_000);

test("the guard rejects install scripts, forbidden fields, retired packages and interim layers", () => {
  const bad = (patch: object): number =>
    findPackageShapeViolations({ ...good, ...patch }, goodTsconfig).length;
  expect(bad({ scripts: { ...good.scripts, postinstall: "x" } })).toBe(1);
  expect(bad({ scripts: { ...good.scripts, prepare: "x" } })).toBe(1);
  expect(bad({ peerDependencies: { a: "1" } })).toBe(1);
  expect(bad({ bundledDependencies: ["a"] })).toBe(1);
  expect(bad({ devDependencies: { eslint: "9.0.0" } })).toBe(1);
  expect(bad({ dependencies: { "cross-spawn": "7.0.0" } })).toBe(1);
  expect(bad({ scripts: { ...good.scripts, lint: "eslint ." } })).toBe(1);
  expect(bad({ scripts: { ...good.scripts, test: "bun test" } })).toBe(1);
  expect(bad({ type: "commonjs" })).toBe(1);
}, 30_000);

test("the guard rejects loosened compiler options and non-erasable syntax", () => {
  const options = {
    ...goodTsconfig.compilerOptions,
    strict: false,
    erasableSyntaxOnly: false,
  };
  expect(
    findPackageShapeViolations(good, { compilerOptions: options }),
  ).toHaveLength(2);
  expect(
    findNonErasableSyntax("a.ts", "export enum Color { Red }\n"),
  ).toHaveLength(1);
  expect(
    findNonErasableSyntax("a.ts", "namespace N { export const a = 1; }\n"),
  ).toHaveLength(1);
  expect(
    findNonErasableSyntax(
      "a.ts",
      "class A { constructor(private x: number) {} }\n",
    ),
  ).toHaveLength(1);
  expect(findNonErasableSyntax("a.ts", "@sealed\nclass A {}\n")).toHaveLength(
    1,
  );
  const fine =
    "export type Color = 'red';\nclass A { constructor(x: number) {} }\n";
  expect(findNonErasableSyntax("a.ts", fine)).toEqual([]);
}, 30_000);
