import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BlockCatalog } from "../../core/runtime/catalog.ts";
import { TrustStore, type OwnerApproval } from "../../core/trust/index.ts";
import type { InvocationRequest } from "../../generated/types.ts";
import { nodeFileCapture } from "./capture.ts";
import { nodeRunIsolation } from "./isolation.ts";
import { fileURLToPath } from "node:url";

/** Derive the repair from the running artifact, never the user's current directory. */
export function localUpgradeCommand(
  packageRoot: URL,
  version: string,
): { cwd: string | null; command: string } {
  const root = fileURLToPath(packageRoot).replace(/[\\/]$/, "");
  if (existsSync(join(root, ".git"))) {
    return {
      cwd: root,
      command: "bun install --frozen-lockfile && bun run build",
    };
  }
  const target = `forge-workflow@${version.includes("-") ? "beta" : "latest"}`;
  const modules = dirname(root);
  if (
    basename(modules) === "node_modules" &&
    dirname(modules).split(/[\\/]/).at(-1) !== "lib" &&
    !existsSync(join(dirname(modules), "forge.cmd"))
  )
    return {
      cwd: dirname(modules),
      command: `npm install --save-dev ${target}`,
    };
  return { cwd: null, command: `npm install --global ${target}` };
}

/** Command hint for the locally installed package; never installs or executes code. */
export function localForgeCommand(args: readonly string[]): string {
  return ["npx", "forge", ...args].join(" ");
}

/** Resolves installed packages only; never installs or runs package code. */
export function createNodeBlockCatalog(
  baseDirectory: string,
  trust: TrustStore = new TrustStore(),
  approval?: (request: InvocationRequest) => OwnerApproval,
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
    undefined,
    approval,
  );
}
