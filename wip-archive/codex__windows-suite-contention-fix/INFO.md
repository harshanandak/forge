# codex/windows-suite-contention-fix

- source: (local branch, no worktree)
- branch: codex/windows-suite-contention-fix
- HEAD: 2bd6f5cace739e92a029789e9fb15d515ed28d15
- last commit: 2026-08-09T04:11:24+05:30 "fix(release): use oidc-capable npm version"
- base: origin/master at archive time (956c2b45b89d9b79b66e314c419149fd72aef320)
- commits archived: 33
- uncommitted: none
- also covers (their unique commits are a subset of this one): codex/pr496-review-batch-a, codex/pr496-eval-review-batch, eval-1786227053234-162744, codex/beta5-release, codex/windows-suite-contention, codex/beta5-eval-seam, codex/beta5-auth-seam, eval-1786191011340-27104, codex/beta5-writer, codex/beta5-scorecard, codex/beta5-behavioral, codex/windows-node24-prepush-timeout, codex/windows-suite-contention-master, eval-1786217083549-142368
- excluded: none

## restore

```
git switch -c restore/codex__windows-suite-contention-fix 2bd6f5cace73   # if the sha still exists locally; else start from origin/master
git am wip-archive/codex__windows-suite-contention-fix/commits/*.patch
git apply wip-archive/codex__windows-suite-contention-fix/uncommitted.diff
cp -r wip-archive/codex__windows-suite-contention-fix/untracked/. .
```
