import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { scanAdapters } from "./lib/adapters.ts";
import { findDependencyViolations, type PackageJson } from "./lib/imports.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
  repoRoot,
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

const declarations = readJson(
  "test/structure/fixtures/team-declarations.json",
) as {
  configs: Record<string, unknown>;
  manifests: { name: string; path: string; value: unknown }[];
};
const compilerConfigs = (
  root: string,
  files: readonly string[],
): SourceFile[] =>
  readRepoFiles(
    files.filter((path) => /(?:^|\/)tsconfig[^/]*\.json$/.test(path)),
    root,
  );

test("the real scan includes sources from every public root", () => {
  const sources = readRepoFiles(paths.filter((path) => CODE_FILE.test(path)));
  expect(sources.length).toBeGreaterThan(0);
  for (const root of ["src/", "bin/", "cloud/src/"])
    expect(
      sources.filter((file) => file.path.startsWith(root)).length,
    ).toBeGreaterThan(0);
}, 30_000);

test("compiler discovery follows differently named bases into team aliases", () => {
  const scratch = mkdtempSync(join(tmpdir(), "forge-config-chain-"));
  try {
    for (const [path, config] of Object.entries(declarations.configs)) {
      mkdirSync(join(scratch, posix.dirname(path)), { recursive: true });
      writeFileSync(join(scratch, path), JSON.stringify(config));
    }
    const found = compilerConfigs(scratch, Object.keys(declarations.configs));
    expect(boundary(found).map((v) => v.file)).toEqual([
      "config/base.json",
      "config/options.json",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);

for (const [path, name] of [
  ["src/assembly/view.tsx", "TSX side-effect import"],
  ["src/assembly/view.jsx", "JSX side-effect import"],
] as const) {
  test(`${path} refuses side-effect imports alongside JSX`, () => {
    expect(
      boundary([{ path, text: fixture(name) }]).map((v) => v.file),
    ).toEqual([path]);
  }, 30_000);
}

for (const path of ["src/assembly/view.tsx", "src/assembly/view.jsx"]) {
  test(`${path} accepts public JSX`, () => {
    expect(boundary([{ path, text: fixture("public JSX") }])).toEqual([]);
  }, 30_000);
  test(`${path} fails closed on a parse error`, () => {
    expect(() => boundary([{ path, text: fixture("parse failure") }])).toThrow(
      path,
    );
  }, 30_000);
}

for (const { name, path, value } of declarations.manifests) {
  test(`shipped JSON refuses a team ${name}`, () => {
    const found = boundary([{ path, text: JSON.stringify(value) }]);
    expect(found.map((v) => v.file)).toEqual([path]);
    expect(found[0]?.message).toContain("team/");
  }, 30_000);
}

test("shipped JSON allows public paths, prose and external schema URLs", () => {
  expect(
    boundary([
      {
        path: "package.json",
        text: JSON.stringify({
          exports: "./dist/src/index.js",
          bin: "./dist/bin/forge.js",
          files: ["dist", "templates"],
        }),
      },
      {
        path: "src/adapters/sample/adapter.json",
        text: JSON.stringify({
          entry: "./teamwork.js",
          description: "Ask the team/ owner",
        }),
      },
      {
        path: "schemas/public.json",
        text: JSON.stringify({
          $schema: "https://example.com/team/schema.json",
          $ref: "#/$defs/team",
          $defs: { team: { description: "team/ is removable" } },
        }),
      },
    ]),
  ).toEqual([]);
}, 30_000);

test("the real shipped JSON declarations do not depend on team", () => {
  const manifests = paths.filter(
    (path) =>
      path === "package.json" ||
      /^(?:src|bin|cloud|schemas|templates|examples)\/.*\.json$/.test(path),
  );
  expect(manifests.length).toBeGreaterThan(0);
  expect(boundary(readRepoFiles(manifests))).toEqual([]);
}, 30_000);

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

for (const name of [
  "Windows case",
  "Windows backslash",
  "createRequire alias",
  "triple-slash reference",
  "test-named bridge",
  "test-folder bridge",
  "test declaration bridge",
]) {
  test(`public code refuses ${name}`, () => {
    expect(
      boundary([{ path: "bin/forge.cjs", text: fixture(name) }]),
    ).not.toEqual([]);
  }, 30_000);
}
for (const path of [
  "src/core/load.ts",
  "src/blocks/sample/load.ts",
  "src/adapters/new-loader/index.ts",
  "cloud/src/load.ts",
]) {
  for (const name of [
    "nonliteral import",
    "nonliteral require",
    "computed template import",
    "template import",
    "createRequire alias",
  ]) {
    test(`${path} refuses ${name} outside composition`, () => {
      expect(boundary([{ path, text: fixture(name) }])).not.toEqual([]);
    }, 30_000);
  }
}
test("public compiler configurations reject root and extended paths into team", () => {
  expect(
    boundary(
      readRepoFiles(
        paths.filter((path) => /(?:^|\/)tsconfig[^/]*\.json$/.test(path)),
      ),
    ),
  ).toEqual([]);
  for (const [path, target] of [
    ["tsconfig.json", "./team/*"],
    ["config/base.json", "../Team/*"],
    ["tsconfig.build.json", ".\\TEAM\\*"],
  ] as const) {
    const text = JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { private: [target] } },
    });
    expect(boundary([{ path, text }])).toHaveLength(1);
  }
}, 30_000);
test("public sources compile in a copy with team removed and emit no team files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "forge-public-"));
  try {
    for (const path of paths.filter(
      (path) => !/^(?:team|test)\//i.test(path),
    )) {
      cpSync(join(repoRoot, path), join(scratch, path));
    }
    cpSync(join(repoRoot, "src/generated"), join(scratch, "src/generated"), {
      recursive: true,
    });
    symlinkSync(
      join(repoRoot, "node_modules"),
      join(scratch, "node_modules"),
      "junction",
    );
    const config = readJson("tsconfig.json") as {
      compilerOptions: Record<string, unknown>;
    };
    Object.assign(config, {
      include: ["bin", "src", "cloud/src"],
      exclude: (readJson("tsconfig.build.json") as { exclude: string[] })
        .exclude,
    });
    Object.assign(config.compilerOptions, { noEmit: false, outDir: "./dist" });
    writeFileSync(join(scratch, "tsconfig.json"), JSON.stringify(config));
    const compiler = join(scratch, "node_modules/typescript/bin/tsc");
    const compile = () =>
      spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
    expect(existsSync(join(scratch, "team"))).toBe(false);
    const built = compile();
    if (built.error || built.status !== 0)
      throw new Error(built.stdout + built.stderr, { cause: built.error });
    expect(built.status).toBe(0);
    const output = readdirSync(join(scratch, "dist"), {
      recursive: true,
      encoding: "utf8",
    }).map((path) => path.replaceAll("\\", "/"));
    expect(output).toContain("src/index.js");
    expect(output).toContain("cloud/src/worker.js");
    expect(output.filter((path) => /(?:^|\/)team(?:\/|$)/i.test(path))).toEqual(
      [],
    );
    writeFileSync(
      join(scratch, "src/team-removal-probe.ts"),
      "/// <reference path='../team/private.d.ts' />\n",
    );
    const broken = compile();
    expect(broken.error).toBeUndefined();
    expect(broken.status).not.toBe(0);
    expect((broken.stdout + broken.stderr).replaceAll("\\", "/")).toContain(
      "team/private.d.ts",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
