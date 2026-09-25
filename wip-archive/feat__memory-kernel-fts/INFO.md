# feat/memory-kernel-fts

- source: (local branch, no worktree)
- branch: feat/memory-kernel-fts
- HEAD: ac5bfe405fdc940cc8ddd2c3d1f8ca4aa8419dec
- last commit: 2026-07-10T16:26:46+05:30 "Merge remote-tracking branch 'origin/feat/memory-kernel-fts' into feat/memory-kernel-fts"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: none
- also covers (their unique commits are a subset of this one): eval-1783605661762-38688, eval-1783602512369-37504
- excluded: none

## restore

```
git switch -c restore/feat__memory-kernel-fts ac5bfe405fdc   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__memory-kernel-fts/commits/*.patch
git apply wip-archive/feat__memory-kernel-fts/uncommitted.diff
cp -r wip-archive/feat__memory-kernel-fts/untracked/. .
```
