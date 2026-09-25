# codex/p0-eval-blocker-integration

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/p0-eval-integration
- branch: codex/p0-eval-blocker-integration
- HEAD: 70662c602707293d470576ed18834b3a2cd8b023
- last commit: 2026-08-06T12:04:11+05:30 "fix: sanitize full-suite shard git environment"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__p0-eval-blocker-integration 70662c602707   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__p0-eval-blocker-integration/commits/*.patch
git apply wip-archive/codex__p0-eval-blocker-integration/uncommitted.diff
cp -r wip-archive/codex__p0-eval-blocker-integration/untracked/. .
```
