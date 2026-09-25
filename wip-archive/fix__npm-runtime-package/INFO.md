# fix/npm-runtime-package

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/beta7-packaging
- branch: fix/npm-runtime-package
- HEAD: e8ac9dfa51a80c8e78b85c4daa3a2cb0ddf66df1
- last commit: 2026-09-11T15:59:09+05:30 "fix: bind validation receipt runtimes"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__npm-runtime-package e8ac9dfa51a8   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__npm-runtime-package/commits/*.patch
git apply wip-archive/fix__npm-runtime-package/uncommitted.diff
cp -r wip-archive/fix__npm-runtime-package/untracked/. .
```
