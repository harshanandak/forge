# docs/session-design-docs

- source: (local branch, no worktree)
- branch: docs/session-design-docs
- HEAD: 1f2ab00d8370536feccdf001ced4a8d4a6bb4500
- last commit: 2026-07-05T01:06:51+05:30 "docs: align design docs with the shipped contract (CodeRabbit #290)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/docs__session-design-docs 1f2ab00d8370   # if the sha still exists locally; else start from origin/master
git am wip-archive/docs__session-design-docs/commits/*.patch
git apply wip-archive/docs__session-design-docs/uncommitted.diff
cp -r wip-archive/docs__session-design-docs/untracked/. .
```
