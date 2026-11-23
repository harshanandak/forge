import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as preservation from "../../tools/ci/skeleton-preservation.ts";

const { changedPaths, checkPreservation, git } = preservation;
const timeout = 30_000;
const before = {
  workflow: `on: [pull_request, push]
jobs:
  structure:
    steps:
      - run: bun install --frozen-lockfile --ignore-scripts
        working-directory: cloud
      - run: bun run test:structure
  static:
    steps:
      - run: bun install --frozen-lockfile --ignore-scripts
        working-directory: cloud
      - run: bun run lint
  verify:
    strategy:
      matrix:
        node: [24, 26]
    steps: &verify-steps
      - if: matrix.suite != 'pack'
        run: bun install --frozen-lockfile --ignore-scripts
        working-directory: cloud
      - if: matrix.suite != 'pack'
        run: bun run check
      - name: Unit tests
        run: bun run test:unit
  verify-main:
    steps: *verify-steps
  verify-node26:
    steps: *verify-steps
`,
  packageJson: '{"scripts":{"build":"original","build:team":"team"}}',
  nodeSensitive: 'export const nodeSensitive = {\n  "old": "reason",\n};\n',
};
const after = {
  workflow: before.workflow
    .replaceAll(
      "        working-directory: cloud\n",
      "        working-directory: cloud\n      - run: bun install --frozen-lockfile --ignore-scripts --linker hoisted\n        working-directory: hub\n",
    )
    .replace(
      "      - run: bun run test:structure\n",
      "      - name: Check skeleton preservation\n        run: bun tools/ci/skeleton-preservation.ts\n      - run: bun run test:structure\n",
    )
    .replace(
      "        run: bun run check\n",
      "        run: bun run check\n      - name: Build hub\n        if: matrix.suite != 'pack'\n        run: bun run build:hub\n",
    )
    .replace(
      /(- if: matrix.suite != 'pack'\n {8}run: bun install[^\n]+\n {8}working-directory: cloud\n) {6}- run:/,
      "$1      - if: matrix.suite != 'pack'\n        run:",
    ),
  packageJson:
    '{"scripts":{"build":"original","build:team":"team","build:hub":"tsc -p hub/tsconfig.json"}}',
  nodeSensitive: before.nodeSensitive.replace(
    "};",
    '  "hub/test/scaffold.integration.test.ts":\n    "Launches selected Node and npm on the built hub package.",\n' +
      '  "hub/test/node-entry.integration.test.ts":\n    "Launches selected Node on the built hub entry.",\n};',
  ),
};
const paths = [
  ".github/workflows/ci.yml",
  "package.json",
  "tools/ci/node-sensitive.ts",
];

function rejectPaths(paths: string[]): void {
  expect(() => checkPreservation(before, after, paths)).toThrow(
    "outside the skeleton",
  );
}

test(
  "preservation refuses a rename across its allowed paths",
  () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-preservation-"));
    const run = (...args: string[]) => git("-C", cwd, ...args).trim();
    try {
      run("init", "-q");
      run("config", "diff.renames", "true");
      writeFileSync(join(cwd, "bun.lock"), "original\n");
      run("add", "bun.lock");
      const original = run("write-tree");
      run("mv", "bun.lock", "package.json");
      const renamed = run("write-tree");
      for (const [old, head] of [
        [original, renamed],
        [renamed, original],
      ] as const)
        rejectPaths(changedPaths(old, head, cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  timeout,
);

test(
  "preservation accepts only the intended steps and expands shared steps",
  () => {
    expect(() => checkPreservation(before, after, paths)).not.toThrow();
  },
  timeout,
);

for (const [description, original, replacement] of [
  [
    "missing test step",
    "      - name: Unit tests\n        run: bun run test:unit\n",
    "",
  ],
  [
    "false condition",
    "      - name: Unit tests\n",
    "      - name: Unit tests\n        if: false\n",
  ],
  ["matrix change", "node: [24, 26]", "node: [24]"],
  ["existing step change", "run: bun run test:unit", "run: bun run lint"],
] as const) {
  test(
    `preservation rejects a ${description}`,
    () => {
      const workflow = after.workflow.replace(original, replacement);
      expect(workflow).not.toBe(after.workflow);
      expect(() =>
        checkPreservation(before, { ...after, workflow }, paths),
      ).toThrow("existing CI workflow");
    },
    timeout,
  );
}

test(
  "preservation refuses root release changes, script rewrites and new reasons for old keys",
  () => {
    rejectPaths([...paths, ".github/workflows/release.yml"]);
    const packageJson = after.packageJson.replace('"original"', '"different"');
    expect(() =>
      checkPreservation(before, { ...after, packageJson }, paths),
    ).toThrow("root package.json");
    const nodeSensitive = after.nodeSensitive.replace('"reason"', '"changed"');
    expect(() =>
      checkPreservation(before, { ...after, nodeSensitive }, paths),
    ).toThrow("Node-sensitive inventory");
  },
  timeout,
);
