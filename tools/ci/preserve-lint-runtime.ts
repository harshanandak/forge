import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import lintVersion from "../bun-lint-version.json" with { type: "json" };
import { requireLintRuntime } from "../bun-builtin.ts";

if (
  !process.env.RUNNER_TEMP ||
  !process.env.GITHUB_ENV ||
  !process.env.GITHUB_OUTPUT ||
  !process.env.GITHUB_PATH
)
  throw new Error("CI runtime paths are required");
const platform = process.platform === "win32" ? "windows" : process.platform;
const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
const name = `@oven/bun-${platform}-${architecture}`;
if (process.argv[2] === "prepare") {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `package=${name}@${lintVersion.package}\n`,
  );
} else {
  const executable = join(
    process.env.RUNNER_TEMP,
    "comment-lint",
    "node_modules",
    name,
    "bin",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  requireLintRuntime(executable);
  appendFileSync(process.env.GITHUB_ENV, `FORGE_LINT_BUN=${executable}\n`);
  appendFileSync(process.env.GITHUB_PATH, dirname(executable) + "\n");
}
