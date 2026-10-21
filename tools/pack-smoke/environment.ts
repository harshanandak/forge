import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

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

/** Hide Bun directories, keeping Node available through a private executable directory. */
export function environmentWithoutBun(
  nodeDirectory: string,
  node: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  mkdirSync(nodeDirectory);
  const executable = join(
    nodeDirectory,
    process.platform === "win32" ? "node.exe" : "node",
  );
  // A Windows executable also searches its own directory; a copy keeps that directory Bun-free.
  if (process.platform === "win32") copyFileSync(node, executable);
  else symlinkSync(resolve(node), executable);
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
