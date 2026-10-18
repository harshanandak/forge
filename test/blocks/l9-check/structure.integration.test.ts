import { expect, test } from "bun:test";
import { findToolchainNames } from "../../structure/lib/imports.ts";
import { listRepoFiles, readRepoFiles } from "../../structure/lib/repo.ts";

test("check implementation contains no toolchain names; the guard rejects a named runner", () => {
  const files = readRepoFiles(
    listRepoFiles().filter((path) => path.startsWith("src/blocks/check/")),
  );
  expect(findToolchainNames(files)).toEqual([]);
  expect(
    findToolchainNames([
      { path: "src/blocks/check/bad.ts", text: 'const command = "bun test";' },
    ]),
  ).toHaveLength(1);
}, 3000);
