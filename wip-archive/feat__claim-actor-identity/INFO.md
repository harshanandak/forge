# feat/claim-actor-identity

- source: (local branch, no worktree)
- branch: feat/claim-actor-identity
- HEAD: 92a60e654550c617d95347af8383182a796ae120
- last commit: 2026-07-09T18:31:56+05:30 "fix(kernel): align empty-string session handling + idempotent-retry test (d71a824b)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__claim-actor-identity 92a60e654550   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__claim-actor-identity/commits/*.patch
git apply wip-archive/feat__claim-actor-identity/uncommitted.diff
cp -r wip-archive/feat__claim-actor-identity/untracked/. .
```
