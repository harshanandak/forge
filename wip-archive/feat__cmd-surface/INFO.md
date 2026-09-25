# feat/cmd-surface

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/cmd-surface
- branch: feat/cmd-surface
- HEAD: 6131665438522296a240827432e1a5238a428015
- last commit: 2026-07-16T12:17:21+05:30 "docs: cmd-surface design LOCKED (Rev 3) — keep config, release becomes a noun"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__cmd-surface 613166543852   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__cmd-surface/commits/*.patch
git apply wip-archive/feat__cmd-surface/uncommitted.diff
cp -r wip-archive/feat__cmd-surface/untracked/. .
```
