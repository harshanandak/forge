# feat/smith-orchestrator

- source: (local branch, no worktree)
- branch: feat/smith-orchestrator
- HEAD: e36d40cae3762f37b66d1cc86ffeeaec7477739a
- last commit: 2026-07-05T01:01:26+05:30 "fix(smith): commit the untracked canonical references/ dir"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__smith-orchestrator e36d40cae376   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__smith-orchestrator/commits/*.patch
git apply wip-archive/feat__smith-orchestrator/uncommitted.diff
cp -r wip-archive/feat__smith-orchestrator/untracked/. .
```
