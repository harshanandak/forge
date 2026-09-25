# feat/terminal-review-merge

- source: C:/Users/harsha_befach/Downloads/Personal-Projects/forge/.worktrees/terminal-review-merge
- branch: feat/terminal-review-merge
- HEAD: 91b140ca24305e03e414b4ec4a0112ed8a52bcbf
- last commit: 2026-08-06T19:18:58+05:30 "fix: make merge settle policy conditional"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 0
- uncommitted: 2 entries (2 untracked); untracked copied: 2
- excluded: none

## restore

```
git switch -c restore/feat__terminal-review-merge 91b140ca2430   # if the sha still exists locally; else start from origin/master
git am wip-archive/feat__terminal-review-merge/commits/*.patch
git apply wip-archive/feat__terminal-review-merge/uncommitted.diff
cp -r wip-archive/feat__terminal-review-merge/untracked/. .
```
