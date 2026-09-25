# fix/validation-fixture-scope

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/validation-fixture-scope
- branch: fix/validation-fixture-scope
- HEAD: 05f27c8415a26900f22b1742548f10d72fa187c3
- last commit: 2026-09-19T14:12:37+05:30 "fix(validate): isolate failed-child fixture"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__validation-fixture-scope 05f27c8415a2   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__validation-fixture-scope/commits/*.patch
git apply wip-archive/fix__validation-fixture-scope/uncommitted.diff
cp -r wip-archive/fix__validation-fixture-scope/untracked/. .
```
