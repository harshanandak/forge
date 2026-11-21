import { execFileSync } from "node:child_process";
import { gitExecutable } from "../git-executable.ts";

export type Scope = "docs" | "full";

export function scopeOf(paths: readonly string[]): Scope {
  return paths.length > 0 &&
    paths.every(
      (path) =>
        path !== "docs/writing-a-block.md" &&
        (/^docs\/.+/.test(path) ||
          path === "AGENTS.md" ||
          path === "CODING_STANDARDS.md" ||
          path === "migrations/README.md"),
    )
    ? "docs"
    : "full";
}

export function changedPaths(
  base: string,
  head: string,
  cwd: string,
): string[] {
  const git = gitExecutable();
  const mergeBase = execFileSync(git, ["merge-base", base, head], {
    shell: false,
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  return execFileSync(
    git,
    ["diff", "--no-renames", "--name-only", "-z", mergeBase, head],
    {
      shell: false,
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    },
  )
    .split("\0")
    .filter((path) => path !== "");
}

if (import.meta.main) {
  const { EVENT, BASE_SHA, HEAD_SHA, COMMENT_GUARD_PATHS } = process.env;
  const pullRequest = EVENT === "pull_request";
  const guardPaths =
    COMMENT_GUARD_PATHS?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (pullRequest && (!BASE_SHA || !HEAD_SHA || guardPaths.length === 0))
    throw new Error(
      "pull_request requires BASE_SHA, HEAD_SHA and COMMENT_GUARD_PATHS",
    );
  const paths = pullRequest
    ? changedPaths(BASE_SHA!, HEAD_SHA!, process.cwd())
    : [];
  const commentGuard = paths.some((path) =>
    guardPaths.some((guard) => path === guard || path.startsWith(`${guard}/`)),
  );
  console.log(`scope=${pullRequest ? scopeOf(paths) : "full"}`);
  console.log(`comment_guard=${commentGuard}`);
}
