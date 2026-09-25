# feat/setup-auto-migrate

- source: (local branch, no worktree)
- branch: feat/setup-auto-migrate
- HEAD: 89d7022e3f46fa5a637d1898f9098b586ffdb46c
- last commit: 2026-07-04T08:16:54+05:30 "Merge remote-tracking branch 'origin/master' into feat/setup-auto-migrate"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__setup-auto-migrate 89d7022e3f46   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__setup-auto-migrate/commits/*.patch
git apply wip-archive/feat__setup-auto-migrate/uncommitted.diff
cp -r wip-archive/feat__setup-auto-migrate/untracked/. .
```
