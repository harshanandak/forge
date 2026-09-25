# codex/backup-local-master-4f981ef

- source: (local branch, no worktree)
- branch: codex/backup-local-master-4f981ef
- HEAD: 4f981efa5d7d875af58edc217fc6f5b6fd89db0b
- last commit: 2026-05-23T21:15:34+05:30 "chore: close forge-2si5 after verify"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__backup-local-master-4f981ef 4f981efa5d7d   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__backup-local-master-4f981ef/commits/*.patch
git apply wip-archive/codex__backup-local-master-4f981ef/uncommitted.diff
cp -r wip-archive/codex__backup-local-master-4f981ef/untracked/. .
```
