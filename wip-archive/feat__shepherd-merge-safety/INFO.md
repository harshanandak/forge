# feat/shepherd-merge-safety

- source: (local branch, no worktree)
- branch: feat/shepherd-merge-safety
- HEAD: 03de08e522f2df6e10528e780b1b530aa2b043e3
- last commit: 2026-07-13T00:50:26+05:30 "test(shepherd): assert readReviews pagination forwards the cursor"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__shepherd-merge-safety 03de08e522f2   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__shepherd-merge-safety/commits/*.patch
git apply wip-archive/feat__shepherd-merge-safety/uncommitted.diff
cp -r wip-archive/feat__shepherd-merge-safety/untracked/. .
```
