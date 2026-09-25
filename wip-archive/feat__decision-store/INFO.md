# feat/decision-store

- source: (local branch, no worktree)
- branch: feat/decision-store
- HEAD: 9ec09dee70cfd96bc352be37402b1ec78ad4d77e
- last commit: 2026-07-10T16:46:04+05:30 "Merge remote-tracking branch 'origin/master' into feat/decision-store"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__decision-store 9ec09dee70cf   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__decision-store/commits/*.patch
git apply wip-archive/feat__decision-store/uncommitted.diff
cp -r wip-archive/feat__decision-store/untracked/. .
```
