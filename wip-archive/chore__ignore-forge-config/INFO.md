# chore/ignore-forge-config

- source: C:/tmp/fg-ignore
- branch: chore/ignore-forge-config
- HEAD: ef8e9455fe17ade188c6c9fb42583d71f197a9d0
- last commit: 2026-09-08T15:48:15+05:30 "Merge branch 'master' into chore/ignore-forge-config"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/chore__ignore-forge-config ef8e9455fe17   # if the sha still exists locally; else start from origin/master
git am wip-archive/chore__ignore-forge-config/commits/*.patch
git apply wip-archive/chore__ignore-forge-config/uncommitted.diff
cp -r wip-archive/chore__ignore-forge-config/untracked/. .
```
