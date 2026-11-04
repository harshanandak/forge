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
