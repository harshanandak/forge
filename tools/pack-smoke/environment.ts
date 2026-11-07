import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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

/**
 * One Bun-free Node executable per Node binary, shared by every caller and kept
 * outside any caller's temp root. A runner-side service can open a freshly
 * written executable, so nothing here is ever deleted by a test.
 */
export function bunFreeNodeExecutable(node: string): string {
  const real = realpathSync(node);
  const { size, mtimeMs } = statSync(real);
  const key = createHash("sha256")
    .update(`${real}|${size}|${mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
  const directory = join(tmpdir(), "forge-bun-free-node", key);
  const executable = join(
    directory,
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (existsSync(executable)) return executable;
  mkdirSync(directory, { recursive: true });
  // Write under a unique name, then rename, so a concurrent caller never sees a partial file.
  const partial = `${executable}.${process.pid}.${randomUUID()}.tmp`;
  // A Windows executable also searches its own directory; a copy keeps that directory Bun-free.
  if (process.platform === "win32") copyFileSync(real, partial);
  else symlinkSync(real, partial);
  try {
    renameSync(partial, executable);
  } catch (error) {
    // Another caller won the race: reuse its executable.
    if (!existsSync(executable)) throw error;
    rmSync(partial, { force: true });
  }
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
