# fix/full-suite-shard-diagnostics

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/full-suite-shard-diagnostics
- branch: fix/full-suite-shard-diagnostics
- HEAD: 4241dcb0c02c2c7ccf451cc4d70a01671f232b08
- last commit: 2026-08-30T14:41:14+05:30 "fix(test): retain shard exit diagnostics"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/fix/full-suite-shard-diagnostics; not patch-archived)
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__full-suite-shard-diagnostics 4241dcb0c02c   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__full-suite-shard-diagnostics/commits/*.patch
git apply wip-archive/fix__full-suite-shard-diagnostics/uncommitted.diff
cp -r wip-archive/fix__full-suite-shard-diagnostics/untracked/. .
```
