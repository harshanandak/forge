import { expect, test } from "bun:test";
import { findToolchainNames } from "../../structure/lib/imports.ts";
import { listRepoFiles, readRepoFiles } from "../../structure/lib/repo.ts";
import { readFileSync } from "node:fs";

test("runner adapter implements a neutral port without importing block internals", () => {
  const implementation = readFileSync(
    new URL("../../../src/adapters/runner-output/index.ts", import.meta.url),
    "utf8",
  );
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../../../src/adapters/runner-output/adapter.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { port: string };
  expect(implementation).not.toContain("blocks/check");
  expect(manifest.port).toBe("src/ports/runner-output.ts#RunnerOutputPort");
}, 1000);

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
