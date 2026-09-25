# fix/validation-timeout-evidence

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/validation-timeout-evidence
- branch: fix/validation-timeout-evidence
- HEAD: 189907ccaa5d40753b662931a18e1d9ccff4dff9
- last commit: 2026-09-25T11:39:19+05:30 "docs: record budget-four validation failure"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__validation-timeout-evidence 189907ccaa5d   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__validation-timeout-evidence/commits/*.patch
git apply wip-archive/fix__validation-timeout-evidence/uncommitted.diff
cp -r wip-archive/fix__validation-timeout-evidence/untracked/. .
```
