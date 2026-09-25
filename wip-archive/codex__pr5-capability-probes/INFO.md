# codex/pr5-capability-probes

- source: (local branch, no worktree)
- branch: codex/pr5-capability-probes
- HEAD: 3cb4228c86bbf867fa1d31c0f4fe7d7d8aae27b7
- last commit: 2026-08-11T03:17:14+05:30 "refactor(capabilities): simplify probe analysis"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr5-capability-probes 3cb4228c86bb   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr5-capability-probes/commits/*.patch
git apply wip-archive/codex__pr5-capability-probes/uncommitted.diff
cp -r wip-archive/codex__pr5-capability-probes/untracked/. .
```
