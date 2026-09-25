# feat/pr-monitor

- source: (local branch, no worktree)
- branch: feat/pr-monitor
- HEAD: 85906664ffd8da4926eca70c6c343b6b70470fdd
- last commit: 2026-07-13T12:56:57+05:30 "fix(pr-monitor): journal data-integrity (CodeRabbit journal.js:220)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__pr-monitor 85906664ffd8   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__pr-monitor/commits/*.patch
git apply wip-archive/feat__pr-monitor/uncommitted.diff
cp -r wip-archive/feat__pr-monitor/untracked/. .
```
