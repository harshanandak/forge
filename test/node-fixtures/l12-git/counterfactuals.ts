import type { Counterfactual } from "../state/counterfactuals.ts";

export const counterfactuals: readonly Counterfactual[] = [
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "sha: await revision(c, reference)",
    to: 'sha: await revision(c, "HEAD")',
    journey: "base",
    evidence: "default base must be remote default, not parent WIP",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "tree.head === binding.baseSha",
    to: "false",
    journey: "unstarted",
    evidence: "unstarted worktree must survive cleanup",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: 'const common = (await git(c, ["merge-base", target, head])).stdout.trim();',
    to: 'const common = (await git(c, ["rev-parse", `${head}^`])).stdout.trim();',
    journey: "squash",
    evidence:
      "combined patch from multiple commits must count as squash merged",
  },
  ...["squash-dryrun", "squash-no-author"].map((journey) => ({
    kind: "assertion" as const,
    file: "blocks/git/entry.cjs",
    from: 'const common = (await git(c, ["merge-base", target, head])).stdout.trim();',
    to: 'const common = (await git(c, ["merge-base", target, head])).stdout.trim(); await git(c, ["commit-tree", (await git(c, ["rev-parse", `${head}^{tree}`])).stdout.trim(), "-p", common, "-m", "Compare worktree patch"]);',
    journey,
    evidence:
      journey === "squash-dryrun"
        ? "squash dry run must not create Git objects"
        : "squash dry run must not require an author identity",
  })),
  ...["failed-create", "failed-create-process"].map((journey) => ({
    kind: "assertion" as const,
    file: "blocks/git/entry.cjs",
    from: "await reconcile(c, reserved);",
    to: "void 0;",
    journey,
    evidence:
      "failed creation with no Git registration must retire its reservation",
  })),
  ...["reconcile-absent", "reconcile-adopt"].map((journey) => ({
    kind: "assertion" as const,
    file: "blocks/git/entry.cjs",
    from: "accepted = await reconcile(c, record);",
    to: "accepted = record;",
    journey,
    evidence:
      journey === "reconcile-absent"
        ? "absent Git registration must retire crashed creation binding"
        : "matching registered creation must be adopted into active binding",
  })),
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "forge-worktree-create.lock",
    to: "forge-worktree-other.lock",
    journey: "reconcile-live",
    evidence:
      "reconciliation must refuse another invocation's live creation lock",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "`${head}:refs/heads/${remoteBranch}`",
    to: "`${branch}:refs/heads/${remoteBranch}`",
    journey: "push",
    evidence: "Remote head did not read back",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: '(c.services.clone.platform === "win32" || info.executable)',
    to: "true",
    journey: "hook-mode",
    evidence: "POSIX non-executable hook must be inactive",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "hookDependencies(c, command, limit);",
    to: "true;",
    journey: "hook-dependency",
    evidence: "missing dependency must deactivate hook",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: '(await revision(c, "HEAD", absolute)) !== input.expectedHead',
    to: "false",
    journey: "removal-race",
    evidence: "expected SUBJECT_VERSION_CONFLICT",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "if (!samePath(effective, desired, c.services.clone.platform))",
    to: "if (false)",
    journey: "hook-path",
    evidence: "mismatched effective hook path must create no file",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "if (!receipt.created && c.input.adoptExisting !== true)",
    to: "if (!receipt.created)",
    journey: "hook-recovery",
    evidence: "explicit recovery must adopt exact reserved hook bytes",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "retire(c, key(input.path), record.revision)",
    to: 'write(c, key(input.path), { ...binding, status: "removed" }, record.revision)',
    journey: "churn",
    evidence: "successful removal must retire active binding storage",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "reserve(c, key(path), binding, input.expectRevision)",
    to: "write(c, key(path), binding, input.expectRevision)",
    journey: "capacity",
    evidence: "expected LIMIT_EXCEEDED",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "reserve(c, key(path), binding, input.expectRevision)",
    to: "write(c, key(path), binding, input.expectRevision)",
    journey: "capacity-race",
    evidence: "expected REVISION_CONFLICT",
  },
  {
    kind: "assertion",
    file: "blocks/git/entry.cjs",
    from: "`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`",
    to: "`refs/heads/${branch}:refs/remotes/${remote}/${branch}`",
    journey: "rewritten-default",
    evidence: "no-base create must follow a rewritten remote default",
  },
];
