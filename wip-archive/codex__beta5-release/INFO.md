# codex/beta5-release

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/beta5-release
- branch: codex/beta5-release
- HEAD: 4ebb97728a6cc5d6bce5a04efd97334e27c732ea
- last commit: 2026-08-08T18:44:46+05:30 "docs: normalize beta5 plan endings"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__beta5-release 4ebb97728a6c   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__beta5-release/commits/*.patch
git apply wip-archive/codex__beta5-release/uncommitted.diff
cp -r wip-archive/codex__beta5-release/untracked/. .
```
