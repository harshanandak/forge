# fix/delivery-package

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/delivery-package
- branch: fix/delivery-package
- HEAD: 73c02ff7011516375f5e7e2c1b70316c93896165
- last commit: 2026-09-18T16:51:37+05:30 "fix(validate): run local eslint shims portably"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- also covers (their unique commits are a subset of this one): fix/delivery-lint
- excluded: none

## restore

```
git switch -c restore/fix__delivery-package 73c02ff70115   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__delivery-package/commits/*.patch
git apply wip-archive/fix__delivery-package/uncommitted.diff
cp -r wip-archive/fix__delivery-package/untracked/. .
```
