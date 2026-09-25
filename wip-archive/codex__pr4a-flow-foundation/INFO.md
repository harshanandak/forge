# codex/pr4a-flow-foundation

- source: (local branch, no worktree)
- branch: codex/pr4a-flow-foundation
- HEAD: e73d8bd991d2c8c48ca646a5fbcb677a0f37e898
- last commit: 2026-08-10T08:38:11+05:30 "fix(flow): address bounded runtime review findings"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 14
- uncommitted: none
- also covers (their unique commits are a subset of this one): codex/pr4a-flow-executor, codex/pr4a-flow-supervisor
- excluded: none

## restore

```
git switch -c restore/codex__pr4a-flow-foundation e73d8bd991d2   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4a-flow-foundation/commits/*.patch
git apply wip-archive/codex__pr4a-flow-foundation/uncommitted.diff
cp -r wip-archive/codex__pr4a-flow-foundation/untracked/. .
```
