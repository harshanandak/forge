# feat/graphiti-memory

- source: (local branch, no worktree)
- branch: feat/graphiti-memory
- HEAD: 5d51da0df90cf8ed5561f09358e72ebe30cb8ca5
- last commit: 2026-07-06T15:00:56+05:30 "fix(memory): address CodeRabbit — doctor warns on missing MCP server; Neo4j creds"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/feat__graphiti-memory 5d51da0df90c   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__graphiti-memory/commits/*.patch
git apply wip-archive/feat__graphiti-memory/uncommitted.diff
cp -r wip-archive/feat__graphiti-memory/untracked/. .
```
