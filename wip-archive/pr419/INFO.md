# pr419

- source: (local branch, no worktree)
- branch: pr419
- HEAD: 491fb5ac5c5c760ea90b021a0f394a1385e0b2bb
- last commit: 2026-07-19T16:24:47+05:30 "feat(skills): static skill-eval scorecard + forge skill scores + CI gate (W3)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/pr419 491fb5ac5c5c   # if the sha still exists locally; else start from origin/master
git am wip-archive/pr419/commits/*.patch
git apply wip-archive/pr419/uncommitted.diff
cp -r wip-archive/pr419/untracked/. .
```
