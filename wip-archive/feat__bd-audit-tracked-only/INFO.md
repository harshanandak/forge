# feat/bd-audit-tracked-only

- source: (local branch, no worktree)
- branch: feat/bd-audit-tracked-only
- HEAD: 20fd1b09f13ab4cd3d4180db0d33189a25a7825b
- last commit: 2026-07-10T15:24:22+05:30 "Merge remote-tracking branch 'origin/master' into feat/bd-audit-tracked-only"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__bd-audit-tracked-only 20fd1b09f13a   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__bd-audit-tracked-only/commits/*.patch
git apply wip-archive/feat__bd-audit-tracked-only/uncommitted.diff
cp -r wip-archive/feat__bd-audit-tracked-only/untracked/. .
```
