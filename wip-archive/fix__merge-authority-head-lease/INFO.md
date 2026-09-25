# fix/merge-authority-head-lease

- source: (local branch, no worktree)
- branch: fix/merge-authority-head-lease
- HEAD: 4ed3ed00182e5c188a1cd53f0326dee5154292a5
- last commit: 2026-08-02T17:46:12+05:30 "test(merge): provide settled activity fixture"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 10
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__merge-authority-head-lease 4ed3ed00182e   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__merge-authority-head-lease/commits/*.patch
git apply wip-archive/fix__merge-authority-head-lease/uncommitted.diff
cp -r wip-archive/fix__merge-authority-head-lease/untracked/. .
```
