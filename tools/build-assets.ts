import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeGenerated } from "./gen/write.ts";
import { execFileSync } from "node:child_process";
import { gitExecutable } from "./git-executable.ts";

const root = resolve(import.meta.dirname, "..");
function copyJson(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) copyJson(path);
    else if (entry.name.endsWith(".json"))
      writeGenerated(
        join(root, "dist", relative(root, path)),
        readFileSync(path, "utf8"),
      );
  }
}
const git = (args: string[]): string =>
  execFileSync(gitExecutable(), args, {
    shell: false,
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
export function buildIdentity(
  root: string,
  git: (args: string[]) => string,
): { commit: string; dirty: boolean } {
  // Archives and machines without Git have no verifiable source identity.
  if (!existsSync(join(root, ".git")))
    return { commit: "unknown", dirty: false };
  const run = (args: string[]): string => {
    try {
      return git(args);
    } catch (error) {
      throw new Error(
        `build identity: git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  return {
    commit: run(["rev-parse", "HEAD"]),
    dirty: run(["status", "--porcelain"]).length > 0,
  };
}
if (import.meta.main) {
  copyJson(join(root, "src"));
  copyJson(join(root, "schemas"));
  writeGenerated(
    join(root, "dist/build.json"),
    JSON.stringify({
      version: pkg.version,
      ...buildIdentity(root, git),
      runId: process.env.GITHUB_RUN_ID ?? null,
    }) + "\n",
  );
}
