# Decisions: optional repository-scoped GitHub account context

## 2026-09-08 — plan approval lock

- Binding is clone-local only: `git config --local github.account`. Global Git config, `includeIf`, and environment overrides do not enable V1.
- Unmarked commands do no account-context work. Marked unbound routes perform one local Git-config lookup and no `gh`, network, token, or environment work.
- Forge never mutates `process.env`. A private context injects the selected credential only into actual `gh` children and narrowly scoped trusted GitHub workers.
- `forge github run` is the explicit trust boundary for harnesses. Its child receives `GH_TOKEN`, `GITHUB_TOKEN`, and `GH_HOST=github.com`; no token is printed or persisted.
- Named-token retrieval removes ambient GitHub token/host variables and pins `--hostname github.com`. Login comparison is case-insensitive.
- Repository access is checked during `github use` and `github status`, not before every guarded operation.
- The interactive launcher uses a direct `cross-spawn` runtime dependency. This avoids reimplementing Windows `.cmd` escaping and supports Codex/T3 shims as well as native executables.
- Registry metadata is validated. Context preparation runs after local stage enforcement and before the handler.
- Supported-route coverage includes foreground commands, detached monitor wakes, dashboard snapshot generation, and full behavioral-eval PR attribution. Unrelated Git, test, and browser children remain credential-free.
- The packaged public CLI aliases all target `bin/forge.js`. Direct developer invocation of the unshipped legacy `bin/forge-cmd.js` is outside the V1 guarantee and is locked as an explicit boundary rather than silently implied.

## Plan-review evidence

- Worktree HEAD and `origin/master` matched at `c67f5edb2965690de20fccee89ab480a1a475bf9` before the approval lock.
- `forge issue owns ee4869d5-77af-4959-909c-190e99b3ada0 --json` reported `owned: true` for `codex-github-account-context`.
- Git Bash merge simulation reported no conflicts with `origin/master`; the feature issue had no competing file-index claim.
- Independent review found and the plan corrected: repository-scope ambiguity, impossible zero-spawn claims, ambient token/host handling, broad process-environment leakage, Windows command-shim failure, incomplete GitHub route inventory, redundant repository-access checks, unvalidated metadata, and missing real-account release evidence.
- A local Windows process check proved direct `shell:false` launch works for `claude.exe` but returns `ENOENT` for the installed Codex and T3 command shims. This is the reason for the `cross-spawn` decision.

## Baseline test evidence

- `bun test` completed in 1055.59 seconds: 8066 pass, 32 skip, 1 todo, 9 fail, 5 module-load errors. This is not a green baseline.
- Observed failures included temporary Git `ENOTCONN`, 5-second worktree-test timeouts under full-suite contention, and missing `chalk` in the `packages/skills` workspace. No feature production code existed during this run.
- Focused rerun `bun test test/patch-intent.test.js test/eval/eval-runner.test.js test/scripts/dep-guard.test.js` completed with 56 pass and 0 fail; the first two observed contention failures did not reproduce.
- Validation must use the repository's resource-aware full-suite runner after dependencies are synchronized. The baseline failure is recorded, not rounded up to green.
