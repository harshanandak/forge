# fix/merge-pr-repo-identity

- source: (local branch, no worktree)
- branch: fix/merge-pr-repo-identity
- HEAD: 9a9eb060abd9d5407e0785b6b087cb4445e2c3ae
- last commit: 2026-08-04T13:53:31+05:30 "test: assert legacy-only migration retirement"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__merge-pr-repo-identity 9a9eb060abd9   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__merge-pr-repo-identity/commits/*.patch
git apply wip-archive/fix__merge-pr-repo-identity/uncommitted.diff
cp -r wip-archive/fix__merge-pr-repo-identity/untracked/. .
```
