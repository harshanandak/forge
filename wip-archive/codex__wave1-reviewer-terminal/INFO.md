# codex/wave1-reviewer-terminal

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/wave1-reviewer-terminal
- branch: codex/wave1-reviewer-terminal
- HEAD: 08065d974ee1baaa4eae182f8502d141b7e1afcc
- last commit: 2026-08-07T16:30:54+05:30 "fix: validate reviewer policy updates"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__wave1-reviewer-terminal 08065d974ee1   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__wave1-reviewer-terminal/commits/*.patch
git apply wip-archive/codex__wave1-reviewer-terminal/uncommitted.diff
cp -r wip-archive/codex__wave1-reviewer-terminal/untracked/. .
```
