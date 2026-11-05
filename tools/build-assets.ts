import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { writeGenerated } from "./gen/write.ts";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

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
copyJson(join(root, "src"));
copyJson(join(root, "schemas"));
const git = (args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};
function identity(): { commit: string; dirty: boolean } {
  try {
    const top = git(["rev-parse", "--show-toplevel"]);
    if (relative(realpathSync(root), realpathSync(top)) === "")
      return {
        commit: git(["rev-parse", "HEAD"]),
        dirty: git(["status", "--porcelain"]).length > 0,
      };
  } catch {
    // Archives and machines without Git have no verifiable source identity.
  }
  return { commit: "unknown", dirty: false };
}
writeGenerated(
  join(root, "dist/build.json"),
  JSON.stringify({
    version: pkg.version,
    ...identity(),
  }) + "\n",
);
