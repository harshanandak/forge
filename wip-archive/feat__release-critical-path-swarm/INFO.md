# feat/release-critical-path-swarm

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/release-critical-path-swarm
- branch: feat/release-critical-path-swarm
- HEAD: f19d9d342b9a00209fb7f6369c099ce14a6b75e7
- last commit: 2026-08-01T11:55:49+05:30 "docs: encode adaptive release swarm workflow"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 3 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/feat__release-critical-path-swarm f19d9d342b9a   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__release-critical-path-swarm/commits/*.patch
git apply wip-archive/feat__release-critical-path-swarm/uncommitted.diff
cp -r wip-archive/feat__release-critical-path-swarm/untracked/. .
```
