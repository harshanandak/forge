# codex/hotfix-proof-git-env

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/git-env-hotfix
- branch: codex/hotfix-proof-git-env
- HEAD: e99a16cdcaa8c1e77de66d44cc249ccee55f41b3
- last commit: 2026-08-10T00:28:47+05:30 "fix: isolate lockfile proof git environment"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- excluded: none

## restore

```
git switch -c restore/codex__hotfix-proof-git-env e99a16cdcaa8   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__hotfix-proof-git-env/commits/*.patch
git apply wip-archive/codex__hotfix-proof-git-env/uncommitted.diff
cp -r wip-archive/codex__hotfix-proof-git-env/untracked/. .
```
