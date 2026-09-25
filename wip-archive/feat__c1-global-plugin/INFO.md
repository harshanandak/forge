# feat/c1-global-plugin

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/c1-global-plugin
- branch: feat/c1-global-plugin
- HEAD: e2ec22a399edb4ccbad871e5493b6da2c4600a42
- last commit: 2026-07-16T00:20:25+05:30 "docs(c1): design Forge as globally-active Claude Code plugin"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__c1-global-plugin e2ec22a399ed   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__c1-global-plugin/commits/*.patch
git apply wip-archive/feat__c1-global-plugin/uncommitted.diff
cp -r wip-archive/feat__c1-global-plugin/untracked/. .
```
