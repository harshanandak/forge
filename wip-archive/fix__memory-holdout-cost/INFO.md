# fix/memory-holdout-cost

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/memory-holdout-cost
- branch: fix/memory-holdout-cost
- HEAD: 4335e46808f360db7e0fa1aef4338a73d8ec7548
- last commit: 2026-09-21T00:43:06+05:30 "test: split holdout first-write native timings"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__memory-holdout-cost 4335e46808f3   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__memory-holdout-cost/commits/*.patch
git apply wip-archive/fix__memory-holdout-cost/uncommitted.diff
cp -r wip-archive/fix__memory-holdout-cost/untracked/. .
```
