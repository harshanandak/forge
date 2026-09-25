# fix/fullsuite-worker-weight

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/fullsuite-worker-weight
- branch: fix/fullsuite-worker-weight
- HEAD: b04d9961a8c42f0bf9c225548dd2cd7488b2dcc1
- last commit: 2026-08-27T17:49:01+05:30 "Merge remote-tracking branch 'origin/master' into fix/fullsuite-worker-weight"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__fullsuite-worker-weight b04d9961a8c4   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__fullsuite-worker-weight/commits/*.patch
git apply wip-archive/fix__fullsuite-worker-weight/uncommitted.diff
cp -r wip-archive/fix__fullsuite-worker-weight/untracked/. .
```
