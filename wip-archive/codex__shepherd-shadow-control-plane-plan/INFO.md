# codex/shepherd-shadow-control-plane-plan

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/shepherd-shadow-control-plane
- branch: codex/shepherd-shadow-control-plane-plan
- HEAD: 4f0c77c17d7098880126c53196132e75b9f94375
- last commit: 2026-08-11T05:05:51+05:30 "docs(plan): design Shepherd shadow replay lane"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__shepherd-shadow-control-plane-plan 4f0c77c17d70   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__shepherd-shadow-control-plane-plan/commits/*.patch
git apply wip-archive/codex__shepherd-shadow-control-plane-plan/uncommitted.diff
cp -r wip-archive/codex__shepherd-shadow-control-plane-plan/untracked/. .
```
