import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeGenerated } from "./gen/write.ts";

export async function inlineWorkPrimitives(
  entry: string,
  path: string,
): Promise<string> {
  const marker = 'require("./record-primitives.ts")';
  if (entry.split(marker).length !== 2)
    throw new Error("Expected one work primitive import");
  const result = await Bun.build({
    entrypoints: [path],
    target: "node",
    format: "cjs",
  });
  if (!result.success || result.outputs.length !== 1)
    throw new AggregateError(result.logs, "Work primitive build failed");
  const code = await result.outputs[0]!.text();
  if (new Bun.Transpiler({ loader: "js" }).scan(code).imports.length !== 0)
    throw new Error("Work primitives must be self-contained");
  return entry.replace(
    marker,
    () =>
      `(() => { const module = { exports: {} }; const exports = module.exports;\n${code}\nreturn module.exports; })()`,
  );
}
if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const entry = join(root, "dist/src/blocks/work/entry.cjs");
  writeGenerated(
    entry,
    await inlineWorkPrimitives(
      readFileSync(entry, "utf8").replace(
        'require("./record-primitives.js")',
        'require("./record-primitives.ts")',
      ),
      join(root, "src/blocks/work/record-primitives.ts"),
    ),
  );
}
