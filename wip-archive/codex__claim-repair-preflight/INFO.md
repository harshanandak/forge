# codex/claim-repair-preflight

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/claim-repair-preflight
- branch: codex/claim-repair-preflight
- HEAD: 4ccbcb7c70ffea552bf6154dba4c86f0d0df719e
- last commit: 2026-08-12T20:11:19+05:30 "fix: retain repair recovery inode through commit"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0 (tip is on origin as origin/codex/claim-repair-preflight; not patch-archived)
- uncommitted: 3 entries (3 untracked); untracked copied: 1
- excluded: none
- untracked not copied (2):
  - pr525-ledger.json (287KB > 256KB)
  - ubuntu24g-logs.txt (2438KB > 256KB)

## restore

```
git switch -c restore/codex__claim-repair-preflight 4ccbcb7c70ff   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__claim-repair-preflight/commits/*.patch
git apply wip-archive/codex__claim-repair-preflight/uncommitted.diff
cp -r wip-archive/codex__claim-repair-preflight/untracked/. .
```
