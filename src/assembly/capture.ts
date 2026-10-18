import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { nodeFileCapture } from "../adapters/node-runtime/capture.ts";
import type { FileCapturePort } from "../core/catalog/index.ts";
import type { BlockSource } from "../generated/types.ts";
import { refuse } from "../core/trust/index.ts";

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
    const require = createRequire(join(root, "package.json"));
    return resolve(require.resolve(`${source.package}/package.json`), "..");
  }
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
