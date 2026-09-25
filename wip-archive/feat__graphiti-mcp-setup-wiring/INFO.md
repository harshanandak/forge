# feat/graphiti-mcp-setup-wiring

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.claude/worktrees/agent-a068d67fa3cbe01b3
- branch: feat/graphiti-mcp-setup-wiring
- HEAD: 03b4b082d767d8bc76a068ecd48184a313c3529a
- last commit: 2026-07-08T00:12:07+05:30 "fix(setup): surface the memory-config validator message in the Graphiti notice"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 2
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__graphiti-mcp-setup-wiring 03b4b082d767   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__graphiti-mcp-setup-wiring/commits/*.patch
git apply wip-archive/feat__graphiti-mcp-setup-wiring/uncommitted.diff
cp -r wip-archive/feat__graphiti-mcp-setup-wiring/untracked/. .
```
