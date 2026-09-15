# Forge delivery environment: reliable throughput for 5-10 PRs per day

Prepared 2026-09-15. Status: research and proposed implementation order; Astra independent document review PASS. No test, CI, branch-protection, workstation or merge-policy changes have been applied. Source baseline: fetched `origin/master` at `bd1abbd8ab63b590fd916dad379e0a575542fcc7`. The previous capability architecture remains parked in its separate research checkpoint.

## Recommendation

Prioritize delivery reliability before starting the broad 0.1.0 capability extraction. Reuse the existing resource-aware runner, risk manifest, validation receipt and protected merge path. Fix their disconnected call paths, consolidate repeated proof, and update only the next PR selected for landing. Keep parallel implementation, but bound expensive validation by the resources actually available.

Moving the entire workflow to another operating system is not yet justified by measurement. A Linux-native development/portable-test lane is a useful controlled pilot; native Windows remains responsible for Windows behavior. WSL shares this laptop's memory and is not additional compute capacity.

## Observed local environment

These are live read-only observations from one loaded-host sample, not a clean benchmark or proof of causal attribution.

| Observation | Result | Implication |
|---|---|---|
| Host | Windows 11 Home Single Language, build 26200; Ryzen 5 7235HS; 8 logical cores | Worker count must account for process-heavy tests rather than core count alone. |
| Memory | 23.7 GB total, 1.7 GB available | Several full suites cannot be assumed safe or fast concurrently. |
| Processes | 503 total; 39 Node processes, about 2.97 GB combined working set; WSL about 1.21 GB | Identify owners and lifetimes before cleanup. These numbers do not prove orphaning or identify the bottleneck alone. |
| Storage | About 325 GB free of 928 GB on C: | Capacity was not exhausted; disk latency and antivirus scan cost were not measured. |
| Worktrees | 146 registered, including seven nested worktrees | Registration count is not active load. Audit ownership and stale processes; preserve dirty/unmerged work. |
| Toolchain | Node 24.18.0; Bun 1.4.2; Git 2.51.0.windows.1 | Current tracked package manager pins Bun 1.4.2. The old healthy-suite timing used Bun 1.3.12. |
| Ubuntu | WSL2 kernel 6.6.87.2; Linux filesystem available; Node/Git under `/usr/bin` | A clean Linux pilot is possible, but has not been benchmarked. |
| Ubuntu Bun resolution | Resolves to a Windows npm shim under `/mnt/c/Users/.../AppData/Roaming/npm/bun` | This is not a verified Linux-native Bun environment. Resolve exact executables before testing. |
| Five no-op Node launches from PowerShell | 170, 326, 674, 569, 278 ms | Median 326 ms, substantial variation in this sample; not an isolated kernel process-launch benchmark. |
| Five `git rev-parse` launches from PowerShell | 414, 244, 186, 305, 205 ms | Median 244 ms. Repeated subprocesses can matter; do not extrapolate a suite speedup from five samples. |

Microsoft recommends keeping project files on the same operating system's filesystem as the executing tools: Linux tools and checkout inside WSL's Linux filesystem, Windows tools and checkout on Windows. A Linux pilot therefore uses its own checkout, dependencies and native Git/Node/Bun rather than sharing `/mnt/c` or `node_modules`. [Microsoft filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

Antivirus cost remains unmeasured. If profiling implicates it, use the supported performance-analysis/Dev Drive path after checking platform support; do not disable protection or add broad exclusions as an assumed performance fix. [Defender performance analysis](https://learn.microsoft.com/en-us/defender-endpoint/tune-performance-defender-antivirus), [Dev Drive guidance](https://learn.microsoft.com/en-us/windows/dev-drive/).

## What the merged work already fixed

The source-level checks below establish implementation presence, not fresh runtime certification of every prior PR. Preserve these fixes rather than rebuilding them.

| Merged PR | Improvement already present | Lesson for the next work |
|---|---|---|
| #495 | Isolated shard JUnit receipts, aggregate completion and incomplete-result rejection | Extend the current receipt path; no new test-result system. |
| #513 and #521 | Reduced fixture Git subprocess work; consolidated private CLI/Git fixture helpers | Prefer a shared fixture fix over one timeout increase per test. |
| #538 and #547 | Resource-aware full runner and Windows process-cost weighting | All broad test entry points must use this same runner. |
| #548 | Full-suite wall budget raised using a healthy 602.43-second Windows run, plus timeout diagnostics | A timeout is a bound, not a performance objective. Refresh the baseline for Bun 1.4.2. |
| #557 | Batched Bun pin/Git reads, resolver/cache corrections and resource-lane isolation | Reducing repeated process launches helps, but runtime/configuration boundaries need focused regression cases before first push. |
| #562 | Validator rejects unavailable roots, child failures misread as unavailable tools and missing terminal aggregates | Never regain speed by restoring false-green or false-skipped validation. |
| #563 | Opt-in project GitHub account routing | Account, environment and subprocess boundaries can produce substantial review rework; freeze that contract and its negative cases early. |

Source pointers: `scripts/test-full-suite.js:421`, `:479`, `:799`, `:1014`; `scripts/test.js:103`, `:116`, `:439`; `test/helpers/cli-subprocess.js:61`; `test/helpers/recall-memory-fixture.js:26`; `lib/commands/validate.js:614`.

## Recent hosted runs and merge policy

Live GitHub API/log inspection covered the latest 50 Actions records plus a bounded 30-run `Tests` sample on the account-routing branch. It is not an exhaustive history or a randomized performance benchmark.

| Sample | Observed result |
|---|---|
| Latest 50 Actions records, mixed events/workflows | One failed record, one cancelled record and one rerun attempt. This mixed sample must not be used as the overall test flake rate. |
| 30 account-routing branch `Tests` records | Median elapsed time 15.3 minutes; maximum 44.1 minutes; three failures, 11 cancellations and three rerun attempts. Counts overlap where a failed run was rerun. |
| Latest master test run | Failed after about 15 minutes on the Windows Node 22 package-install smoke. |
| Successful PR rerun | About 15.8 minutes in the observed attempt; about 39.7 minutes from the original run record. The difference includes earlier attempt/retry waiting and is not a measured runner-queue delay. |
| Representative failing Windows jobs | Full-matrix Node 22 job about 18.1 minutes; targeted Windows job about 22.1 minutes. Both encountered package installation timeout. |
| Smaller validator PR sample | Four test runs passed in about 3.0-3.7 minutes because the full OS-sensitive matrix was not selected. |

The package smoke timed out after 60 seconds inside `npm install --ignore-scripts <tarball>` and reported a null process result. It failed before merge, passed on rerun, then failed again on master. The timeout is reproduced in hosted evidence; whether network/registry behavior, npm, process teardown or resource pressure caused it remains unproved. Investigate and instrument that boundary under existing package-smoke issue `48386b65-4cab-4e75-9363-07a352e5997e`; do not treat another successful retry as a root-cause fix. [Failed master run](https://github.com/harshanandak/forge/actions/runs/34961763392), [PR attempt and rerun](https://github.com/harshanandak/forge/actions/runs/34953454360).

Live PR metadata also shows review/repair cost: account routing had 45 commits and 31 changed files; the validator correction had five commits; the Bun pin correction had 11. PR age, first-to-last commit time and active execution time are different measures. These counts establish repeated changed heads, not that every commit triggered the full matrix. The account-routing changes crossed CLI parsing, account/host identity, PATH launchers, Windows arguments, credential coexistence, locking, uninstall rollback and stale-target recovery. The lesson is to enumerate those boundaries before a large first implementation and split independent slices where the contract permits. [PR #563](https://github.com/harshanandak/forge/pull/563), [PR #562](https://github.com/harshanandak/forge/pull/562), [PR #557](https://github.com/harshanandak/forge/pull/557).

For OS-sensitive changes, tracked `test.yml` selects six full matrix jobs (three operating systems by two Node versions), four Ubuntu shards, Windows/macOS smoke, targeted Ubuntu/Windows lanes, separate coverage and E2E work. The required `CI Gate` waits for its owned lanes. CodeQL/ESLint/Docs runs were comparatively short in this sample; optimizing them first would miss the dominant delay. PR Monitor's event volume is noticeable, but its no-concurrency design intentionally avoids cancelled checks during `check_suite` bursts; do not add a generic concurrency group blindly.

Live protection requires six contexts: `CodeQL`, `ESLint`, `Analyze (javascript-typescript)`, `Run eslint scanning`, `Analyze (actions)`, and `CI Gate`. Strict freshness, admin enforcement, linear history and conversation resolution are enabled. Squash merge is enabled; merge-commit/rebase merges and auto-merge are disabled. The public repository is owned by GitHub user `harshanandak`, not an organization, and its rulesets response is empty. **Native merge queue is not available under the currently documented ownership eligibility.** Preserve these controls while changing the scheduling around them.

## Remaining delivery bottlenecks and correctness gaps

1. **The no-receipt push path is still disconnected from the safer runner.** `lib/commands/push.js:304` invokes the package test script; `package.json` defines that script as raw `bun test --timeout 15000`. A successful Forge push preflight writes a short-lived hook nonce, so the resource-aware hook does not repair this earlier choice. Existing issue `11e5ef49-5ae3-4cd0-a32e-0f233fc00ce8` covers this gap; its implementation is not in the inspected default ref. This is a priority fix before increasing parallel load.

2. **Qualifying validate-to-push test reuse already exists.** `lib/validation-receipt.js` binds a local authenticated receipt to a clean worktree, exact head, worktree scope and runtime identities, with a one-hour expiry. `lib/commands/push.js:350` reuses the test result when valid, while branch checks and lint still run. Rebase, new commits, dirty state, toolchain changes and expiry correctly invalidate it. A base advance alone does not change this local receipt's identity; that is not proof of compatibility with the new base. Tracked lock/config changes are already covered by changed head/clean-state checks; externally resolved configuration and future selective evidence need explicit input/policy identities. Extend the existing mechanism only where all required inputs and current policy can be verified.

3. **Strict base freshness creates repeated invalidation when every sibling is updated after every merge.** The validate/ship skills and server protection are strict, while executable `ship` readiness can return ready with a nonempty diff even when behind (`lib/commands/ship.js:77`, `:421`). PR Monitor also contains an automatic BEHIND-branch update path (`.github/workflows/pr-monitor.yml:320`), which creates new heads and can retrigger CI; default-token updates have a documented `CI_DEAD_HEAD` risk. Refreshing remote knowledge is cheap; rebasing every open branch repeatedly discards head-bound evidence. Align the actual automation and executable readiness under existing freshness issue `8d51c08b...`, then select one dependency-ready landing candidate and refresh it when required. Change workflow policy explicitly before altering any mandatory stage behavior.

4. **Fixture setup is repeated broadly.** CI forces all 15 Git fixtures across matrix, shard, follow-up, coverage and mutation paths (`.github/workflows/test.yml:123`, `:167`, `:327`, `:436`, `:529`). `test-env/helpers/fixtures.js:49` also busy-waits while acquiring a fixture lock. Provision only the fixtures required by the resolved test plan, retain private fixtures, and replace active lock spinning with bounded waiting without changing failure semantics.

5. **A CI edge-test path masks failures.** `.github/workflows/test.yml:393` invokes affected `test-env` tests with `|| true`. The local validator fix does not fix this CI path. Route errors through the existing fail-closed result owner and prove deliberate failure cannot produce green CI.

6. **One process can consume the broad-suite timeout.** Bun's per-test timeout does not reliably bound a synchronous child hang. The wrapper owns a full-run watchdog, but the scheduler lacks an independent per-shard wall deadline. Add the narrow missing deadline/heartbeat only where needed, retain diagnostics, terminate owned descendants and return `INCOMPLETE` rather than fabricate a pass.

7. **Explicit worker budgets need truthful lower-bound behavior and a supported entry point.** `scripts/test-full-suite.js:530` preserves at least one worker for the strongest lane even if its Windows process cost exceeds a user-supplied budget. Decide whether too-small budgets are rejected or normalized visibly; do not silently advertise a bound the scheduler exceeds. Canonical `forge validate` invokes the runner without forwarding its `--shards` control. It exposes no supported worker-budget flag; `FORGE_TEST_WORKERS` is not implemented, and `FORGE_TEST_TIMEOUT_MS` does not control this canonical path. Add validated passthrough through the existing receipt-producing command rather than inventing a second invocation. A focused pure scheduler regression can establish the result. Tracked as `e0cb0671-735c-4980-944b-286d6f78fe48`.

8. **Open issue state and merged source diverge.** Receipt reuse remains marked in progress despite code and a historical 47.5-second reuse push recorded in its issue; some pipeline work is marked done even though its manifest is not the universal runner policy. Reconcile each issue's full acceptance against current source and live proof before closing it. Status names alone are insufficient.

## Environment and responsibility split

| Surface | Proposed responsibility | Evidence retained |
|---|---|---|
| Developer worktree | Editing, focused regressions, fast lint/type feedback | Exact input/head and selected coverage; never promoted into a full-suite receipt. |
| Native Linux pilot | Portable tests and clean package/CLI reproduction, on Linux filesystem and native pinned tools | Same fixture/head/policy as the Windows comparison; measure before adopting as the default. |
| Native Windows | Windows shells, paths, process trees, filesystem locks, install and supported runtime behavior | All currently required Windows guarantees remain required until a validated replacement policy is adopted. |
| Hosted CI | Clean checkout, required matrix, complete artifacts and final integration candidate | Commit/base/tree, workflow policy, lockfile/runtime identities and terminal result. |
| Landing coordinator | Pick next ready PR, respect dependencies, refresh/prove/merge/re-fetch | Existing Forge authority, reviews, exact head and protected server merge. No second scheduler or custom lock. |

Start with one broad local validation at a time on this laptop. Parallel agents may implement independent work and run small bounded tests when resource headroom permits. Increase broad concurrency only after clean/loaded-host measurements show stable memory, process counts and completion. A later dedicated runner is justified by measured queue pressure; it is not necessary to buy or provision one during planning.

## Merge and validation model

```text
Independent branches: implementation + focused proof + review
                              |
                    dependency-ready candidates
                              |
                  select one landing candidate
                              |
       refresh base / update selected branch when required
                              |
    exact candidate validation -> qualifying receipt -> push
                              |
             required hosted checks + reviewed head
                              |
             protected merge -> verify remote result
```

Retain strict server protection. A client checking the base immediately before merge cannot eliminate a concurrent base change. An integration candidate's proof and a feature branch's proof are different artifacts; reusable component evidence never establishes an untested combined result.

Native GitHub merge queue is conditional on repository eligibility and required workflow support. GitHub documents it for public organization repositories and private organization repositories on Enterprise Cloud. Do not move ownership solely to obtain it. If unavailable, use the single just-in-time landing sequence above with existing protected controls. If later eligible, required checks must support `merge_group`, and Forge must bind final authorization to the tested integration/base candidate as well as the reviewed PR head. [GitHub merge-queue requirements](https://docs.github.com/en/enterprise-cloud%40latest/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

## Small implementation sequence

| Order | Bounded work | Existing owner or issue | Required exit |
|---|---|---|---|
| 1 | Fix no-receipt push routing, CI masked failures and recurring package-install smoke; retain terminal receipts | Resource-aware push (`11e5ef49...`), CI failure reporting (`ff0985f9-db02-482c-a08a-1a593e04cc88`), package smoke (`48386b65...`), durable terminal aggregate (`204fbfee...`) | Every broad entry point uses the supervised runner; deliberate child/edge failures cannot become green; package timeout is diagnosed and its regression passes on the merged artifact. |
| 2 | Establish reproducible validation environment and admission budget | Windows contention (`92c73bff...`), Windows resource budget (`9261d32a...`) | Exact tool paths and versions; one broad local run; clean/loaded-host baseline; owned process cleanup; no silent budget overflow. |
| 3 | Connect existing risk selection and evidence reuse | Pipeline (`2e2dd4e8...`), evidence ledger (`9072274f...`), receipt reuse (`4aed2cc8...`) | One resolved test plan reused by local/CI entry points; same relevant inputs reuse proof; unknown coverage takes conservative full route. Run in shadow before narrowing gates. |
| 4 | Consolidate CI and fixture setup while preserving coverage ownership | Pipeline owner; prerequisite `1bc68fd8-e515-4c2b-9d80-90525242ad25` | Remove only demonstrated equivalent work; retain supported OS/runtime/security/migration proofs; cancel only superseded runs of the same PR. |
| 5 | Align stage freshness and just-in-time landing | Freshness (`8d51c08b...`) plus pipeline owner | Ready siblings avoid repeated blanket rebases; selected candidate meets strict server protection and current head/base proof. |
| 6 | Reduce review-driven rework | Blast-radius verification (`26209ee2...`) | Freeze consequential boundaries and negative cases before code; batch known comments; validate reviewed final head; late boundary changes return to the affected owner. |

The test/CI entry-point changes share ownership and should merge in dependency order. Independent environment profiling and fixture corrections can run alongside them with disjoint files. Do not have separate workers independently rewrite `push.js`, `validate.js`, `test.yml` or the validation identity schema.

## Throughput and acceptance

For an illustrative eight-hour working window, ten landings permit 48 minutes of serial landing work per PR before any reserve; five permit 96 minutes. These are capacity arithmetic, not measured current performance. A proposed 20-30-minute stable landing service time would leave room for failures and human review, but must be demonstrated on representative changes before becoming a promise.

Measure local validation, push hooks, hosted queue, hosted execution, review rework and merge waiting separately. Track p50/p90 lead time, broad-suite executions per accepted change, receipt hit/miss reasons, base updates, retry rate, missing aggregates, leaked owned processes, provider minutes and escaped regressions. Fast output without trustworthy results does not meet the target.

Proposed acceptance: the declared Windows/Linux/runtime guarantees remain covered; deliberate missing/failed output always fails closed; selected test coverage matches full reference coverage for a shadow sample including docs, normal source, cross-platform, authority/security and migration changes; at least one realistic burst of five independent PR candidates completes without blanket sibling updates or uncontrolled local suite overlap. Statistical latency targets need a longer representative sample than that burst.

## Decision boundary

Recommended next implementation: close the disconnected push-runner and CI failure-reporting paths and diagnose the repeated package-install timeout first, then adopt measured environment/CI consolidation and the single landing sequence. The architecture extraction stays parked. This document authorizes no runner, CI, machine setting, protection-rule or merge changes by itself.

Independent review: Astra read the complete report and returned PASS with no material safety or correctness gaps. It specifically checked local-head versus integrated-base proof, the package timeout's unproved cause, retry-record age versus queue latency, current merge-queue ineligibility, native Linux pilot isolation, preservation of Windows guarantees, and shadow verification before narrowing gates. This is a planning review at document/source-evidence rung 2; the target throughput and proposed fixes are not yet achieved.
