import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeGenerated } from "./gen/write.ts";

async function inlineModule(
  entry: string,
  path: string,
  marker: string,
): Promise<string> {
  if (entry.split(marker).length !== 2)
    throw new Error(`Expected one import of ${path}`);
  const result = await Bun.build({
    entrypoints: [path],
    target: "node",
    format: "cjs",
  });
  if (!result.success || result.outputs.length !== 1)
    throw new AggregateError(result.logs, `Could not bundle ${path}`);
  const code = await result.outputs[0]!.text();
  if (new Bun.Transpiler({ loader: "js" }).scan(code).imports.length !== 0)
    throw new Error(`${path} must be self-contained`);
  return entry.replace(
    marker,
    () =>
      `(() => { const module = { exports: {} }; const exports = module.exports;\n${code}\nreturn module.exports; })()`,
  );
}

export async function inlineWorkPrimitives(
  entry: string,
  path: string,
): Promise<string> {
  const records = await inlineModule(
    entry,
    path,
    'require("./record-primitives.ts")',
  );
  return inlineModule(
    records,
    join(dirname(path), "file-declarations.ts"),
    'require("./file-declarations.ts")',
  );
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  for (const { block, module, specifier } of [
    {
      block: "work",
      module: "blocks/work/record-primitives.ts",
      specifier: "./record-primitives",
    },
    {
      block: "work",
      module: "blocks/work/file-declarations.ts",
      specifier: "./file-declarations",
    },
    {
      block: "accounts",
      module: "contract/display-text.ts",
      specifier: "../../contract/display-text",
    },
  ]) {
    const entry = join(root, "dist/src/blocks", block, "entry.cjs");
    const marker = `require("${specifier}.ts")`;
    writeGenerated(
      entry,
      await inlineModule(
        readFileSync(entry, "utf8").replaceAll(
          `require("${specifier}.js")`,
          marker,
        ),
        join(root, "src", module),
        marker,
      ),
    );
  }
}
