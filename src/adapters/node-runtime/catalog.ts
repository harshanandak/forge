import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BlockCatalog } from "../../core/runtime/catalog.ts";
import { TrustStore } from "../../core/trust/index.ts";
import { nodeFileCapture } from "./capture.ts";
import { nodeRunIsolation } from "./isolation.ts";
import { fileURLToPath } from "node:url";

/** Derive the repair from the running artifact, never the user's current directory. */
export function localUpgradeCommand(packageRoot: URL): string {
  const root = fileURLToPath(packageRoot).replace(/[\\/]$/, "");
  if (existsSync(join(root, ".git"))) {
    const quoted =
      process.platform === "win32"
        ? `"${root.replaceAll('"', '""')}"`
        : `'${root.replaceAll("'", "'\\''")}'`;
    return `cd ${quoted} && bun install --frozen-lockfile && bun run build`;
  }
  return "npm install --global forge-workflow@latest";
}

/** Command hint for the locally installed package; never installs or executes code. */
export function localForgeCommand(args: readonly string[]): string {
  return ["npx", "forge", ...args].join(" ");
}

/** Resolves installed packages only; never installs or runs package code. */
export function createNodeBlockCatalog(
  baseDirectory: string,
  trust: TrustStore = new TrustStore(),
): BlockCatalog {
  return new BlockCatalog(
    {
      open(spec) {
        const path = resolve(baseDirectory, spec);
        if (isAbsolute(spec) || spec.startsWith(".") || existsSync(path))
          return nodeFileCapture.open(path);
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(spec))
          throw new Error("expected a block path or installed package name");
        let parent = resolve(baseDirectory);
        while (true) {
          const root = join(parent, "node_modules", spec);
          if (existsSync(root)) return nodeFileCapture.open(root);
          const next = dirname(parent);
          if (next === parent)
            throw new Error("block package is not installed");
          parent = next;
        }
      },
    },
    trust,
    { isolation: nodeRunIsolation },
  );
}
