import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const BUN_FILES = ["bun", "bun.exe", "bun.cmd", "bunx", "bunx.exe", "bunx.cmd"];

export function resolveBun(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_execpath;
  if (configured?.match(/bunx?(\.exe)?$/i) && existsSync(configured))
    return resolve(configured);
  const key =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  for (const directory of (env[key] ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const name of process.platform === "win32"
      ? ["bun.exe", "bun"]
      : ["bun"]) {
      const candidate = resolve(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("pack-smoke: bun is not resolvable on PATH");
}

const NODE_NAME = process.platform === "win32" ? "node.exe" : "node";
const COMPLETE_MARKER = "complete";
const sharedExecutables = new Map<string, string>();

/** Folder holding every Bun-free copy of one Node binary, keyed by its path, size and mtime. */
export function bunFreeNodeDirectory(node: string): string {
  const real = realpathSync(node);
  const { size, mtimeMs } = statSync(real);
  const key = createHash("sha256")
    .update(`${real}|${size}|${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "forge-bun-free-node", key);
}

/**
 * A Bun-free Node executable shared by every caller and kept outside any caller's temp root.
 * A runner-side service can open a freshly written executable, so nothing here is ever
 * renamed or deleted. Each creator fills its own subdirectory and writes the completion
 * marker last; callers reuse any subdirectory that has the marker and a matching size.
 */
export function bunFreeNodeExecutable(node: string): string {
  const directory = bunFreeNodeDirectory(node);
  const known = sharedExecutables.get(directory);
  if (known !== undefined) return known;
  const real = realpathSync(node);
  const { size } = statSync(real);
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) {
    const candidate = join(directory, name, NODE_NAME);
    try {
      if (
        existsSync(join(directory, name, COMPLETE_MARKER)) &&
        statSync(candidate).size === size
      ) {
        sharedExecutables.set(directory, candidate);
        return candidate;
      }
    } catch {
      // Not a finished copy of this Node: skip it.
    }
  }
  const own = mkdtempSync(join(directory, "node-"));
  const executable = join(own, NODE_NAME);
  // A Windows executable also searches its own directory; a copy keeps that directory Bun-free.
  if (process.platform === "win32") copyFileSync(real, executable);
  else symlinkSync(real, executable);
  writeFileSync(join(own, COMPLETE_MARKER), "");
  sharedExecutables.set(directory, executable);
  return executable;
}

/** Hide Bun directories, keeping Node available through the shared executable directory. */
export function environmentWithoutBun(
  node: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nodeDirectory = dirname(bunFreeNodeExecutable(node));
  const env: NodeJS.ProcessEnv = { ...environment };
  const key =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[key] = [
    nodeDirectory,
    ...(env[key] ?? "")
      .split(delimiter)
      .filter(
        (dir) =>
          dir !== "" && !BUN_FILES.some((file) => existsSync(join(dir, file))),
      ),
  ].join(delimiter);
  delete env.BUN_INSTALL;
  return env;
}
