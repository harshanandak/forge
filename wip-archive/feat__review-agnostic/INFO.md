# feat/review-agnostic

- source: (local branch, no worktree)
- branch: feat/review-agnostic
- HEAD: 5a7ed739f47e4defd893d20d4a9b20a9e63ecc5a
- last commit: 2026-07-06T20:13:06+05:30 "chore(skills): re-sync .agents/skills review|shepherd after #314 rebase"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__review-agnostic 5a7ed739f47e   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__review-agnostic/commits/*.patch
git apply wip-archive/feat__review-agnostic/uncommitted.diff
cp -r wip-archive/feat__review-agnostic/untracked/. .
```
