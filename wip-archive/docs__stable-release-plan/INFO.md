# docs/stable-release-plan

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/stable-release
- branch: docs/stable-release-plan
- HEAD: e1cc53117d0b02d742156e32feea90ab03dee3af
- last commit: 2026-07-28T18:58:13+05:30 "docs(release): resolve stable plan review feedback"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: 2 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/docs__stable-release-plan e1cc53117d0b   # if the sha still exists locally; else start from origin/master
git am wip-archive/docs__stable-release-plan/commits/*.patch
git apply wip-archive/docs__stable-release-plan/uncommitted.diff
cp -r wip-archive/docs__stable-release-plan/untracked/. .
```
