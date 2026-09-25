# codex/skill-mirror-authority

- source: (local branch, no worktree)
- branch: codex/skill-mirror-authority
- HEAD: 26a36c5b968b32ccf1f95c68fc7331a902f21efb
- last commit: 2026-08-12T19:56:19+05:30 "fix(skills): reauthorize mirror sync retries"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 5
- uncommitted: none
- excluded: none

## restore

```
git switch -c restore/codex__skill-mirror-authority 26a36c5b968b   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__skill-mirror-authority/commits/*.patch
git apply wip-archive/codex__skill-mirror-authority/uncommitted.diff
cp -r wip-archive/codex__skill-mirror-authority/untracked/. .
```
