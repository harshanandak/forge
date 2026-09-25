# feat/authorized-claude-pointer-writer

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/authorized-claude-pointer-writer
- branch: feat/authorized-claude-pointer-writer
- HEAD: b84f68c9a04f7f26a633e991d5c484d733031d67
- last commit: 2026-08-18T16:32:12+05:30 "fix: accept pointer without trailing newline"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 15
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): feat/claude-pointer-stacked
- excluded: none

## restore

```
git switch -c restore/feat__authorized-claude-pointer-writer b84f68c9a04f   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__authorized-claude-pointer-writer/commits/*.patch
git apply wip-archive/feat__authorized-claude-pointer-writer/uncommitted.diff
cp -r wip-archive/feat__authorized-claude-pointer-writer/untracked/. .
```
