# codex/pr3b-memory-foundation

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/pr3b-memory-foundation
- branch: codex/pr3b-memory-foundation
- HEAD: 0ec87006191dc3017eedfba87624e781fa06c0d2
- last commit: 2026-08-10T05:51:55+05:30 "test(memory): make delivery timeout deterministic"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: 1 entries (1 untracked); untracked copied: 1
- also covers (their unique commits are a subset of this one): codex/pr3b-retention-review
- excluded: none

## restore

```
git switch -c restore/codex__pr3b-memory-foundation 0ec87006191d   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr3b-memory-foundation/commits/*.patch
git apply wip-archive/codex__pr3b-memory-foundation/uncommitted.diff
cp -r wip-archive/codex__pr3b-memory-foundation/untracked/. .
```
