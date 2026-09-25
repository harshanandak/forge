# pr234-local

- source: (local branch, no worktree)
- branch: pr234-local
- HEAD: 616dae445ed042a24e0f4418c76775752f701791
- last commit: 2026-06-25T13:54:46+05:30 "revert(d20): scope default-flip out of #234 — selector-only, default stays beads"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 8
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/pr234-local 616dae445ed0   # if the sha still exists locally; else start from origin/master
git am wip-archive/pr234-local/commits/*.patch
git apply wip-archive/pr234-local/uncommitted.diff
cp -r wip-archive/pr234-local/untracked/. .
```
