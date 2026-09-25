# feat/claude-pointer-only

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/claude-pointer-only
- branch: feat/claude-pointer-only
- HEAD: 2b2124960aaed82ac7832c2dd7c078e7df64c52c
- last commit: 2026-08-17T10:54:46+05:30 "docs: review-time coding standards, local-artifact gitignore, docs test lane (#534)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (0 untracked); untracked copied: 0
- excluded: none

## restore

```
git switch -c restore/feat__claude-pointer-only 2b2124960aae   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__claude-pointer-only/commits/*.patch
git apply wip-archive/feat__claude-pointer-only/uncommitted.diff
cp -r wip-archive/feat__claude-pointer-only/untracked/. .
```
