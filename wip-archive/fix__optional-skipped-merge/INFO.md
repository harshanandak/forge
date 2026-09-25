# fix/optional-skipped-merge

- source: (local branch, no worktree)
- branch: fix/optional-skipped-merge
- HEAD: 5e8e38c90eb26e5ef52ee7ffafc8f585f3b6853c
- last commit: 2026-08-30T17:56:35+05:30 "docs: link optional check merge fix pr"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__optional-skipped-merge 5e8e38c90eb2   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__optional-skipped-merge/commits/*.patch
git apply wip-archive/fix__optional-skipped-merge/uncommitted.diff
cp -r wip-archive/fix__optional-skipped-merge/untracked/. .
```
