# feat/memory-recall-windows

- source: (local branch, no worktree)
- branch: feat/memory-recall-windows
- HEAD: 79e76ff55067dff99029e960752b886a3fbf2c36
- last commit: 2026-08-06T15:49:53+05:30 "fix(test): preserve holdout fixture errors"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__memory-recall-windows 79e76ff55067   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__memory-recall-windows/commits/*.patch
git apply wip-archive/feat__memory-recall-windows/uncommitted.diff
cp -r wip-archive/feat__memory-recall-windows/untracked/. .
```
