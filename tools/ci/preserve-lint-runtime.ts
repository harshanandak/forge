import { appendFileSync, chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV)
  throw new Error("CI runtime paths are required");
const directory = join(process.env.RUNNER_TEMP, "comment-lint");
mkdirSync(directory, { recursive: true });
const target = join(
  directory,
  process.platform === "win32" ? "bun.exe" : "bun",
);
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);
appendFileSync(process.env.GITHUB_ENV, `FORGE_LINT_BUN=${target}\n`);
