# codex/pr1-risk-selector

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr1-risk-selector
- branch: codex/pr1-risk-selector
- HEAD: 3cac083a074d2024209508d417fa9159726999f0
- last commit: 2026-08-09T17:32:07+05:30 "chore(validation): drop hook audit refresh"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 22
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr1-risk-selector 3cac083a074d   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr1-risk-selector/commits/*.patch
git apply wip-archive/codex__pr1-risk-selector/uncommitted.diff
cp -r wip-archive/codex__pr1-risk-selector/untracked/. .
```
