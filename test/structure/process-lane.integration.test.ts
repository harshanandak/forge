import { expect, test } from "bun:test";
import { format, listRepoFiles, readRepoFiles, TEST_FILE } from "./lib/repo.ts";
import { findMisplacedProcessTests } from "./lib/process-lane.ts";

test("process-spawning tests run in the integration lane", () => {
  const files = readRepoFiles(
    listRepoFiles().filter((path) => TEST_FILE.test(path)),
  );
  expect(format(findMisplacedProcessTests(files))).toEqual([]);
}, 30_000);

test("the guard rejects process calls in a parallel test file", () => {
  for (const call of [
    "spawn('git', [])",
    "Bun.spawnSync(['node'])",
    "createProcessPort()",
    "listRepoFiles()",
  ])
    expect(
      findMisplacedProcessTests([{ path: "test/a.test.ts", text: call }]),
    ).toHaveLength(1);
  expect(
    findMisplacedProcessTests([
      { path: "test/a.integration.test.ts", text: "spawn('git', [])" },
    ]),
  ).toEqual([]);
  expect(
    findMisplacedProcessTests([
      {
        path: "test/a.test.ts",
        text: "// spawn('git', [])\nconst sample = `Bun.spawnSync([])`;",
      },
    ]),
  ).toEqual([]);
}, 30_000);
