# feat/gitspawn

- source: (local branch, no worktree)
- branch: feat/gitspawn
- HEAD: a2f2cad0083b326d741170e2de1f25b753937453
- last commit: 2026-07-12T15:32:52+05:30 "fix: bound the 2 remaining unbounded git-common-dir spawns (6ca8c00b)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__gitspawn a2f2cad0083b   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__gitspawn/commits/*.patch
git apply wip-archive/feat__gitspawn/uncommitted.diff
cp -r wip-archive/feat__gitspawn/untracked/. .
```
