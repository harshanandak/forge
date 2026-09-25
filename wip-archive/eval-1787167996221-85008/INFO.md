# eval-1787167996221-85008

- source: (local branch, no worktree)
- branch: eval-1787167996221-85008
- HEAD: 5b3981731cbb8fa92748fcfb97d4f44333979ef2
- last commit: 2026-08-20T00:55:57+05:30 "feat(shepherd): add dormant owner authority foundation"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/eval-1787167996221-85008 5b3981731cbb   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1787167996221-85008/commits/*.patch
git apply wip-archive/eval-1787167996221-85008/uncommitted.diff
cp -r wip-archive/eval-1787167996221-85008/untracked/. .
```
