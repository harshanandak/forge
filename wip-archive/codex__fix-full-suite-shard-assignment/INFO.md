# codex/fix-full-suite-shard-assignment

- source: (local branch, no worktree)
- branch: codex/fix-full-suite-shard-assignment
- HEAD: 034ad42de953edcac0c9371da2ee91cdebd69f8e
- last commit: 2026-08-05T20:42:00+05:30 "test: assert unique shard file count"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__fix-full-suite-shard-assignment 034ad42de953   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__fix-full-suite-shard-assignment/commits/*.patch
git apply wip-archive/codex__fix-full-suite-shard-assignment/uncommitted.diff
cp -r wip-archive/codex__fix-full-suite-shard-assignment/untracked/. .
```
