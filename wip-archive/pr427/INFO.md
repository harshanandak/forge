# pr427

- source: (local branch, no worktree)
- branch: pr427
- HEAD: ee87308051745e03e634d6639154bb5373bd160a
- last commit: 2026-07-20T16:19:53+05:30 "feat(pr-monitor): W-S4b reconcile executor + daemon + dispatch trigger"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/pr427 ee8730805174   # if the sha still exists locally; else start from origin/master
git am wip-archive/pr427/commits/*.patch
git apply wip-archive/pr427/uncommitted.diff
cp -r wip-archive/pr427/untracked/. .
```
