# feat/simplify-pr-monitor

- source: (local branch, no worktree)
- branch: feat/simplify-pr-monitor
- HEAD: ab33294dacc060826a5426da39cd425cce1f7f91
- last commit: 2026-08-04T22:10:56+05:30 "fix(pr-monitor): separate endpoint backticks"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__simplify-pr-monitor ab33294dacc0   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__simplify-pr-monitor/commits/*.patch
git apply wip-archive/feat__simplify-pr-monitor/uncommitted.diff
cp -r wip-archive/feat__simplify-pr-monitor/untracked/. .
```
