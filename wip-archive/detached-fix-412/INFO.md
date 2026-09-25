# detached-fix-412

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/fix-412
- branch: (detached)
- HEAD: 02da6b9e907efb1267848d4925817e06aa406135
- last commit: 2026-07-16T19:34:55+05:30 "test(grounding): assert kernel-driver close/ownership invariant"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 1 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/detached-fix-412 02da6b9e907e   # if the sha still exists locally; else start from origin/master
git am wip-archive/detached-fix-412/commits/*.patch
git apply wip-archive/detached-fix-412/uncommitted.diff
cp -r wip-archive/detached-fix-412/untracked/. .
```
