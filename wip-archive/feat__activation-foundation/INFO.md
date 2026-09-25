# feat/activation-foundation

- source: (local branch, no worktree)
- branch: feat/activation-foundation
- HEAD: 83dc9175c1c8bc4ab6114b91389c7f1fca753b7d
- last commit: 2026-07-16T11:10:39+05:30 "fix(activation): atomic self-healing init + hook exec bit + LF polyglot (CodeRabbit #400)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__activation-foundation 83dc9175c1c8   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__activation-foundation/commits/*.patch
git apply wip-archive/feat__activation-foundation/uncommitted.diff
cp -r wip-archive/feat__activation-foundation/untracked/. .
```
