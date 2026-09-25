# codex/pr1-kernel-trace

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/forge-product-restructure/.worktrees/pr1-kernel-trace
- branch: codex/pr1-kernel-trace
- HEAD: 34e75c0efc5923dbd3e395bb5841e45ed3528958
- last commit: 2026-08-09T14:32:14+05:30 "fix(kernel): fail closed on trace replays"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr1-kernel-trace 34e75c0efc59   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr1-kernel-trace/commits/*.patch
git apply wip-archive/codex__pr1-kernel-trace/uncommitted.diff
cp -r wip-archive/codex__pr1-kernel-trace/untracked/. .
```
