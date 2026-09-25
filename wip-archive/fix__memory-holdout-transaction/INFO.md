# fix/memory-holdout-transaction

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/memory-holdout-transaction
- branch: fix/memory-holdout-transaction
- HEAD: de3e383bf06aa78c030fa0f4477315c401a47b94
- last commit: 2026-09-11T01:15:24+05:30 "fix(kernel): preserve exact claim repair file identity (#556)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 2 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/fix__memory-holdout-transaction de3e383bf06a   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__memory-holdout-transaction/commits/*.patch
git apply wip-archive/fix__memory-holdout-transaction/uncommitted.diff
cp -r wip-archive/fix__memory-holdout-transaction/untracked/. .
```
