# feat/c4-adaptive-skills

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/c4-adaptive-skills
- branch: feat/c4-adaptive-skills
- HEAD: b9e80fb51ef02ca031baf98fcfeeb5e26b5bdbc3
- last commit: 2026-07-16T00:20:07+05:30 "docs: design adaptive self-initiating Forge skill flow (2b71e189)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__c4-adaptive-skills b9e80fb51ef0   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__c4-adaptive-skills/commits/*.patch
git apply wip-archive/feat__c4-adaptive-skills/uncommitted.diff
cp -r wip-archive/feat__c4-adaptive-skills/untracked/. .
```
