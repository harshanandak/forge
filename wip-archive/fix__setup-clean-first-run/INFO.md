# fix/setup-clean-first-run

- source: (local branch, no worktree)
- branch: fix/setup-clean-first-run
- HEAD: a7d916193c692e35419a4becb0f7b8aa3917e16d
- last commit: 2026-07-06T06:17:51+05:30 "fix(setup): make markerless AGENTS.md backup non-destructive"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__setup-clean-first-run a7d916193c69   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__setup-clean-first-run/commits/*.patch
git apply wip-archive/fix__setup-clean-first-run/uncommitted.diff
cp -r wip-archive/fix__setup-clean-first-run/untracked/. .
```
