import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCoreManifest } from "../../tools/gen/core.ts";
import { preload } from "../../tools/gen/preload.ts";
import { OUTPUTS, write } from "../../tools/gen/types.ts";

const generated = [
  ...Object.values(OUTPUTS),
  "src/generated/core-discovery.ts",
  "src/generated/core-manifest.json",
];

test("preload leaves every current generated output untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-preload-"));
  try {
    // Type generation needs the schema inputs; core generation reads its area declarations from this repo.
    cpSync(new URL("../../schemas/", import.meta.url), join(root, "schemas"), {
      recursive: true,
    });
    write(root);
    writeCoreManifest(root);
    const stale = new Date("2020-01-01T00:00:00Z");
    for (const path of generated) utimesSync(join(root, path), stale, stale);
    await preload(root);
    for (const path of generated)
      expect(statSync(join(root, path)).mtimeMs).toBe(stale.getTime());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
