# feat/readme-stage-counts

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/readme-stage-counts
- branch: feat/readme-stage-counts
- HEAD: c1184da0f19c818d10a74aab5d128916468a293d
- last commit: 2026-08-19T04:13:12+05:30 "feat(shepherd): converge guarded PR outcomes (#531)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/feat__readme-stage-counts c1184da0f19c   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__readme-stage-counts/commits/*.patch
git apply wip-archive/feat__readme-stage-counts/uncommitted.diff
cp -r wip-archive/feat__readme-stage-counts/untracked/. .
```
