# feat/claim-safety

- source: (local branch, no worktree)
- branch: feat/claim-safety
- HEAD: d6f211a16ac32c2a0c97054d74ab897bafb23c7c
- last commit: 2026-07-04T17:09:13+05:30 "docs(claim-safety): show --target on the release check example"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__claim-safety d6f211a16ac3   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__claim-safety/commits/*.patch
git apply wip-archive/feat__claim-safety/uncommitted.diff
cp -r wip-archive/feat__claim-safety/untracked/. .
```
