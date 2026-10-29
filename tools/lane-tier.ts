import { spawnSync } from "node:child_process";

export type ReviewTier = "light" | "code" | "security";
export type LaneTier = { tier: ReviewTier; because: string; reviews: string[] };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Policy globs are repo-relative inclusion patterns: *, **, ?, [] and {}.
// Reject malformed groups explicitly; the glob matcher accepts some as literals.
function validGlob(pattern: string) {
  if (
    !pattern.trim() ||
    /^[!/]|^[a-z]:/i.test(pattern) ||
    /[\\\0]/.test(pattern) ||
    pattern.split("/").includes("..")
  )
    return false;
  let bracket = false,
    braces = 0;
  for (const char of pattern) {
    if (bracket) {
      if (char === "]") bracket = false;
    } else if (char === "[") bracket = true;
    else if (char === "]") return false;
    else if (char === "{") braces++;
    else if (char === "}" && --braces < 0) return false;
  }
  return !bracket && braces === 0 && !pattern.includes("[]");
}
function git(worktree: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: worktree,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error("git command failed while computing lane tier");
  return result.stdout;
}
export function laneTier(worktree: string, config: unknown): LaneTier {
  const tiers: unknown =
    object(config) && object(config.values) && object(config.values.lanes)
      ? config.values.lanes.tiers
      : undefined;
  if (
    !object(tiers) ||
    Object.keys(tiers).some((key) => !["security", "code"].includes(key))
  )
    throw new Error(
      "values.lanes.tiers requires only security and code glob arrays",
    );
  const patterns = { security: [] as Bun.Glob[], code: [] as Bun.Glob[] };
  for (const key of ["security", "code"] as const) {
    const globs = tiers[key];
    if (!Array.isArray(globs))
      throw new Error(`values.lanes.tiers.${key} must be a glob array`);
    for (const glob of globs) {
      if (typeof glob !== "string" || !validGlob(glob))
        throw new Error(`invalid values.lanes.tiers.${key} glob`);
      patterns[key].push(new Bun.Glob(glob));
    }
  }
  const base = git(worktree, ["merge-base", "origin/main", "HEAD"]).trim();
  const files = git(worktree, ["diff", "--name-only", "-z", `${base}...HEAD`])
    .split("\0")
    .filter(Boolean);
  for (const tier of ["security", "code"] as const) {
    const because = files.find((file) =>
      patterns[tier].some((pattern) => pattern.match(file)),
    );
    if (because)
      return {
        tier,
        because,
        reviews: [
          "tester",
          "reviewer",
          ...(tier === "security" ? ["security-reviewer"] : []),
          "github-codex",
        ],
      };
  }
  return {
    tier: "light",
    because: files[0] ?? "no changes",
    reviews: ["tester", "github-codex"],
  };
}
