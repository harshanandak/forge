// Replace dist/src/adapters/config-yaml/yaml.js with one file that holds the `yaml` package it
// re-exports, so a command loads one module where the package alone is 70-odd files. Runs after
// tsc in `bun run build`; the typed re-export (yaml.d.ts) and the `yaml` dependency are unchanged.
import { renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const target = join(
  resolve(import.meta.dirname, ".."),
  "dist/src/adapters/config-yaml",
);
const result = await Bun.build({
  entrypoints: [join(target, "yaml.js")],
  outdir: join(target, ".bundle"),
  target: "node",
  format: "esm",
  minify: { syntax: true, whitespace: true, identifiers: false },
});
if (!result.success)
  throw new AggregateError(result.logs, "bundling yaml failed");
renameSync(join(target, ".bundle/yaml.js"), join(target, "yaml.js"));
rmSync(join(target, ".bundle"), { recursive: true, force: true });
// The map tsc wrote describes the re-export file, not the bundle.
rmSync(join(target, "yaml.js.map"), { force: true });
