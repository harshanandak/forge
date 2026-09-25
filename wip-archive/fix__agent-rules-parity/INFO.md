# fix/agent-rules-parity

- source: (local branch, no worktree)
- branch: fix/agent-rules-parity
- HEAD: bf72bf56b0cbb5df88945b6200e7db90a0379b90
- last commit: 2026-07-06T18:02:08+05:30 "test(matrix): match shepherd codex render target to $CODEX_HOME/skills"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/fix__agent-rules-parity bf72bf56b0cb   # if the sha still exists locally; else start from origin/master
git am wip-archive/fix__agent-rules-parity/commits/*.patch
git apply wip-archive/fix__agent-rules-parity/uncommitted.diff
cp -r wip-archive/fix__agent-rules-parity/untracked/. .
```
