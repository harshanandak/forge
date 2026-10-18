import { mkdirSync, writeFileSync } from "node:fs";
import { assembleCoreManifest } from "../../src/core/catalog/index.ts";
import { operations as catalog } from "../../src/core/catalog/operations.ts";
import { operations as trust } from "../../src/core/trust/operations.ts";

/** Each area owns its typed declarations; this is the sole assembly boundary. */
export function writeCoreManifest(): void {
  const manifest = assembleCoreManifest(
    {
      schemaVersion: "forge.block/1",
      id: "forge/core",
      version: "1.0.0",
      authorAbi: "forge.author/v1",
      profile: "trusted-action-sync/v1",
      entry: "index.cjs",
      docs: "docs.json",
    },
    [catalog, trust],
  );
  const directory = new URL("../../src/generated/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    new URL("core-manifest.json", directory),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
