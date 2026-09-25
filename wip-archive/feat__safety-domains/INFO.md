# feat/safety-domains

- source: (local branch, no worktree)
- branch: feat/safety-domains
- HEAD: e70eacc2b30dcb13a973ce08cc42815954638a4e
- last commit: 2026-07-06T20:09:59+05:30 "fix(safety): don't duplicate the .cursorignore header on re-runs"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__safety-domains e70eacc2b30d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__safety-domains/commits/*.patch
git apply wip-archive/feat__safety-domains/uncommitted.diff
cp -r wip-archive/feat__safety-domains/untracked/. .
```
