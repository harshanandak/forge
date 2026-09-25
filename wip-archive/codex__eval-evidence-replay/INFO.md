# codex/eval-evidence-replay

- source: (local branch, no worktree)
- branch: codex/eval-evidence-replay
- HEAD: fb83c7cf6a8fd73e3388b36beb7357e6d6b931bb
- last commit: 2026-08-06T18:36:57+05:30 "fix(eval): validate replay query entries"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 7
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__eval-evidence-replay fb83c7cf6a8f   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__eval-evidence-replay/commits/*.patch
git apply wip-archive/codex__eval-evidence-replay/uncommitted.diff
cp -r wip-archive/codex__eval-evidence-replay/untracked/. .
```
