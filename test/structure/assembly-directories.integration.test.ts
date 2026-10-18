import { expect, test } from "bun:test";
import { findRawAssemblyDirectories } from "./lib/assembly-directories.ts";
import { CODE_FILE, format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("assembly creates directories only through the durable helper", () => {
  expect(
    format(
      findRawAssemblyDirectories(
        readRepoFiles(
          listRepoFiles().filter(
            (path) => path.startsWith("src/assembly/") && CODE_FILE.test(path),
          ),
        ),
      ),
    ),
  ).toEqual([]);
}, 30000);

test("the directory guard rejects raw sync, async, aliased and computed operations", () => {
  for (const text of [
    'import { mkdirSync as create } from "node:fs";',
    'import { mkdir as create } from "node:fs/promises";',
    "fs.mkdirSync(path, { recursive: true });",
    "await fs.promises.mkdir(path);",
    'fs["mkdirSync"](path);',
    "const { ['mkdir']: create } = fs;",
  ]) {
    expect(
      findRawAssemblyDirectories([
        { path: "src/assembly/nested/store.ts", text },
      ]),
    ).toHaveLength(1);
  }
  for (const text of [
    "// mkdirSync(path)\nensurePrivateDirectory(path);",
    "const sample = \"fs['mkdir'](path)\";",
  ])
    expect(
      findRawAssemblyDirectories([{ path: "src/assembly/store.ts", text }]),
    ).toEqual([]);
  expect(
    findRawAssemblyDirectories([
      {
        path: "src/adapters/store-sqlite/file-ops.ts",
        text: "mkdirSync(path);",
      },
    ]),
  ).toEqual([]);
}, 30000);
