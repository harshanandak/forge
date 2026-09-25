# codex/windows-stale-fixture

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-stale-fixture
- branch: codex/windows-stale-fixture
- HEAD: 2b5858873dbd3845770722af678139278d849f43
- last commit: 2026-08-07T22:23:49+05:30 "fix: preserve signals on shard errors"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__windows-stale-fixture 2b5858873dbd   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-stale-fixture/commits/*.patch
git apply wip-archive/codex__windows-stale-fixture/uncommitted.diff
cp -r wip-archive/codex__windows-stale-fixture/untracked/. .
```
