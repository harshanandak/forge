import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const target = realpathSync(process.env.FORGE_MUTATION_TARGET);
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || realpathSync(fileURLToPath(url)) !== target)
      return loaded;
    if (loaded.source == null)
      throw new Error("Mutation proof: loader returned no source");
    const hash = createHash("sha256")
      .update(
        typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source),
      )
      .digest("hex");
    if (hash !== process.env.FORGE_MUTATION_HASH)
      throw new Error(
        "Mutation proof: loaded bytes differ from the mutated copy",
      );
    appendFileSync(
      process.env.FORGE_MUTATION_PROOF,
      JSON.stringify({ target, hash, pid: process.pid }) + "\n",
    );
    return loaded;
  },
});
