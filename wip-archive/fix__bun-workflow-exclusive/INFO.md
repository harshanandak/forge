# fix/bun-workflow-exclusive

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/bun-workflow-exclusive
- branch: fix/bun-workflow-exclusive
- HEAD: bafc5009307b015413cff92ae230981a7a86ad4e
- last commit: 2026-09-10T15:48:53+05:30 "docs: record full-suite serialization fix"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__bun-workflow-exclusive bafc5009307b   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__bun-workflow-exclusive/commits/*.patch
git apply wip-archive/fix__bun-workflow-exclusive/uncommitted.diff
cp -r wip-archive/fix__bun-workflow-exclusive/untracked/. .
```
