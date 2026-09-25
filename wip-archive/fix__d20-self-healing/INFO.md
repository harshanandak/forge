# fix/d20-self-healing

- source: (local branch, no worktree)
- branch: fix/d20-self-healing
- HEAD: 1c1992297527ef4b58a3ca4ed6f96241c0711493
- last commit: 2026-07-26T12:23:28+05:30 "fix(hooks): defer the D20 auto-heal when the index is partially staged"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__d20-self-healing 1c1992297527   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__d20-self-healing/commits/*.patch
git apply wip-archive/fix__d20-self-healing/uncommitted.diff
cp -r wip-archive/fix__d20-self-healing/untracked/. .
```
