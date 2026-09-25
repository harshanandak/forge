# feat/4a5a3c12-static-manifest

- source: (local branch, no worktree)
- branch: feat/4a5a3c12-static-manifest
- HEAD: 71484536a89d7ccfb3c24666a72510b866fa1879
- last commit: 2026-07-12T17:44:05+05:30 "fix(registry): log unexpected static-manifest load errors, stay silent only for missing file"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__4a5a3c12-static-manifest 71484536a89d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__4a5a3c12-static-manifest/commits/*.patch
git apply wip-archive/feat__4a5a3c12-static-manifest/uncommitted.diff
cp -r wip-archive/feat__4a5a3c12-static-manifest/untracked/. .
```
