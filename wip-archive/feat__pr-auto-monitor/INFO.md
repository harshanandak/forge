# feat/pr-auto-monitor

- source: (local branch, no worktree)
- branch: feat/pr-auto-monitor
- HEAD: d99bd97c5bd71dd0872e0f5909d13b8c0dd9d55a
- last commit: 2026-07-15T13:11:00+05:30 "fix(monitor): fail-closed CI guard + producer-proof availability checks"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__pr-auto-monitor d99bd97c5bd7   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__pr-auto-monitor/commits/*.patch
git apply wip-archive/feat__pr-auto-monitor/uncommitted.diff
cp -r wip-archive/feat__pr-auto-monitor/untracked/. .
```
