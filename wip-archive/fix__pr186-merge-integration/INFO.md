# fix/pr186-merge-integration

- source: (local branch, no worktree)
- branch: fix/pr186-merge-integration
- HEAD: 2c18ac828ee74edc13de8f2dd1d293899107e831
- last commit: 2026-08-30T17:47:22+05:30 "fix: preserve canonical binding compatibility"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: none
- also covers (their unique commits are a subset of this one): fix/pr-link-existing
- excluded: none

## restore

```
git switch -c restore/fix__pr186-merge-integration 2c18ac828ee7   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__pr186-merge-integration/commits/*.patch
git apply wip-archive/fix__pr186-merge-integration/uncommitted.diff
cp -r wip-archive/fix__pr186-merge-integration/untracked/. .
```
