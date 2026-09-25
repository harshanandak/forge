# codex/fix-issue-close-exit

- source: (local branch, no worktree)
- branch: codex/fix-issue-close-exit
- HEAD: 9fcd8ea9b81a36d8a5936141b3d39622c108ed73
- last commit: 2026-08-04T14:51:16+05:30 "fix(review): name validation exit code assertion (940b904b)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__fix-issue-close-exit 9fcd8ea9b81a   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__fix-issue-close-exit/commits/*.patch
git apply wip-archive/codex__fix-issue-close-exit/uncommitted.diff
cp -r wip-archive/codex__fix-issue-close-exit/untracked/. .
```
