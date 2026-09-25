# recovery/delivery-ci-65aa26ba

- source: (local branch, no worktree)
- branch: recovery/delivery-ci-65aa26ba
- HEAD: 65aa26ba9fb05908e496f13f6db1619d89aa309e
- last commit: 2026-09-18T16:39:49+05:30 "fix(ci): propagate affected edge test failures"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/recovery__delivery-ci-65aa26ba 65aa26ba9fb0   # if the sha still exists locally; else start from origin/master
git am wip-archive/recovery__delivery-ci-65aa26ba/commits/*.patch
git apply wip-archive/recovery__delivery-ci-65aa26ba/uncommitted.diff
cp -r wip-archive/recovery__delivery-ci-65aa26ba/untracked/. .
```
