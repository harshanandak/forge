# feat/a5399f3d-28df-474e-b5f3-08af6bd7b388

- source: (local branch, no worktree)
- branch: feat/a5399f3d-28df-474e-b5f3-08af6bd7b388
- HEAD: 0cf159d3f2c9ee1df673818d4ca856c974a9c7ed
- last commit: 2026-07-16T00:26:02+05:30 "fix(upgrade): address CodeRabbit review nits on #398"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__a5399f3d-28df-474e-b5f3-08af6bd7b388 0cf159d3f2c9   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__a5399f3d-28df-474e-b5f3-08af6bd7b388/commits/*.patch
git apply wip-archive/feat__a5399f3d-28df-474e-b5f3-08af6bd7b388/uncommitted.diff
cp -r wip-archive/feat__a5399f3d-28df-474e-b5f3-08af6bd7b388/untracked/. .
```
