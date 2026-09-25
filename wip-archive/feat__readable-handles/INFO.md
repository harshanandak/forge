# feat/readable-handles

- source: (local branch, no worktree)
- branch: feat/readable-handles
- HEAD: eb16a697d2b1447df7afe0605326a3a462df7d7d
- last commit: 2026-07-09T10:59:50+05:30 "fix(resolver): handle whose slug is all hex letters still resolves (CodeRabbit #335)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__readable-handles eb16a697d2b1   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__readable-handles/commits/*.patch
git apply wip-archive/feat__readable-handles/uncommitted.diff
cp -r wip-archive/feat__readable-handles/untracked/. .
```
