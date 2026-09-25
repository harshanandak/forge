# feat/subagent-renderers

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/t2-subagents
- branch: feat/subagent-renderers
- HEAD: 606a50534c7a3d1a4c050438c216f6d5e496d9ae
- last commit: 2026-07-06T19:27:11+05:30 "feat(agents): canonical role manifest + symmetric .claude/.cursor subagent renderers (802aa4d8)"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 1
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__subagent-renderers 606a50534c7a   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__subagent-renderers/commits/*.patch
git apply wip-archive/feat__subagent-renderers/uncommitted.diff
cp -r wip-archive/feat__subagent-renderers/untracked/. .
```
