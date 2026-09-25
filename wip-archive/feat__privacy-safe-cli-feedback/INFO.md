# feat/privacy-safe-cli-feedback

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/privacy-safe-cli-feedback
- branch: feat/privacy-safe-cli-feedback
- HEAD: 68f5ab930d846b389a8fae9da8f26c243b94ab5f
- last commit: 2026-08-07T19:56:21+05:30 "fix: refresh setup skill scorecard"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__privacy-safe-cli-feedback 68f5ab930d84   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__privacy-safe-cli-feedback/commits/*.patch
git apply wip-archive/feat__privacy-safe-cli-feedback/uncommitted.diff
cp -r wip-archive/feat__privacy-safe-cli-feedback/untracked/. .
```
