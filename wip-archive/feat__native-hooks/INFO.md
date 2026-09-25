# feat/native-hooks

- source: (local branch, no worktree)
- branch: feat/native-hooks
- HEAD: af361925d0f9ff7f9897928a09488993cbb7320f
- last commit: 2026-07-07T14:46:03+05:30 "fix(hooks): Cursor protected-path now denies shell WRITES on beforeShellExecution"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 4
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__native-hooks af361925d0f9   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__native-hooks/commits/*.patch
git apply wip-archive/feat__native-hooks/uncommitted.diff
cp -r wip-archive/feat__native-hooks/untracked/. .
```
