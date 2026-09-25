# fix/base-freshness-gate

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/base-freshness-gate
- branch: fix/base-freshness-gate
- HEAD: 97736a9deeeca1d27c05de8361b0111fecdff45b
- last commit: 2026-08-19T17:11:44+05:30 "fix: enforce base freshness across Forge workflows"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__base-freshness-gate 97736a9deeec   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__base-freshness-gate/commits/*.patch
git apply wip-archive/fix__base-freshness-gate/uncommitted.diff
cp -r wip-archive/fix__base-freshness-gate/untracked/. .
```
