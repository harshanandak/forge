# codex/pr-issue-linkage

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr-issue-linkage
- branch: codex/pr-issue-linkage
- HEAD: a3b50b7e1dcc7f7dfa30774f3e250842781c8618
- last commit: 2026-08-11T00:00:14+05:30 "fix: harden PR issue linkage preflights"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr-issue-linkage a3b50b7e1dcc   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr-issue-linkage/commits/*.patch
git apply wip-archive/codex__pr-issue-linkage/uncommitted.diff
cp -r wip-archive/codex__pr-issue-linkage/untracked/. .
```
