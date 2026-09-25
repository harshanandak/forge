# codex/pr3-recall-storage

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr3-recall-storage
- branch: codex/pr3-recall-storage
- HEAD: 9814b4878c2aa0592a60ea9ed7a0e3bf5ae5ed47
- last commit: 2026-08-10T04:08:48+05:30 "fix(memory): hide superseded recall by default"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__pr3-recall-storage 9814b4878c2a   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr3-recall-storage/commits/*.patch
git apply wip-archive/codex__pr3-recall-storage/uncommitted.diff
cp -r wip-archive/codex__pr3-recall-storage/untracked/. .
```
