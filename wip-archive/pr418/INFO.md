# pr418

- source: (local branch, no worktree)
- branch: pr418
- HEAD: b88a7cf3259583592ee52edd50737f0413c64812
- last commit: 2026-07-19T14:00:07+05:30 "feat(skills): skill chain metadata + generic sub-skill registry (W2)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/pr418 b88a7cf32595   # if the sha still exists locally; else start from origin/master
git am wip-archive/pr418/commits/*.patch
git apply wip-archive/pr418/uncommitted.diff
cp -r wip-archive/pr418/untracked/. .
```
