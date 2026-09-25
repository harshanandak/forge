# codex/lockfile-authority

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/lockfile-authority
- branch: codex/lockfile-authority
- HEAD: 2dae841d2e422f9cec604def1a613036735c8fd0
- last commit: 2026-08-09T23:41:08+05:30 "fix: close protected-state review gaps"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__lockfile-authority 2dae841d2e42   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__lockfile-authority/commits/*.patch
git apply wip-archive/codex__lockfile-authority/uncommitted.diff
cp -r wip-archive/codex__lockfile-authority/untracked/. .
```
