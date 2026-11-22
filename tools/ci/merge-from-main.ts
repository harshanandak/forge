import { execFileSync } from "node:child_process";
import { lstatSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { gitExecutable } from "../git-executable.ts";

try {
  const { BASE_SHA: base, HEAD_SHA: head, BASE_REF: ref } = process.env;
  if (!base || !head) throw new Error();
  const executable = gitExecutable();
  const options = {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    timeout: 30_000,
  } as const;
  const git = (args: string[], allowStatusOne = false) => {
    try {
      return execFileSync(executable, args, options);
    } catch (error) {
      if (allowStatusOne && (error as { status?: number }).status === 1)
        return null;
      throw error;
    }
  };
  const replacementRefs = git([
    "for-each-ref",
    "--count=1",
    "--format=%(refname)",
    "refs/replace/",
  ])!.trim();
  const graftPath = git(["rev-parse", "--git-path", "info/grafts"])!.trim();
  let hasGrafts = true;
  try {
    lstatSync(resolve(graftPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hasGrafts = false;
  }
  if (replacementRefs)
    writeSync(
      2,
      "::error::This checkout has Git replacement refs under refs/replace/. Delete them (git replace -d) or use a fresh checkout.\n",
    );
  if (hasGrafts)
    writeSync(
      2,
      "::error::This checkout has a Git graft file (info/grafts). Delete it or use a fresh checkout.\n",
    );
  if (replacementRefs || hasGrafts) process.exit(1);
  for (const sha of [base, head]) git(["cat-file", "-e", `${sha}^{commit}`]);
  if (git(["rev-parse", "--is-shallow-repository"])!.trim() !== "false")
    throw new Error();
  const range = `${base}..${head}`;
  const merges = git(["rev-list", "--merges", "--parents", range])!.trim();
  const remoteRef = `refs/remotes/origin/${ref}`;
  const tip = ref && git(["rev-parse", "--verify", "--quiet", remoteRef], true);
  const targets = tip ? [base, tip.trim()] : [base];
  const messages = merges
    ? git(["log", "-z", "--format=%H%x00%B", range])!.split("\0")
    : [];
  const reason =
    /(?:^|\n)Merge-reason: (?:conflict|queue-rejection)(?: ([0-9a-f]{7,40}))?\r?(?=\n|$)/g;
  const recorded = new Set<string>();
  for (let i = 0; i + 1 < messages.length; i += 2)
    for (const match of messages[i + 1]!.matchAll(reason))
      recorded.add(match[1] ?? messages[i]!);

  const ancestor = (a: string, b: string) =>
    git(["merge-base", "--is-ancestor", a, b], true) !== null;
  for (const line of merges.split("\n").filter(Boolean)) {
    const [sha, ...parents] = line.split(" ");
    const fromBase = parents.some(
      (parent) =>
        targets.some((target) => ancestor(parent, target)) &&
        parents.some((other) => other !== parent && !ancestor(parent, other)),
    );
    if (!fromBase || [...recorded].some((prefix) => sha!.startsWith(prefix)))
      continue;
    console.error(
      `::error::Merge commit ${sha} brings main into this PR branch without a recorded reason. Merge main only for a merge conflict or a merge queue rejection. To record one, push a commit whose message has the line "Merge-reason: conflict ${sha}" or "Merge-reason: queue-rejection ${sha}" (git commit --allow-empty -m "ci: record merge reason" -m "Merge-reason: conflict ${sha}").`,
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    "::error::Cannot inspect PR merge commits. Check BASE_SHA and HEAD_SHA and ensure Git can read the history.",
  );
  process.exitCode = 1;
}
