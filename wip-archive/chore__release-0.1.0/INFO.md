# chore/release-0.1.0

- source: (local branch, no worktree)
- branch: chore/release-0.1.0
- HEAD: 1935fafc4b67d8edd0ed15e94123a1ad82f3671b
- last commit: 2026-07-08T19:09:34+05:30 "feat(ux): TTY-aware human output for issue writes (create/claim/close/…)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 9
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/chore__release-0.1.0 1935fafc4b67   # if the sha still exists locally; else start from origin/master
git am wip-archive/chore__release-0.1.0/commits/*.patch
git apply wip-archive/chore__release-0.1.0/uncommitted.diff
cp -r wip-archive/chore__release-0.1.0/untracked/. .
```
