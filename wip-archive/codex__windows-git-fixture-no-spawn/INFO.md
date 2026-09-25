# codex/windows-git-fixture-no-spawn

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/windows-git-fixture-no-spawn
- branch: codex/windows-git-fixture-no-spawn
- HEAD: 7dc22262c5f83f7abf57bc28d5df5218c1f89695
- last commit: 2026-08-10T22:59:32+05:30 "test: avoid Git processes in Windows fixtures"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__windows-git-fixture-no-spawn 7dc22262c5f8   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-git-fixture-no-spawn/commits/*.patch
git apply wip-archive/codex__windows-git-fixture-no-spawn/uncommitted.diff
cp -r wip-archive/codex__windows-git-fixture-no-spawn/untracked/. .
```
