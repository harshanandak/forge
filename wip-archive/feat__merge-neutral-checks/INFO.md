# feat/merge-neutral-checks

- source: (local branch, no worktree)
- branch: feat/merge-neutral-checks
- HEAD: c36609d409f1ae780f454c2f1afc258df5ac0252
- last commit: 2026-08-03T16:56:08+05:30 "fix(merge): clarify terminal evidence diagnostic"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__merge-neutral-checks c36609d409f1   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__merge-neutral-checks/commits/*.patch
git apply wip-archive/feat__merge-neutral-checks/uncommitted.diff
cp -r wip-archive/feat__merge-neutral-checks/untracked/. .
```
