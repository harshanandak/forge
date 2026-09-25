# fix/preserve-claude-import

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/s0-preserve-claude-import
- branch: fix/preserve-claude-import
- HEAD: 9f723c0aa5ec217d661d1d9391396c7bc259cb30
- last commit: 2026-07-29T23:51:43+05:30 "fix: report exhausted symlink retries"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__preserve-claude-import 9f723c0aa5ec   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__preserve-claude-import/commits/*.patch
git apply wip-archive/fix__preserve-claude-import/uncommitted.diff
cp -r wip-archive/fix__preserve-claude-import/untracked/. .
```
