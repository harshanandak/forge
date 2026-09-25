# fix/delivery-push

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/delivery-push
- branch: fix/delivery-push
- HEAD: 3b465c8dbc15889a5cfbc3fad3b17a0db1b81a77
- last commit: 2026-09-20T05:37:44+05:30 "fix(push): support Node-only proof issuance"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 10
- uncommitted: none
- also covers (their unique commits are a subset of this one): recovery/delivery-push-7cebec66-20260919
- excluded: none

## restore

```
git switch -c restore/fix__delivery-push 3b465c8dbc15   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__delivery-push/commits/*.patch
git apply wip-archive/fix__delivery-push/uncommitted.diff
cp -r wip-archive/fix__delivery-push/untracked/. .
```
