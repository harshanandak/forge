# feat/pr-registration

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr-registration
- branch: feat/pr-registration
- HEAD: c2e8852cba7d9ec47819b66880a5d59014328210
- last commit: 2026-07-26T18:29:07+05:30 "feat(ship): register the created PR as a kernel_pr row"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__pr-registration c2e8852cba7d   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__pr-registration/commits/*.patch
git apply wip-archive/feat__pr-registration/uncommitted.diff
cp -r wip-archive/feat__pr-registration/untracked/. .
```
