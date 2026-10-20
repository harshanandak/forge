import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { nodeFileCapture } from "../adapters/node-runtime/capture.ts";
import type { FileCapturePort } from "../core/catalog/index.ts";
import type { BlockSource } from "../generated/types.ts";
import { isSchemaObject, type JsonSchema } from "../contract/schema.ts";
import { refuse } from "../core/trust/index.ts";
import { fileURLToPath } from "node:url";
import { firstPartyBlocks } from "./first-party.ts";

/** The plan's authoring filename is mapped at capture, before any code is loaded. */
export const blockCapture: FileCapturePort = {
  open(root) {
    const handle = nodeFileCapture.open(root);
    return {
      ownership: "borrowed",
      value: {
        read(name, budget) {
          return handle.value.read(
            name === "block.json" && existsSync(join(root, "forge.block.json"))
              ? "forge.block.json"
              : name,
            budget,
          );
        },
      },
    };
  },
};
export function resolveBlock(root: string, source: BlockSource): string {
  if ("path" in source) return resolve(root, source.path);
  if ("package" in source) {
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(
        source.package,
      )
    )
      refuse("INPUT_INVALID", "Expected an installed package name");
    const require = createRequire(join(root, "package.json"));
    // Search Node's installed-package roots without requesting an exported subpath
    // or loading the package's entry point. Scoped packages use the same roots.
    for (const directory of require.resolve.paths(source.package) ?? []) {
      const candidate = join(directory, source.package);
      if (existsSync(candidate)) return candidate;
    }
    refuse(
      "PROVIDER_MISSING",
      `Package ${source.package} is not installed; install it or repair the block source`,
    );
  }
  const builtin = firstPartyBlocks[source.builtin];
  if (builtin) return fileURLToPath(builtin);
  refuse(
    "PROVIDER_MISSING",
    `Built-in block ${source.builtin} is not registered`,
  );
}
export function sourceFor(spec: string): BlockSource {
  return spec.startsWith(".") || /^[A-Za-z]:[\\/]|^\//.test(spec)
    ? { path: spec }
    : { package: spec };
}

const MAX_SCHEMA_BYTES = 1024 * 1024;
function readJson(path: string): unknown {
  if (!existsSync(path) || statSync(path).size > MAX_SCHEMA_BYTES)
    return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
/** A block's configSchema, read as data so config can apply its defaults; undefined when unreadable. */
export function readConfigSchema(
  root: string,
  source: BlockSource,
): JsonSchema | undefined {
  try {
    const dir = resolveBlock(root, source);
    const manifest =
      readJson(join(dir, "forge.block.json")) ??
      readJson(join(dir, "block.json"));
    const path = isSchemaObject(manifest) ? manifest.configSchema : undefined;
    if (typeof path !== "string" || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path))
      return undefined;
    const schema = readJson(join(dir, path));
    return isSchemaObject(schema) ? schema : undefined;
  } catch {
    return undefined;
  }
}
