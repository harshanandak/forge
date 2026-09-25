# fix/lease-fields-d71a824b

- source: (local branch, no worktree)
- branch: fix/lease-fields-d71a824b
- HEAD: 5a5f2cc76c1e7d45b1654514291d5645865cba9b
- last commit: 2026-07-12T15:54:56+05:30 "fix(kernel): populate session_id/worktree_id/expires_at on claim leases (d71a824b)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__lease-fields-d71a824b 5a5f2cc76c1e   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__lease-fields-d71a824b/commits/*.patch
git apply wip-archive/fix__lease-fields-d71a824b/uncommitted.diff
cp -r wip-archive/fix__lease-fields-d71a824b/untracked/. .
```
