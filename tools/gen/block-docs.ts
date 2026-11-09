// Check every first-party block's docs file with the validator assembly uses, so a bad docs file
// fails `bun run gen` instead of every CI job that loads the block.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkBlockDocs } from "../../src/assembly/block-docs.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { repoRoot } from "./types.ts";

interface Manifest {
  readonly docs: string;
  readonly operations: Readonly<Record<string, unknown>>;
}

/** Throws the assembly error, naming the block's docs file, for the first block whose docs are invalid. */
export function checkBlockDocsIn(root: string = repoRoot): void {
  const blocks = join(root, "src/blocks");
  for (const entry of readdirSync(blocks, { withFileTypes: true })) {
    const dir = join(blocks, entry.name);
    const file = join(dir, "forge.block.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    try {
      checkBlockDocs(
        readFileSync(join(dir, manifest.docs), "utf8"),
        Object.keys(manifest.operations),
        manifest.docs,
      );
    } catch (error) {
      if (!(error instanceof ForgeFailure)) throw error;
      throw new Error(`src/blocks/${entry.name}: ${error.error.message}`, {
        cause: error,
      });
    }
  }
}
