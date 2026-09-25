# codex/forge-product-restructure

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/forge-product-restructure
- branch: codex/forge-product-restructure
- HEAD: 5dc2c57a67840791d80be2fcf435a8f5d15877b6
- last commit: 2026-08-09T19:38:33+05:30 "fix(review): close PR 497 feedback"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 28
- uncommitted: 2 entries (2 untracked); untracked copied: 2
- also covers (their unique commits are a subset of this one): codex/pr1-convergence-protocol, codex/pr1-validation-lanes, codex/pr1-contract-readiness, codex/pr1-plan-authority, codex/pr1-approval-events, codex/pr1-claim-reconcile
- excluded: none

## restore

```
git switch -c restore/codex__forge-product-restructure 5dc2c57a6784   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__forge-product-restructure/commits/*.patch
git apply wip-archive/codex__forge-product-restructure/uncommitted.diff
cp -r wip-archive/codex__forge-product-restructure/untracked/. .
```
