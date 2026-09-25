# feat/eda-gates

- source: (local branch, no worktree)
- branch: feat/eda-gates
- HEAD: a091e240e73f941bddd7775028b921050d929c19
- last commit: 2026-07-16T11:17:17+05:30 "fix(init): minimal renderer must not re-add protected paths (refs eda6d866)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__eda-gates a091e240e73f   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__eda-gates/commits/*.patch
git apply wip-archive/feat__eda-gates/uncommitted.diff
cp -r wip-archive/feat__eda-gates/untracked/. .
```
