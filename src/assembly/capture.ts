import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { nodeFileCapture } from "../adapters/node-runtime/capture.ts";
import type { FileCapturePort } from "../core/catalog/index.ts";
import type { BlockSource } from "../generated/types.ts";
import { refuse } from "../core/trust/index.ts";
import { fileURLToPath } from "node:url";
import { firstPartyBlocks } from "./first-party.ts";

const shown = (s: string) =>
  JSON.stringify(s.length > 200 ? s.slice(0, 200) + "..." : s).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** The plan's authoring filename is mapped at capture, before any code is loaded. */
export const blockCapture: FileCapturePort = {
  open(root) {
    const handle = nodeFileCapture.open(root);
    const manifestPath = existsSync(join(root, "forge.block.json"))
      ? "forge.block.json"
      : "block.json";
    return {
      ownership: "borrowed",
      value: {
        manifestPath,
        read(name, budget) {
          return handle.value.read(
            name === "block.json" ? manifestPath : name,
            budget,
          );
        },
      },
    };
  },
};
export function resolveConfiguredBlock(
  root: string,
  source: BlockSource,
): string {
  if (!("path" in source)) return resolveBlock(root, source);
  const realRoot = realpathSync.native(root);
  const path = resolve(root, source.path);
  let folder: string;
  try {
    folder = realpathSync.native(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return path;
    throw error;
  }
  // node:path.relative compares case-insensitively on Windows.
  const from = relative(realRoot, folder);
  if (from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from))
    refuse(
      "INPUT_INVALID",
      `Block source ${shown(source.path)} resolves outside the project`,
    );
  return folder;
}

export function resolveBlock(root: string, source: BlockSource): string {
  if ("path" in source) return resolve(root, source.path);
  if ("package" in source) {
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(
        source.package,
      )
    )
      refuse(
        "INPUT_INVALID",
        /[\\/]/.test(source.package)
          ? `${shown(source.package)} is not a package name. For a local block folder, write ${shown("./" + source.package.replaceAll("\\", "/"))}`
          : "Expected an installed package name",
      );
    const require = createRequire(join(root, "package.json"));
    // Search Node's installed-package roots without requesting an exported subpath
    // or loading the package's entry point. Scoped packages use the same roots.
    for (const directory of require.resolve.paths(source.package) ?? []) {
      const candidate = join(directory, source.package);
      if (existsSync(candidate)) return candidate;
    }
    refuse(
      "PROVIDER_MISSING",
      `Package ${shown(source.package)} is not installed; install it or repair the block source`,
    );
  }
  const builtin = firstPartyBlocks[source.builtin];
  if (builtin) return fileURLToPath(builtin);
  refuse(
    "PROVIDER_MISSING",
    `Built-in block ${shown(source.builtin)} is not registered`,
  );
}
export function sourceFor(spec: string): BlockSource {
  return spec.startsWith(".") || /^[A-Za-z]:[\\/]|^\//.test(spec)
    ? { path: spec }
    : { package: spec };
}
