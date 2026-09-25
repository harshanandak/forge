# recovery/delivery-push-973ae530-20260920

- source: (local branch, no worktree)
- branch: recovery/delivery-push-973ae530-20260920
- HEAD: 973ae530ebd6d50b33cda08dec59377845ca8bf1
- last commit: 2026-09-19T13:15:05+05:30 "fix(push): bind hook reuse to live push invocation"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/recovery__delivery-push-973ae530-20260920 973ae530ebd6   # if the sha still exists locally; else start from origin/master
git am wip-archive/recovery__delivery-push-973ae530-20260920/commits/*.patch
git apply wip-archive/recovery__delivery-push-973ae530-20260920/uncommitted.diff
cp -r wip-archive/recovery__delivery-push-973ae530-20260920/untracked/. .
```
