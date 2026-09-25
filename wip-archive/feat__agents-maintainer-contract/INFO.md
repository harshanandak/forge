# feat/agents-maintainer-contract

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/agents-maintainer-contract
- branch: feat/agents-maintainer-contract
- HEAD: e9a48725b77ebc55a7bd64192496e17a09a5f14b
- last commit: 2026-08-16T01:39:20+05:30 "docs: codify the pre-user shipping regime in the USER block"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__agents-maintainer-contract e9a48725b77e   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__agents-maintainer-contract/commits/*.patch
git apply wip-archive/feat__agents-maintainer-contract/uncommitted.diff
cp -r wip-archive/feat__agents-maintainer-contract/untracked/. .
```
