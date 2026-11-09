import { expect, test } from "bun:test";
import { scanAdapters } from "./lib/adapters.ts";
import {
  findAdapterViolations,
  findDependencyViolations,
  findToolchainNames,
  type AdapterManifest,
  type PackageJson,
} from "./lib/imports.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
  repoRoot,
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

const packageFixtures = readJson(
  "test/structure/fixtures/package-dependencies.json",
) as {
  root: PackageJson;
  cloud: PackageJson;
  imports: Record<string, string>;
  adapters: AdapterManifest[];
};
const cloudManifest = {
  path: "cloud/package.json",
  text: JSON.stringify(packageFixtures.cloud),
};

test("every cloud runtime dependency has a cloud adapter", () => {
  const cloud = scanAdapters(
    paths
      .filter((path) => path.startsWith("cloud/"))
      .map((path) => path.slice(6)),
    `${repoRoot}/cloud`,
  );
  expect(
    format(
      findAdapterViolations(
        cloud.dirs,
        cloud.manifests,
        readJson("cloud/package.json") as PackageJson,
      ),
    ),
  ).toEqual([]);
  const missing = findAdapterViolations([], [], packageFixtures.cloud);
  expect(missing.map((violation) => violation.message)).toEqual([
    'runtime dependency "cloud-lib" has no adapter; each dependency sits behind one src/adapters/<name>/',
  ]);
}, 30_000);

for (const [kind, text] of Object.entries(packageFixtures.imports)) {
  for (const path of [
    "cloud/src/worker.ts",
    "cloud/src/adapters/other/index.ts",
    "src/core/cloud.ts",
    "src/adapters/oauth/index.ts",
    "bin/cloud.ts",
  ]) {
    test(`${path} refuses cloud-only dependency through ${kind}`, () => {
      const found = findDependencyViolations(
        [cloudManifest, { path, text }],
        packageFixtures.root,
        packageFixtures.adapters,
      );
      expect(found.map((violation) => violation.file)).toEqual([path]);
      expect(found[0]?.message).toContain("cloud-lib");
    }, 30_000);
  }
  test(`the owning cloud adapter accepts ${kind}`, () => {
    expect(
      findDependencyViolations(
        [cloudManifest, { path: "cloud/src/adapters/oauth/index.ts", text }],
        packageFixtures.root,
        packageFixtures.adapters,
      ),
    ).toEqual([]);
  }, 30_000);
}

test("cloud files cannot bypass root runtime adapter ownership or use cloud tooling", () => {
  for (const name of ["root-lib", "cloud-tool"]) {
    const path = "cloud/src/worker.ts";
    const found = findDependencyViolations(
      [cloudManifest, { path, text: `import '${name}';` }],
      packageFixtures.root,
      packageFixtures.adapters,
    );
    expect(found.map((violation) => violation.file)).toEqual([path]);
    expect(found[0]?.message).toContain(name);
  }
}, 30_000);

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

for (const module of ["fs", "node:fs", "fs/promises", "node:fs/promises"]) {
  for (const text of [
    `import * as fs from "${module}";`,
    `export * from "${module}";`,
    `const fs = await import("${module}");`,
    `const fs = require("${module}");`,
  ]) {
    test(`new filesystem readers are refused: ${text}`, () => {
      const path = "src/adapters/new-reader/index.ts";
      const found = findDependencyViolations([{ path, text }], {}, []);
      expect(found).toHaveLength(1);
      expect(found[0]?.file).toBe(path);
      expect(found[0]?.message).toContain(module);
      expect(found[0]?.message).toContain("project-files port");
    }, 30_000);
  }
}

test("filesystem ownership allows only exact inventoried files", () => {
  const text = 'import * as fs from "node:fs";';
  const allowed = [
    "src/adapters/fs/index.ts",
    "src/blocks/project/files.ts",
    "src/assembly/capture.ts",
    "src/version.ts",
  ];
  expect(
    findDependencyViolations(
      allowed.map((path) => ({ path, text })),
      {},
      [],
    ),
  ).toEqual([]);
  const refused = [
    "src/adapters/fs/new-reader.ts",
    "src/adapters/store-sqlite/new-reader.ts",
    "src/blocks/project/new-reader.ts",
    "src/assembly/new-reader.ts",
  ];
  expect(
    findDependencyViolations(
      refused.map((path) => ({ path, text })),
      {},
      [],
    ).map((v) => v.file),
  ).toEqual(refused);
}, 30_000);

for (const api of ["Bun.file", "Bun.write"]) {
  test(`new filesystem readers cannot use ${api}`, () => {
    const path = "src/adapters/new-reader/index.ts";
    const found = findDependencyViolations(
      [{ path, text: `${api}("outside");` }],
      {},
      [],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(path);
    expect(found[0]?.message).toContain(api);
    expect(found[0]?.message).toContain("project-files port");
  }, 30_000);
}

test("filesystem call examples in comments and strings are not imports", () => {
  expect(
    findDependencyViolations(
      [
        {
          path: "src/adapters/new-reader/index.ts",
          text: `// require("fs"); Bun.file("outside");
/* import("node:fs"); Bun.write("outside"); */
const example = 'require("fs/promises"); Bun.file("outside");';`,
        },
      ],
      {},
      [],
    ),
  ).toEqual([]);
}, 30_000);

test("a platform builtin is owned by its adapter without claiming the Node executable", () => {
  const sqlite = {
    name: "store-sqlite",
    packages: [],
    executables: [],
    builtins: ["node:sqlite"],
  };
  const runtime = {
    name: "node-runtime",
    packages: [],
    executables: ["node"],
  };
  expect(
    findAdapterViolations(
      ["store-sqlite", "node-runtime"],
      [sqlite, runtime],
      {},
    ),
  ).toEqual([]);
  expect(
    findAdapterViolations(["wrong"], [{ ...sqlite, name: "wrong" }], {})[0]
      ?.message,
  ).toContain("does not belong");
}, 30_000);

test("the merged config filesystem provider uses a canonical builtin and keeps one owner", () => {
  const fs = {
    name: "fs",
    packages: [],
    executables: [],
    builtins: ["node:fs"],
  };
  expect(findAdapterViolations(["fs"], [fs], {})).toEqual([]);
  expect(
    findAdapterViolations(["wrong"], [{ ...fs, name: "wrong" }], {})[0]
      ?.message,
  ).toContain("does not belong");
  expect(
    findAdapterViolations(["fs"], [{ ...fs, builtins: ["fs"] }], {})[0]
      ?.message,
  ).toContain("unknown builtin");
}, 30_000);

const claimKinds = [
  {
    kind: "package",
    deps: { yaml: "2.0.0", toml: "1.0.0" },
    claim: (name: string, owner: string) => ({
      name: owner,
      packages: [name],
      executables: [],
    }),
    shared: "yaml",
    other: "toml",
  },
  {
    kind: "executable",
    deps: {},
    claim: (name: string, owner: string) => ({
      name: owner,
      packages: [],
      executables: [name],
    }),
    shared: "git",
    other: "gh",
  },
] as const;

for (const row of claimKinds) {
  const dirs = ["one", "two"];
  const pkgOf: PackageJson = { dependencies: row.deps };

  test(`one owner per ${row.kind}: duplicate claims fail naming kind, resource and claimants`, () => {
    const found = findAdapterViolations(
      dirs,
      [row.claim(row.shared, "one"), row.claim(row.shared, "two")],
      { dependencies: row.kind === "package" ? { [row.shared]: "1.0.0" } : {} },
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`${row.kind} "${row.shared}"`);
    expect(found[0]?.message).toContain("one, two");
  }, 30_000);

  test(`one owner per ${row.kind}: distinct claims pass`, () => {
    expect(
      findAdapterViolations(
        dirs,
        [row.claim(row.shared, "one"), row.claim(row.other, "two")],
        pkgOf,
      ),
    ).toEqual([]);
  }, 30_000);
}

test("a package imported by shipped code must be a runtime dependency", () => {
  const devOnly: PackageJson = { devDependencies: { yaml: "2.0.0" } };
  const runtime: PackageJson = { dependencies: { yaml: "2.0.0" } };
  const source = [
    {
      path: "src/adapters/config-yaml/a.ts",
      text: 'import YAML from "yaml";\n',
    },
    { path: "bin/forge.ts", text: 'import YAML from "yaml";\n' },
  ];
  const tooling = [
    { path: "test/a.test.ts", text: 'import YAML from "yaml";\n' },
    { path: "tools/a.ts", text: 'import YAML from "yaml";\n' },
  ];

  const shippedDevOnly = findDependencyViolations(source, devOnly, [
    yamlAdapter,
  ]);
  expect(shippedDevOnly.map((v) => v.file)).toContain(
    "src/adapters/config-yaml/a.ts",
  );
  expect(shippedDevOnly.map((v) => v.file)).toContain("bin/forge.ts");
  expect(shippedDevOnly[0]?.message).toContain("dependencies");
  expect(
    findDependencyViolations([source[0] as (typeof source)[number]], runtime, [
      yamlAdapter,
    ]),
  ).toEqual([]);
  expect(findDependencyViolations(tooling, devOnly, [yamlAdapter])).toEqual([]);
}, 30_000);

test("the guard rejects toolchain names in shipped code but not in adapters", () => {
  const files = [
    { path: "src/core/a.ts", text: 'const cmd = "npm test";\n' },
    { path: "src/adapters/package-manager/a.ts", text: 'const cmd = "npm";\n' },
    {
      path: "src/blocks/project/detect-node.ts",
      text: 'const cmd = "pnpm";\n',
    },
  ];
  expect(findToolchainNames(files).map((v) => v.file)).toEqual([
    "src/core/a.ts",
  ]);
}, 30_000);

test("the toolchain exemption covers only detector modules of the project block, not its other files", () => {
  const planted = [
    { path: "src/blocks/project/run.ts", text: 'run("npm test");\n' },
    { path: "src/blocks/project/index.ts", text: 'const m = "yarn";\n' },
    { path: "src/blocks/project/detect/node.ts", text: 'const m = "bun";\n' },
    { path: "src/blocks/project/detect-node.js", text: 'const m = "jest";\n' },
    {
      path: "src/blocks/project/sub/detect-node.ts",
      text: 'const m = "npm";\n',
    },
  ];
  expect(findToolchainNames(planted).map((v) => v.file)).toEqual(
    planted.map((f) => f.path),
  );
  const allowed = [
    { path: "src/blocks/project/detect-node.ts", text: 'const m = "npm";\n' },
    {
      path: "src/blocks/project/detect-hooks.ts",
      text: 'const m = "husky";\n',
    },
  ];
  expect(findToolchainNames(allowed)).toEqual([]);
}, 30_000);
