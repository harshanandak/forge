# codex/pr4b-review-evidence

- source: (local branch, no worktree)
- branch: codex/pr4b-review-evidence
- HEAD: e3937702cda75f612f1a4ea4e02241eb34c7b3af
- last commit: 2026-08-11T02:07:20+05:30 "refactor(review): consolidate summary detail output"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 6
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__pr4b-review-evidence e3937702cda7   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__pr4b-review-evidence/commits/*.patch
git apply wip-archive/codex__pr4b-review-evidence/uncommitted.diff
cp -r wip-archive/codex__pr4b-review-evidence/untracked/. .
```
