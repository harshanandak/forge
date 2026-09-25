# feat/config-writer-verbs

- source: (local branch, no worktree)
- branch: feat/config-writer-verbs
- HEAD: 4e8a0b331f1151600aa896616b22a6b7f6d6cba0
- last commit: 2026-07-04T11:34:24+05:30 "fix(role): reject valueless --use/--ideology instead of silently dropping"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__config-writer-verbs 4e8a0b331f11   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__config-writer-verbs/commits/*.patch
git apply wip-archive/feat__config-writer-verbs/uncommitted.diff
cp -r wip-archive/feat__config-writer-verbs/untracked/. .
```
