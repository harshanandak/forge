# feat/8eabd92c-a6ef-4635-891d-7a6c6f4bb07e

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/8eabd92c-a6ef-4635-891d-7a6c6f4bb07e
- branch: feat/8eabd92c-a6ef-4635-891d-7a6c6f4bb07e
- HEAD: 806f937a096ab3e46e9c2ab1de8e65e1e54e239f
- last commit: 2026-07-15T11:44:51+05:30 "fix(serve): run journal verify at startup + doc-precision (FU2 + review)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__8eabd92c-a6ef-4635-891d-7a6c6f4bb07e 806f937a096a   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__8eabd92c-a6ef-4635-891d-7a6c6f4bb07e/commits/*.patch
git apply wip-archive/feat__8eabd92c-a6ef-4635-891d-7a6c6f4bb07e/uncommitted.diff
cp -r wip-archive/feat__8eabd92c-a6ef-4635-891d-7a6c6f4bb07e/untracked/. .
```
