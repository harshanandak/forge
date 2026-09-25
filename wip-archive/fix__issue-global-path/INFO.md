# fix/issue-global-path

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/issue-global-path
- branch: fix/issue-global-path
- HEAD: a0b8f7e19301f4fdf85371baf4e45e6ca73843f7
- last commit: 2026-08-30T14:37:16+05:30 "fix(cli): honor project path for issue commands"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/fix/issue-global-path; not patch-archived)
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/fix__issue-global-path a0b8f7e19301   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__issue-global-path/commits/*.patch
git apply wip-archive/fix__issue-global-path/uncommitted.diff
cp -r wip-archive/fix__issue-global-path/untracked/. .
```
