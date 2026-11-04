import { execFileSync } from "node:child_process";

export type Scope = "docs" | "full";

export function scopeOf(paths: readonly string[]): Scope {
  return paths.every((path) => /^(docs\/|LICENSE$|.*\.md$|$)/.test(path))
    ? "docs"
    : "full";
}

export function changedPaths(
  base: string,
  head: string,
  cwd: string,
): string[] {
  return execFileSync("git", ["diff", "--name-only", "-z", base, head], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  })
    .split("\0")
    .filter((path) => path !== "");
}

if (import.meta.main) {
  const { EVENT, BASE_SHA, HEAD_SHA } = process.env;
  if (EVENT === "pull_request" && (!BASE_SHA || !HEAD_SHA))
    throw new Error("pull_request requires BASE_SHA and HEAD_SHA");
  const scope =
    EVENT === "pull_request"
      ? scopeOf(changedPaths(BASE_SHA!, HEAD_SHA!, process.cwd()))
      : "full";
  console.log(`scope=${scope}`);
}
