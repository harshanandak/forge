# fix/orientation-front-door

- source: (local branch, no worktree)
- branch: fix/orientation-front-door
- HEAD: f60ca67a6af5079b3877017b75068ae679573482
- last commit: 2026-07-06T07:06:08+05:30 "chore(release): regenerate D20 bd-audit artifact for shifted line numbers"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__orientation-front-door f60ca67a6af5   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__orientation-front-door/commits/*.patch
git apply wip-archive/fix__orientation-front-door/uncommitted.diff
cp -r wip-archive/fix__orientation-front-door/untracked/. .
```
