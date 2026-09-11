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
- The packaged workflow aliases target `bin/forge.js`; the dedicated `forge-preflight` prerequisite binary is separate. Direct developer invocation of the unshipped legacy `bin/forge-cmd.js` is outside the V1 guarantee and is locked as an explicit boundary rather than silently implied.
- `github use` verifies a supplied login through the private context before writing the clone-local binding. The public CLI parser stops consuming options at `github run --`, so child flags remain child flags.
- Mixed-purpose team Bash processes never receive selected credentials. Their existing `GH_CMD` executable seam points to a checked-in, secret-free bridge that re-enters the same Forge runtime, which scopes the credential to the final `gh` child.
- Detached monitor/watch workers re-enter Forge and prepare their own context from the clone-local binding. Snapshot generation prepares context inside the worker and scopes it to `gh`; neither design delegates a token to unrelated descendants.
- The new `github` command participates in normal skill-coverage validation; it receives no exemption.
- Repository access resolves a validated `owner/repo` and passes it explicitly to `gh`. HTTPS and direct GitHub SSH work directly; custom SSH aliases are accepted only when local `ssh -G` resolves their host to `github.com`. Insecure HTTP/Git and non-GitHub origins fail before repository access or binding writes.
- Changes to the GitHub command or public CLI select both lifecycle and launcher regression suites through Forge's normal targeted-test maps.
- Registry changes select both the existing registry suite and the GitHub-context guard suite. Positional `help` is not a universal bypass; only actual `--help`/`-h` flags before a child delimiter skip account preparation.

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

## Dev integration recheck

- An independent Astra read-only pass traced Tasks 2-5 through the live execution graph at `10e5ef4193f91bf2b22ff13f4bf4adcdccebce37`.
- It found and the task map corrected: pre-write account preparation, top-level parser capture of child flags, missing skill-coverage ownership, mixed-purpose team credential leakage, and over-broad background worker inheritance.
- The corrections preserve the approved product contract while reducing token propagation: child workers resolve clone-local context themselves and only actual `gh` processes receive selected credentials.

## Task 4 review evidence

- The first intentionally failing foreground-route test run was incompletely isolated and reached native read-only Team verification and potentially Ship readiness/fetch. No PR creation or merge succeeded; read-only verification found unchanged HEAD/reflog, no clone binding, and no contemporaneous shared-config write. Every later route test used fail-before-native or fully injected subprocess seams.
- Independent spec and quality reviews found and corrected two boundary bugs before Task 4 exit: mixed-purpose Team Bash inherited ambient GitHub variables, and whole-argv global-flag stripping removed Team's documented `claim <id> --force` option.
- At the reviewed Task 4 head (`2c362fddb846d2cd835352b3bdbb91b8702f6a70`), Team removes ambient GitHub variables case-insensitively, normalizes Forge routing flags through one shared path, and preserves Team-owned flags verbatim.
- The fresh pinned-Bun 1.3.12 route proof completed with 398 pass, 4 existing skips, and 0 failures across 17 files; targeted lint, Bash syntax, manifest drift, embedded assets, Windows background spawns, and diff checks passed. Both independent reviewers returned PASS.

## Task 5 review evidence

- The Task 5 map expanded to the existing `lib/pr-monitor/watch-lifecycle.js` launch boundary because per-PR watcher children—not only the daemon—must re-enter the public CLI without inheriting a selected token. This is the shared root boundary for source and compiled watcher launches.
- Bound daemon, watcher, snapshot, and browser launch environments remove ambient GitHub variables case-insensitively after one clone-local binding read. Unbound launches retain native environment behavior. The re-entered GitHub worker prepares and verifies its own context.
- Snapshot generation prepares once internally and delegates only `gh` calls to the private runner. Full skill evaluation delegates the runner only to PR resolution and attribution; Git, Forge, browser, and evaluation-harness descendants remain separate.
- At the reviewed Task 5 head (`f06d2260d12b9361cfab549d8eab3d740d5c68b6`), the fresh pinned-Bun 1.3.12 proof completed with 384 pass and 0 failures across 18 files; targeted lint, manifest generation, Windows background-spawn, and diff checks passed. Independent spec and quality reviewers returned PASS.

## Task 6 review evidence

- Two real public Forge subprocesses ran concurrently against distinct temporary repositories and fully controlled fake named accounts. A readiness barrier proved overlap before release; each child observed only its selected login and repository.
- Wrong ambient GitHub variables could not redirect either bound child. Wrong-account and provider-error paths stopped before guarded handler entry, and fake credential canaries remained absent from stdout, stderr, errors, and serialized results.
- The unbound public route matched direct native-child behavior, including ambient GitHub variables. Array-based spawning preserved child flags, spaces, metacharacters, and empty arguments without a shell.
- `forge` and `forge-workflow` remain the shipped aliases of `bin/forge.js`; `forge-preflight` retains its dedicated prerequisite entrypoint and unaliased `bin/forge-cmd.js` remains outside the V1 guarantee.
- At the reviewed Task 6 head (`02e5f335ed72126dc39dc500262099599690e471`), the fresh pinned-Bun 1.3.12 proof completed with 204 pass and 0 failures across nine files; lint, manifest, and diff checks passed. Independent spec and quality reviewers returned PASS.

## Task 7 documentation and release evidence

Documentation describes the opt-in workflow in `docs/reference/github-accounts.md`,
linked from installation prerequisites and the canonical setup skill. Ordinary
setup remains unbound. API identity, commit author, Git transport, and the explicit
trusted-child authority boundary are separate; CuraPod adoption waits for the
merged, installed, accepted Forge build.

### Local validation (Windows, Bun 1.3.12)

The validation checkout started at `e0af0f36fb5b536dbb095dabe8d476f3d993ac53`.
All account checks used injected/fake providers and disposable Git repositories,
never real stored credentials. Full-suite processes used an empty temporary
`GH_CONFIG_DIR`, removed inherited GitHub token/host variables in their own
environment, and disabled incidental shepherd wakes.

- `bun test --timeout 15000 test/github-context.test.js test/github-launcher.test.js test/commands/github.test.js test/commands/_registry-github-context.test.js test/commands/github-route-matrix.test.js test/commands/github-indirect-routes.test.js test/integration/github-account-context.test.js test/structural/github-account-public-surface.test.js test/commands/_manifest.test.js test/docs-consistency.test.js`: 214 pass, 0 fail, 1,188 assertions, ten files, 12.07 seconds.
- The first `bun run test:full:parallel` completed with 8,325 tests: 8,289 pass, three fail, 33 skip, zero errors, 26,584 assertions. Receipts: `test-results/full-suite-HvcpvL/`. It exposed three feature integration omissions, not a green baseline: the exact exclusive-test list omitted both new subprocess suites; the setup skill did not yet document its mapped `github` command; the synthetic `/wt` Shepherd registry fixture lacked the new preparation seam.
- Scheduler RED: `bun test --timeout 30000 test/scripts/test-full-suite.test.js --test-name-pattern 'the discovered suite has complete exact resource-lane coverage'`: zero pass, one fail, 8.22 seconds. Adding exactly the two discovered exclusive files preserved equality and scheduling assertions. GREEN: `bun test --timeout 30000 test/scripts/test-full-suite.test.js`: 44 pass, zero fail, 199 assertions, 6.59 seconds.
- Skill/Shepherd RED: `bun test --timeout 15000 test/skill-accuracy.test.js test/shepherd-merge-safety.test.js`: 46 pass, two fail, 73 assertions, 0.862 seconds. The narrow fixes documented the optional command in the canonical setup skill and injected an unbound context in the existing synthetic test, without changing production guard/verdict behavior. The same command then passed: 48 pass, zero fail, 78 assertions, 0.902 seconds.
- `node scripts/sync-agent-skills.js` generated the required committed setup mirror through normal authorization; no mirror was hand-edited. The generic external skill validator rejects Forge's pre-existing `terminal` frontmatter; that unrelated schema was not changed. Forge's own skill accuracy, coverage, context-cost, and mirror checks remain the authoritative repository gates.
- `bun test --timeout 15000 test/skill-accuracy.test.js test/skill-coverage.test.js test/structural/skills-sync-drift.test.js test/skills/context-cost.test.js test/shepherd-merge-safety.test.js test/scripts/test-full-suite.test.js`: 119 pass, zero fail, 522 assertions, six files, 11.43 seconds, after mirror generation.
- A subsequent full run was stopped after the setup documentation change exposed its stale static scorecard, to avoid spending a complete run on a known generated-artifact mismatch. Focused RED `bun test --timeout 15000 test/skill-eval.test.js --test-name-pattern 'canonical AND mirror scorecard.json each equal the recomputed card'` reported only setup canonical/mirror drift (one fail, 0.368 seconds). `node bin/forge.js skill eval setup --static` regenerated only the setup card; normal mirror sync propagated it. The honest score delta is body lines 74 to 92, token-cost score 43 to 41, composite 83 to 82; no scoring thresholds changed.
- Final generated-artifact preflight: `bun test --timeout 15000 test/skill-eval.test.js test/commands/skill.test.js test/skill-accuracy.test.js test/skill-coverage.test.js test/structural/skills-sync-drift.test.js test/skills/context-cost.test.js test/shepherd-merge-safety.test.js test/scripts/test-full-suite.test.js test/windows-hide-background-spawns.test.js`: 192 pass, zero fail, nine files, 12.70 seconds.
- Final `bun run test:full:parallel`: **PASS**, exit zero, 8,325 tests (8,292 pass, 33 skip, zero failures/errors), 26,603 assertions, all 606 files in 27 resource-aware shards, 600.63 seconds elapsed. Windows worker budget stayed four: unit concurrency four, subprocess concurrency two at cost two, exclusive concurrency one. This supersedes the failed/incomplete runs above for the final documented tree; skipped tests are not represented as executed proof.
- `bun run lint` and `node scripts/gen-command-manifest.js --check` passed (62 commands). ESLint emitted only the existing Node module-type advisory, not a lint warning/failure.

### Compiled executable evidence

`bun run build:binary` succeeded, embedding 186 asset files and 38 executable
assets and compiling 508 modules. The final rebuild includes the updated setup
skill and its scorecard (bundle 184 ms, compile 1,114 ms). The local ignored artifact is
`forge-bin.exe` (120,903,168 bytes), SHA-256
`9751bc85b65a2eb73896d55f534d4e45dfb4cd4c9652e8a0f0ffee85fed95940`.

A temporary fake `gh.exe` was compiled with `bun build --compile <fixture>/fake-gh.cjs --outfile <fixture>/gh.exe`.
`node <fixture>/smoke.cjs <checkout>/forge-bin.exe` passed all seven checks:
disposable repository initialization and origin, unbound compiled status, local
binding, bound compiled status/access, wrong-account guard before handler entry,
and exact compiled launcher argv (including child flags, spaces, metacharacters,
and an empty argument). The fake provider rejected every unexpected invocation;
captured stdout/stderr were checked for credential canaries before reporting only
check labels and status. These are executed local checks (rung 4), not proof of
native credential-manager behavior with real accounts.

### POSIX CI and remaining acceptance

No new workflow is needed for the source launcher lane. At this checkout,
`.github/workflows/test.yml:141` defines PR `unit-shard` jobs on `ubuntu-latest`
with Node 24 and Bun 1.3.12, invoking
`bun run test:ci:shard -- --mode shard --shard-index <0-3> --shard-total 4 --label unit-shard-<index>`.
Live local discovery via `scripts/test-ci-shard.js.listAllUnitTests()` and
`scripts/test-full-suite.js.listAllFullSuiteTests()` included all three files:
`test/github-launcher.test.js`, `test/integration/github-account-context.test.js`,
and `test/structural/github-account-public-surface.test.js`. The PR follow-up
matrix also includes Ubuntu Node 24 and uses the existing targeted maps. Feature
changes to `bin/` and `package.json` select the full OS/Node matrix as well.

This is inspected CI configuration plus executed discovery, not a remote green
receipt: the exact pushed PR head must still pass its Ubuntu launcher lane before
merge. The existing Linux compiled-binary PR job smokes version/setup/ready,
not the account-specific compiled path. Account-specific compiled smoke was run
on Windows only. Real Windows credential-store acceptance with two stored
accounts remains a parent-owned, redaction-safe release gate; no such receipt is
claimed here. No CuraPod clone/account configuration was changed.
