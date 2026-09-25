# feat/merge-flow-control-plane

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/merge-flow-control-plane
- branch: feat/merge-flow-control-plane
- HEAD: 12ba9df672b4f61ad6d0c765f7e3d987131a4496
- last commit: 2026-08-07T13:07:15+05:30 "docs: tighten merge-flow execution contracts"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: 2 entries (2 untracked); untracked copied: 2
- excluded: none

## restore

```
git switch -c restore/feat__merge-flow-control-plane 12ba9df672b4   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__merge-flow-control-plane/commits/*.patch
git apply wip-archive/feat__merge-flow-control-plane/uncommitted.diff
cp -r wip-archive/feat__merge-flow-control-plane/untracked/. .
```
