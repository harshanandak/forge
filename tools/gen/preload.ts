// Bun test preload: fallback for running a test file directly, without `bun run gen` first.
import { repoRoot, write } from "./types.ts";

export async function preload(root: string = repoRoot): Promise<void> {
  write(root);
  const { writeCoreManifest } = await import("./core.ts");
  writeCoreManifest(root);
}

await preload();
