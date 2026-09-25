# fix/preflight-changed-files

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/s0-preflight-changedfiles
- branch: fix/preflight-changed-files
- HEAD: 6989b3a976d9599acad9738edb625a6e980d23ca
- last commit: 2026-07-30T00:43:05+05:30 "fix(preflight): fail closed when changed-file diff fails"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__preflight-changed-files 6989b3a976d9   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__preflight-changed-files/commits/*.patch
git apply wip-archive/fix__preflight-changed-files/uncommitted.diff
cp -r wip-archive/fix__preflight-changed-files/untracked/. .
```
