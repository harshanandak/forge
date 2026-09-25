# codex/monitor-write-fencing

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/monitor-write-fencing
- branch: codex/monitor-write-fencing
- HEAD: e154dcc6caba5949922e4178a7f67724d750fd3b
- last commit: 2026-08-10T23:29:54+05:30 "fix(memory): preserve terminal event replay idempotency"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/windows-git-fixture-no-spawn
- excluded: none

## restore

```
git switch -c restore/codex__monitor-write-fencing e154dcc6caba   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__monitor-write-fencing/commits/*.patch
git apply wip-archive/codex__monitor-write-fencing/uncommitted.diff
cp -r wip-archive/codex__monitor-write-fencing/untracked/. .
```
