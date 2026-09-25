# codex/stabilize-foreign-lease-windows

- source: (local branch, no worktree)
- branch: codex/stabilize-foreign-lease-windows
- HEAD: 8bbb364a57734df9b43a5bc39be388bb940fc64d
- last commit: 2026-08-06T16:47:34+05:30 "fix(test): clean up foreign-lease child timeout"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__stabilize-foreign-lease-windows 8bbb364a5773   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__stabilize-foreign-lease-windows/commits/*.patch
git apply wip-archive/codex__stabilize-foreign-lease-windows/uncommitted.diff
cp -r wip-archive/codex__stabilize-foreign-lease-windows/untracked/. .
```
