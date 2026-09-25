# feat/profiles-m1

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/profiles-m1
- branch: feat/profiles-m1
- HEAD: bf387e3607c487acf72f386fa7dc1846f98e13b9
- last commit: 2026-08-20T23:59:29+05:30 "feat: add the forge profile command group"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__profiles-m1 bf387e3607c4   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__profiles-m1/commits/*.patch
git apply wip-archive/feat__profiles-m1/uncommitted.diff
cp -r wip-archive/feat__profiles-m1/untracked/. .
```
