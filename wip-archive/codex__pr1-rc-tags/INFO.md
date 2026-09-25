# codex/pr1-rc-tags

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr1-rc-tags
- branch: codex/pr1-rc-tags
- HEAD: 8f7aa1fca615fb4f174ad89f652e02f94f3554ad
- last commit: 2026-08-09T16:58:17+05:30 "fix(release): validate prerelease channels exactly"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 19
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr1-rc-tags 8f7aa1fca615   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr1-rc-tags/commits/*.patch
git apply wip-archive/codex__pr1-rc-tags/uncommitted.diff
cp -r wip-archive/codex__pr1-rc-tags/untracked/. .
```
