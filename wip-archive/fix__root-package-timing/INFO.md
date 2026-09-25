# fix/root-package-timing

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/root-package-timing
- branch: fix/root-package-timing
- HEAD: 22d7bb7d4974f6e7e1030cc23398ca3ba92fc75e
- last commit: 2026-09-19T19:19:57+05:30 "test(smart-status): streamline CRLF fixture"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: 26 entries (25 untracked); untracked copied: 0
- also covers (their unique commits are a subset of this one): recovery/root-package-timing-before-combined-20260919, fix/workflow-hook-timing
- excluded: none

## restore

```
git switch -c restore/fix__root-package-timing 22d7bb7d4974   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__root-package-timing/commits/*.patch
git apply wip-archive/fix__root-package-timing/uncommitted.diff
cp -r wip-archive/fix__root-package-timing/untracked/. .
```
