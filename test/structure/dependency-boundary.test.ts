import { expect, test } from "bun:test";
import { scanAdapters } from "./lib/adapters.ts";
import {
  findAdapterViolations,
  findDependencyViolations,
  findToolchainNames,
  type PackageJson,
} from "./lib/imports.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
} from "./lib/repo.ts";

const pkg = readJson("package.json") as PackageJson;
const paths = listRepoFiles();
const { dirs, manifests } = scanAdapters(paths);
const code = readRepoFiles(paths.filter((p) => CODE_FILE.test(p)));

test("every dependency is imported only inside its own adapter", () => {
  expect(format(findDependencyViolations(code, pkg, manifests))).toEqual([]);
}, 30_000);

test("every adapter has a manifest and every runtime dependency has an adapter", () => {
  expect(format(findAdapterViolations(dirs, manifests, pkg))).toEqual([]);
}, 30_000);

test("shipped code names no package manager, test runner, linter or hook runner outside adapters", () => {
  expect(format(findToolchainNames(code))).toEqual([]);
}, 30_000);

const withPackage: PackageJson = {
  dependencies: { yaml: "2.0.0" },
  devDependencies: { typescript: "7.0.2" },
};
const yamlAdapter = {
  name: "config-yaml",
  packages: ["yaml"],
  executables: [],
};

test("the guard rejects a package imported outside its adapter, and allows it inside", () => {
  const outside = [
    { path: "src/core/config/a.ts", text: 'import YAML from "yaml";\n' },
  ];
  const inside = [
    {
      path: "src/adapters/config-yaml/a.ts",
      text: 'import YAML from "yaml";\n',
    },
  ];
  const typeOnly = [
    {
      path: "src/blocks/x/a.ts",
      text: 'import type { Document } from "yaml";\n',
    },
  ];
  expect(
    findDependencyViolations(outside, withPackage, [yamlAdapter]),
  ).toHaveLength(1);
  expect(
    findDependencyViolations(typeOnly, withPackage, [yamlAdapter]),
  ).toHaveLength(1);
  expect(findDependencyViolations(inside, withPackage, [yamlAdapter])).toEqual(
    [],
  );
}, 30_000);

test("the guard rejects undeclared packages, Bun APIs in shipped code and stray child_process", () => {
  const files = [
    { path: "src/core/a.ts", text: 'import left from "left-pad";\n' },
    { path: "src/core/b.ts", text: 'import { Database } from "bun:sqlite";\n' },
    {
      path: "src/blocks/c.ts",
      text: 'import { spawn } from "node:child_process";\n',
    },
    {
      path: "src/blocks/d.ts",
      text: 'import "../adapters/config-yaml/a.ts";\n',
    },
  ];
  const found = findDependencyViolations(files, withPackage, [yamlAdapter]).map(
    (v) => v.file,
  );
  expect(found.sort()).toEqual([
    "src/blocks/c.ts",
    "src/blocks/d.ts",
    "src/core/a.ts",
    "src/core/b.ts",
  ]);
  const ok = [
    {
      path: "src/adapters/process/a.ts",
      text: 'import { spawn } from "node:child_process";\n',
    },
  ];
  expect(findDependencyViolations(ok, withPackage, [])).toEqual([]);
}, 30_000);

test("the guard rejects a runtime dependency with no adapter", () => {
  expect(findAdapterViolations([], [], withPackage)).toHaveLength(1);
  expect(
    findAdapterViolations(["config-yaml"], [yamlAdapter], withPackage),
  ).toEqual([]);
  expect(
    findAdapterViolations(["loose"], [yamlAdapter], withPackage),
  ).toHaveLength(1);
}, 30_000);

test("the guard rejects a package claimed by two adapters, and allows distinct claims", () => {
  const twin = { ...yamlAdapter, name: "config-yaml-twin" };
  const found = findAdapterViolations(
    ["config-yaml", "config-yaml-twin"],
    [yamlAdapter, twin],
    withPackage,
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.message).toContain("yaml");
  expect(found[0]?.message).toContain("config-yaml");
  expect(found[0]?.message).toContain("config-yaml-twin");

  const both: PackageJson = {
    dependencies: { yaml: "2.0.0", toml: "1.0.0" },
  };
  const tomlAdapter = {
    name: "config-toml",
    packages: ["toml"],
    executables: [],
  };
  expect(
    findAdapterViolations(
      ["config-yaml", "config-toml"],
      [yamlAdapter, tomlAdapter],
      both,
    ),
  ).toEqual([]);
}, 30_000);

test("the guard rejects toolchain names in shipped code but not in adapters", () => {
  const files = [
    { path: "src/core/a.ts", text: 'const cmd = "npm test";\n' },
    { path: "src/adapters/package-manager/a.ts", text: 'const cmd = "npm";\n' },
    { path: "src/blocks/project/a.ts", text: 'const cmd = "pnpm";\n' },
  ];
  expect(findToolchainNames(files).map((v) => v.file)).toEqual([
    "src/core/a.ts",
  ]);
}, 30_000);
