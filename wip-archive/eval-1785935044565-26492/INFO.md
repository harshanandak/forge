# eval-1785935044565-26492

- source: (local branch, no worktree)
- branch: eval-1785935044565-26492
- HEAD: bc855e5749947f4c87824b223070cab5f5e95db4
- last commit: 2026-08-05T18:25:18+05:30 "docs: plan eval evidence replay"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 3
- uncommitted: none
- also covers (their unique commits are a subset of this one): codex/fix-approval-inheritance-pre-review
- excluded: none

## restore

```
git switch -c restore/eval-1785935044565-26492 bc855e574994   # if the sha still exists locally; else start from origin/master
git am wip-archive/eval-1785935044565-26492/commits/*.patch
git apply wip-archive/eval-1785935044565-26492/uncommitted.diff
cp -r wip-archive/eval-1785935044565-26492/untracked/. .
```
