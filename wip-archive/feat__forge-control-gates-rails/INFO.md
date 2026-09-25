# feat/forge-control-gates-rails

- source: (local branch, no worktree)
- branch: feat/forge-control-gates-rails
- HEAD: ef4ac8d6458507788cdaa0a79ae3db0eb89a1786
- last commit: 2026-07-15T13:25:08+05:30 "fix(control): scrub stale runtime-denial claims + reject junk status args (CodeRabbit #385)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__forge-control-gates-rails ef4ac8d64585   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__forge-control-gates-rails/commits/*.patch
git apply wip-archive/feat__forge-control-gates-rails/uncommitted.diff
cp -r wip-archive/feat__forge-control-gates-rails/untracked/. .
```
