# feat/opencode-plugin

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/opencode-plugin
- branch: feat/opencode-plugin
- HEAD: f8bbc20f83ba2e6247e4f374931dd98163402310
- last commit: 2026-09-11T12:51:21+05:30 "docs(opencode-plugin): add design doc and task list for opencode v2 plugin"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__opencode-plugin f8bbc20f83ba   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__opencode-plugin/commits/*.patch
git apply wip-archive/feat__opencode-plugin/uncommitted.diff
cp -r wip-archive/feat__opencode-plugin/untracked/. .
```
