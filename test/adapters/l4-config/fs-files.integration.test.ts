// Integration (repository scan): verify the fs adapter and core boundary in the checkout.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importsOf } from "../../structure/lib/imports.ts";
import { scanAdapters } from "../../structure/lib/adapters.ts";
import { listRepoFiles } from "../../structure/lib/repo.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

test("core config imports no filesystem or path built-in", () => {
  const core = listRepoFiles().filter((p) =>
    /^src\/core\/config\/.*\.ts$/.test(p),
  );
  expect(core.length).toBeGreaterThan(0);
  const leaks = core.flatMap((path) =>
    importsOf({ path, text: readFileSync(join(REPO, path), "utf8") })
      .filter((s) => /^(?:node:)?(?:fs|path)(?:\/|$)/.test(s))
      .map((s) => `${path} imports ${s}`),
  );
  expect(leaks).toEqual([]);
}, 30_000);

test("the fs adapter has a manifest the structure guard accepts", () => {
  const { manifests } = scanAdapters(listRepoFiles());
  expect(manifests.map((m) => m.name)).toContain("fs");
}, 30_000);
