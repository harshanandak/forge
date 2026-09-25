# eval-1785053332518-61724

- source: (local branch, no worktree)
- branch: eval-1785053332518-61724
- HEAD: de8cffd3ab8230bfd60fa23e53107cf343577ee0
- last commit: 2026-07-26T13:15:19+05:30 "fix(setup): detect a pre-existing pre-commit TDD gate and defer instead of stacking"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/eval-1785053332518-61724 de8cffd3ab82   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1785053332518-61724/commits/*.patch
git apply wip-archive/eval-1785053332518-61724/uncommitted.diff
cp -r wip-archive/eval-1785053332518-61724/untracked/. .
```
