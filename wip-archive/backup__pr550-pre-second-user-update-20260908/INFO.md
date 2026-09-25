# backup/pr550-pre-second-user-update-20260908

- source: (local branch, no worktree)
- branch: backup/pr550-pre-second-user-update-20260908
- HEAD: 5a1ebb8d68c109b5df04b57358c150414c046f23
- last commit: 2026-09-08T15:42:27+05:30 "fix(worktree): provision workspace dependencies"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- also covers (their unique commits are a subset of this one): backup/pr550-pre-user-rebase-20260908
- excluded: none

## restore

```
git switch -c restore/backup__pr550-pre-second-user-update-20260908 5a1ebb8d68c1   # if the sha still exists locally; else start from origin/master
git am wip-archive/backup__pr550-pre-second-user-update-20260908/commits/*.patch
git apply wip-archive/backup__pr550-pre-second-user-update-20260908/uncommitted.diff
cp -r wip-archive/backup__pr550-pre-second-user-update-20260908/untracked/. .
```
