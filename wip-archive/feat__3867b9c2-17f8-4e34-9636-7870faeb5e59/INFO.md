# feat/3867b9c2-17f8-4e34-9636-7870faeb5e59

- source: (local branch, no worktree)
- branch: feat/3867b9c2-17f8-4e34-9636-7870faeb5e59
- HEAD: 2a6f505c01f9c8df0705aa2bc59f012c0421234e
- last commit: 2026-07-15T23:26:02+05:30 "fix(memory): address CodeRabbit review on #397 (capture ownership + note cap)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__3867b9c2-17f8-4e34-9636-7870faeb5e59 2a6f505c01f9   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__3867b9c2-17f8-4e34-9636-7870faeb5e59/commits/*.patch
git apply wip-archive/feat__3867b9c2-17f8-4e34-9636-7870faeb5e59/uncommitted.diff
cp -r wip-archive/feat__3867b9c2-17f8-4e34-9636-7870faeb5e59/untracked/. .
```
