# feat/auto-shepherd

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/auto-shepherd
- branch: feat/auto-shepherd
- HEAD: 9d0ca07b1c62a9e12348c29f4681157de10a23b6
- last commit: 2026-07-16T15:32:25+05:30 "fix(pr-monitor): remove unsupported pull_request_review_thread trigger"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__auto-shepherd 9d0ca07b1c62   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__auto-shepherd/commits/*.patch
git apply wip-archive/feat__auto-shepherd/uncommitted.diff
cp -r wip-archive/feat__auto-shepherd/untracked/. .
```
