# fix/validate-capture-limits

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/validate-capture-limits
- branch: fix/validate-capture-limits
- HEAD: df5f44e5fabe4c7645317685923db8b5e382aa46
- last commit: 2026-09-09T03:09:00+05:30 "fix(validate): bound full-suite capture with measured headroom"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__validate-capture-limits df5f44e5fabe   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__validate-capture-limits/commits/*.patch
git apply wip-archive/fix__validate-capture-limits/uncommitted.diff
cp -r wip-archive/fix__validate-capture-limits/untracked/. .
```
