# fix/shepherd-merge-evidence

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/shepherd-merge-evidence
- branch: fix/shepherd-merge-evidence
- HEAD: 3d7142d0a6350e7d39b99ba8568755cb1d2f896a
- last commit: 2026-09-24T17:01:08+05:30 "fix(shepherd): preserve actionable comment evidence"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__shepherd-merge-evidence 3d7142d0a635   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__shepherd-merge-evidence/commits/*.patch
git apply wip-archive/fix__shepherd-merge-evidence/uncommitted.diff
cp -r wip-archive/fix__shepherd-merge-evidence/untracked/. .
```
