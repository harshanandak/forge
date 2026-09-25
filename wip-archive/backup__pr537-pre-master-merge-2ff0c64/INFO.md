# backup/pr537-pre-master-merge-2ff0c64

- source: (local branch, no worktree)
- branch: backup/pr537-pre-master-merge-2ff0c64
- HEAD: 2ff0c64e6224fca115d79592295e2cab19f76372
- last commit: 2026-08-19T04:29:27+05:30 "fix(shepherd): defer terminal receipt until cleanup"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 29
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/backup__pr537-pre-master-merge-2ff0c64 2ff0c64e6224   # if the sha still exists locally; else start from origin/master
git am wip-archive/backup__pr537-pre-master-merge-2ff0c64/commits/*.patch
git apply wip-archive/backup__pr537-pre-master-merge-2ff0c64/uncommitted.diff
cp -r wip-archive/backup__pr537-pre-master-merge-2ff0c64/untracked/. .
```
