# fix/pr-link-existing

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr-link-existing
- branch: fix/pr-link-existing
- HEAD: b3abb24f76166f3c72be7b0ffc049a2ddf13c85c
- last commit: 2026-08-27T13:25:43+05:30 "fix: select canonical pr binding duplicate"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__pr-link-existing b3abb24f7616   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__pr-link-existing/commits/*.patch
git apply wip-archive/fix__pr-link-existing/uncommitted.diff
cp -r wip-archive/fix__pr-link-existing/untracked/. .
```
