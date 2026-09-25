# docs/forge-research-archive

- source: (local branch, no worktree)
- branch: docs/forge-research-archive
- HEAD: 21f9328542e8a11b25622bcb10cf284e9ee62773
- last commit: 2026-09-12T15:35:22+05:30 "fix(docs): address archive review findings"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/docs__forge-research-archive 21f9328542e8   # if the sha still exists locally; else start from origin/master
git am wip-archive/docs__forge-research-archive/commits/*.patch
git apply wip-archive/docs__forge-research-archive/uncommitted.diff
cp -r wip-archive/docs__forge-research-archive/untracked/. .
```
