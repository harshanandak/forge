# feat/a2279f65-847f-43d7-a9f6-0c1442ed0801

- source: (local branch, no worktree)
- branch: feat/a2279f65-847f-43d7-a9f6-0c1442ed0801
- HEAD: e873f7843eeb238b28206b972fd5a313cbf6c489
- last commit: 2026-07-14T14:38:40+05:30 "fix(plan): F4c conflict guard consults the kernel registry in the real CLI (CodeRabbit)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__a2279f65-847f-43d7-a9f6-0c1442ed0801 e873f7843eeb   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__a2279f65-847f-43d7-a9f6-0c1442ed0801/commits/*.patch
git apply wip-archive/feat__a2279f65-847f-43d7-a9f6-0c1442ed0801/uncommitted.diff
cp -r wip-archive/feat__a2279f65-847f-43d7-a9f6-0c1442ed0801/untracked/. .
```
