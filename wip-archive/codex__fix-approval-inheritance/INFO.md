# codex/fix-approval-inheritance

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/codex-approval-inheritance
- branch: codex/fix-approval-inheritance
- HEAD: 4ce100e3eac790eb90c96d919dbf7e7bb7fc72e5
- last commit: 2026-08-05T19:57:07+05:30 "fix(test): rethrow unexpected git tracking errors"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__fix-approval-inheritance 4ce100e3eac7   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__fix-approval-inheritance/commits/*.patch
git apply wip-archive/codex__fix-approval-inheritance/uncommitted.diff
cp -r wip-archive/codex__fix-approval-inheritance/untracked/. .
```
