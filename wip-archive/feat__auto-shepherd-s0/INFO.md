# feat/auto-shepherd-s0

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/auto-shepherd-s0
- branch: feat/auto-shepherd-s0
- HEAD: 9fa60c544e8c577378f102d4e10d167bd1426540
- last commit: 2026-07-26T19:22:17+05:30 "fix(ci): run doc-asserting suites when markdown changes (#457)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__auto-shepherd-s0 9fa60c544e8c   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__auto-shepherd-s0/commits/*.patch
git apply wip-archive/feat__auto-shepherd-s0/uncommitted.diff
cp -r wip-archive/feat__auto-shepherd-s0/untracked/. .
```
