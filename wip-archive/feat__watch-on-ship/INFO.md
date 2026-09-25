# feat/watch-on-ship

- source: (local branch, no worktree)
- branch: feat/watch-on-ship
- HEAD: 5752b2335d8d071735a42c112c1768054eb147e2
- last commit: 2026-07-16T18:58:24+05:30 "Merge remote-tracking branch 'origin/feat/watch-on-ship' into feat/watch-on-ship"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__watch-on-ship 5752b2335d8d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__watch-on-ship/commits/*.patch
git apply wip-archive/feat__watch-on-ship/uncommitted.diff
cp -r wip-archive/feat__watch-on-ship/untracked/. .
```
