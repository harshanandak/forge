# fix/push-resource-aware-docs

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/optional-skipped-merge/.worktrees/push-resource-aware-docs
- branch: fix/push-resource-aware-docs
- HEAD: 76a730435ff7cb867ebdcb6a0b607ec38064e43f
- last commit: 2026-08-30T18:07:46+05:30 "fix: preserve Forge push passthrough boundary"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__push-resource-aware-docs 76a730435ff7   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__push-resource-aware-docs/commits/*.patch
git apply wip-archive/fix__push-resource-aware-docs/uncommitted.diff
cp -r wip-archive/fix__push-resource-aware-docs/untracked/. .
```
