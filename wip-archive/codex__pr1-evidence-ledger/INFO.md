# codex/pr1-evidence-ledger

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr1-validation-lanes
- branch: codex/pr1-evidence-ledger
- HEAD: 946c97db50b7366126d5396f5c4e4edf8adc6282
- last commit: 2026-08-09T18:34:52+05:30 "fix(validation): reject noncanonical array inputs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 27
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr1-evidence-ledger 946c97db50b7   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr1-evidence-ledger/commits/*.patch
git apply wip-archive/codex__pr1-evidence-ledger/uncommitted.diff
cp -r wip-archive/codex__pr1-evidence-ledger/untracked/. .
```
