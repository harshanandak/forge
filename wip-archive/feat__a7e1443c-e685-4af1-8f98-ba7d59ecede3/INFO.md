# feat/a7e1443c-e685-4af1-8f98-ba7d59ecede3

- source: (local branch, no worktree)
- branch: feat/a7e1443c-e685-4af1-8f98-ba7d59ecede3
- HEAD: 3eda38d078c30690c1be512b37bcca8dd0d7c18a
- last commit: 2026-07-15T17:04:10+05:30 "fix(migrate): regenerate D20 kill-list + surface sidecar-scan failures (a7e1443c)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__a7e1443c-e685-4af1-8f98-ba7d59ecede3 3eda38d078c3   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__a7e1443c-e685-4af1-8f98-ba7d59ecede3/commits/*.patch
git apply wip-archive/feat__a7e1443c-e685-4af1-8f98-ba7d59ecede3/uncommitted.diff
cp -r wip-archive/feat__a7e1443c-e685-4af1-8f98-ba7d59ecede3/untracked/. .
```
