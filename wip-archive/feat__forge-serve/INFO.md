# feat/forge-serve

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/forge-serve
- branch: feat/forge-serve
- HEAD: cc133504ab39de98521a0006b6bb7672774b29d2
- last commit: 2026-07-13T18:55:07+05:30 "fix(serve): CodeRabbit — spawn error listener, async clipboard, stale doc"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: 2 entries (2 untracked); untracked copied: 2
- excluded: none

## restore

```
git switch -c restore/feat__forge-serve cc133504ab39   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__forge-serve/commits/*.patch
git apply wip-archive/feat__forge-serve/uncommitted.diff
cp -r wip-archive/feat__forge-serve/untracked/. .
```
