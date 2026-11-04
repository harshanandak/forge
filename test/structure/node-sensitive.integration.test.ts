import { expect, test } from "bun:test";
import { nodeReferences } from "../../tools/ci/source-selection.ts";
import { nodeSensitive } from "../../tools/ci/node-sensitive.ts";
import { listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("source tests that reference Node directly or through a helper are inventoried", () => {
  const files = readRepoFiles(
    listRepoFiles().filter((path) => /\.(?:[cm]?[jt]s)$/.test(path)),
  );
  expect(
    nodeReferences(files).filter((file) => !(file in nodeSensitive)),
  ).toEqual([]);
}, 30_000);

test("the inventory guard reports unlisted npm and npx launches without matching unrelated names", () => {
  const synthetic = [
    { path: "test/npm.integration.test.ts", text: "spawnSync('npm', [])" },
    { path: "test/npx.integration.test.ts", text: 'spawn("npx", [])' },
    {
      path: "test/npm-cmd.integration.test.ts",
      text: "execFile('npm.cmd', [])",
    },
    {
      path: "test/npx-cmd.integration.test.ts",
      text: "execFileSync('npx.cmd', [])",
    },
    { path: "test/shell.integration.test.ts", text: "execSync('npm install')" },
    {
      path: "test/array.integration.test.ts",
      text: "Bun.spawn(['npx', '--help'])",
    },
    { path: "test/names.test.ts", text: "const names = ['npm', 'npx.cmd']" },
    { path: "test/unrelated.test.ts", text: "spawnSync('npm-helper', [])" },
  ];
  expect(
    nodeReferences(synthetic).filter((file) => !(file in nodeSensitive)),
  ).toEqual(synthetic.slice(0, 6).map(({ path }) => path));
}, 30_000);
