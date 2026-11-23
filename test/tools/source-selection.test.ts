import { expect, test, setDefaultTimeout } from "bun:test";
import {
  nodeReferences,
  selectSourceFiles,
} from "../../tools/ci/source-selection.ts";
import { nodeSensitive } from "../../tools/ci/node-sensitive.ts";
import {
  assignShards,
  discoverSourceFiles,
  requireShardFiles,
} from "../../tools/ci/test-shards.ts";
import { readFileSync } from "node:fs";

setDefaultTimeout(30_000);

test("source discovery retains root and hub test files", () => {
  const expected = [
    ...new Bun.Glob("{test,src}/**/*.test.ts").scanSync("."),
    ...new Bun.Glob("hub/test/**/*.test.ts").scanSync("."),
  ]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith("/packed.integration.test.ts"));
  const files = discoverSourceFiles();
  expect(files.toSorted()).toEqual(expected.toSorted());
  expect(files).toContain("test/tools/source-selection.test.ts");
  expect(files).toContain("hub/test/scaffold.integration.test.ts");
});

test("an empty source shard fails before running a test phase", () => {
  expect(() => requireShardFiles([], "1/1")).toThrow(
    "No source tests selected for shard 1/1",
  );
});

test("source legs preserve every file and both majors cover every Node-sensitive file", () => {
  const files = discoverSourceFiles();
  const { files: timings } = JSON.parse(
    readFileSync("test/timings.json", "utf8"),
  ) as { files: Record<string, number> };
  for (const count of [1, 3]) {
    const legs = ["24", "26"].map((major) =>
      assignShards(selectSourceFiles(files, major), timings, count).flat(),
    );
    expect([...new Set(legs.flat())].sort()).toEqual(files.toSorted());
    expect(legs[0]!.toSorted()).toEqual(files.toSorted());
    expect(legs[1]!.toSorted()).toEqual(Object.keys(nodeSensitive).sort());
    for (const file of files) {
      expect(legs[0]!.filter((path) => path === file)).toHaveLength(1);
      expect(legs[1]!.filter((path) => path === file)).toHaveLength(
        file in nodeSensitive ? 1 : 0,
      );
    }
  }
  expect(() => selectSourceFiles(files, "25")).toThrow();
});

test("the Node inventory guard rejects an unlisted launch, configured path and imported helper", () => {
  const synthetic = [
    {
      path: "test/new.integration.test.ts",
      text: "spawnSync('node', ['--version'])",
    },
    {
      path: "test/env.integration.test.ts",
      text: "spawn(process.env.NODE_EXE, [])",
    },
    { path: "test/helper.integration.test.ts", text: "import './helper.ts'" },
    { path: "test/helper.ts", text: "Bun.spawn(['node.exe'])" },
    { path: "test/pure.test.ts", text: "import { join } from 'node:path'" },
  ];
  expect(
    nodeReferences(synthetic).filter((file) => !(file in nodeSensitive)),
  ).toEqual(synthetic.slice(0, 3).map(({ path }) => path));
});
