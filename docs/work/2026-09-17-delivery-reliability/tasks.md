# Delivery reliability: bounded implementation tasks

Prepared 2026-09-17 for planning issue `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`.
Status: proposal; runtime changes, PR creation and policy amendments have not been authorized by this artifact.
Design and constraints: [plan.md](plan.md). Independent review: [review.md](review.md).
Kernel issues own execution state. Task numbering below is execution order, not a second status store.

## Before starting a code lane

Read the relevant existing issue, claim it with a distinct actor and prove the lease. Inspect current remote, branch, dirty files, toolchain and issue-linked worktree. Verify the baseline before changing code. Preserve the shared root and all old worktree commits. One writer owns each file; the lead owns shared docs and coordinates any helper ownership transfer. One broad local suite at a time. Existing required checks and freshness rules apply until an explicit policy change lands.

Use the conversation findings to order existing checks: verify required dependencies and the relevant workspace imports before an expensive suite, then run affected regressions, then the required canonical full run. Reuse current setup/import checks and skip no required coverage. Retain the input fingerprint and result so an unchanged failed broad run is not repeated without a new hypothesis. Reconcile terminal-aggregate issue `204fbfee-82d0-4504-bc45-f70a831108a4`; import errors, missing child results and zero-test output must not be reported as a clean full pass. An intentionally repeated reliability trial remains valid and is labeled as such.

Observed local tools on 2026-09-17: Forge 0.1.0-beta.7, Node v24.18.0, Bun 1.4.2, Git 2.51.0.windows.1. Hosted Windows Node22 is a different test condition. `forge team verify` authenticates GitHub as `harshanandak` but reports no team-map identity; reconcile through the supported team setup before an implementation stage that requires it. No identity/configuration change was made during planning.

## CI prerequisite: resolve legitimate workflow edit authority

Existing issues: `a541c8ca-579d-4b8e-9bfd-7980b7547302` and earlier proposal `2db62bdd-f12e-4be5-b4f1-9c8eb65cd54a`. Reconcile them under one owner before Task 2. No new authority implementation is prescribed by this planning artifact.

The protected-state check requires exact content-bound writer authority. The current `test.yml` writer authorizes Bun-pin changes only; neither a manual human commit nor unrelated edits through that writer provide a valid path. Choose the existing issue's sanctioned design, document its source of truth, and prove an intended workflow edit commits normally while unauthorized changes still fail. Keep genuinely generated workflows protected. Any writer or protection-classification changes require their own security review and negative regressions, outside Task 2. No hook bypass or blanket grant.

## Task 1: Diagnose and fix the Windows package-install failure

Issue: `48386b65-4cab-4e75-9363-07a352e5997e`. Luna owns diagnosis; Sol owns any code change. Can prepare alongside Task 3. Task 2 remains blocked on its authority prerequisite.

OWNS: `test/integration/standalone-package-smoke.test.js`. Any shared subprocess/pack helper needs an explicit ownership transfer before editing.

What to implement: first determine which operation exhausts the bound. Capture exact failed head, OS/runtime/tool paths, pack/install/launch elapsed times, exit status, signal/error, bounded stdout/stderr and tarball dependencies. Distinguish test fixture, npm/network, process cleanup and product package failures. Preserve installation in a fresh directory and execution of the installed CLI. Change only the boundary shown responsible.

TDD and evidence steps:

1. Reproduce the historical failure at its exact artifact where feasible; otherwise record it as hosted historical evidence, not a new reproduction. Run the focused suite once with operation-level diagnostics on the current supported Windows/Node combination.
2. Establish a control with the same head, package, toolchain and process budget. Vary one suspected cause (for example registry/cache access) at a time. Do not repeatedly rerun an unchanged failure without a new hypothesis or additional evidence.
3. Add the smallest deterministic regression at the proven fault boundary: inject child timeout/nonzero/null output and assert bounded termination, diagnostic preservation and failed/incomplete result. Add a real success-path check that still packs, installs and launches the artifact. Do not replace the integration journey with a mock.
4. Show the regression failing for the identified cause, make the shared root fix only if warranted, and rerun the focused regression and package journey. Initial smoke command: `bun test --timeout 15000 test/integration/standalone-package-smoke.test.js`; preserve its test-level and subprocess limits while diagnosing.
5. Report repeated clean Windows runs with N, each elapsed time and cache/network conditions. Choose the repeat count before running; a small sample cannot certify absence of flakes. Hosted final-head and merged-commit checks remain required.
6. Commit only the proven fix and focused tests, e.g. `fix(test): make standalone package installation reliable`; describe the actual cause in the final commit/PR text.

Expected output: causal explanation with source/log evidence, meaningful failing-then-passing regression, unchanged install assertions, no orphan owned processes, and healthy required Windows checks. If cause remains unknown, publish the bounded diagnosis and next discriminating experiment; do not claim the bug fixed or expand into a general runner rewrite.

## Task 2: Correct and fail-close the affected test-env CI step

Issue: `ff0985f9-db02-482c-a08a-1a593e04cc88`. Sol owns this lane after the workflow-authority prerequisite is satisfied. Until then, restrict work to source inspection and test design; do not start a workflow patch that cannot pass the normal commit gate.

OWNS: `.github/workflows/test.yml`, `test/ci-workflow.test.js`.

What to implement: replace the Node invocation of Bun-based tests and failure masking at `test.yml:393-398` with the existing Bun command shape `bun test --timeout 15000 test-env/`. Preserve the affected-plan condition, setup dependency and `followup-tests` ownership in CI Gate (`test.yml:574-622`). If adding JUnit output, use the existing artifact/profile path and ensure missing output cannot count as success.

TDD steps:

1. Extend the existing follow-up step regression to reject `node --test` and `|| true`, require the Bun timeout/affected condition, and retain CI Gate's dependency on `followup-tests`. Confirm it fails against current source.
2. Add or reuse a focused behavioral fixture that executes the selected step command with a deliberately failing Bun test and checks nonzero propagation. A text assertion alone does not prove the runtime failure path. Preserve explicit no-work skip semantics separately.
3. Implement the minimal workflow correction using the sanctioned writer/edit path. Do not invent a new job/status aggregator or apply workflow-wide ignore-error settings. Re-read the resulting content-bound authorization before commit.
4. Run `bun test test/ci-workflow.test.js`, then the affected test-env command with its required fixtures. Prove pass, fail, and deliberate no-work behavior; source-level dependency proof is supplemented by terminal hosted CI before closure.
5. Commit `fix(ci): run affected edge tests with Bun and propagate failures`.

Expected output: correct runtime, nonzero test result fails the owned job and required gate, no-work remains explicit, unchanged required matrix. Use a local deliberately failing fixture for negative proof; an intentionally failing throwaway hosted PR is not authorized by this plan.

## Task 3: Recover push-runner parity without losing newer receipt work

Issue: `11e5ef49-5ae3-4cd0-a32e-0f233fc00ce8`. Sol owns this lane. Can prepare alongside Task 1.

OWNS: `lib/commands/push.js`, `test/commands/push.test.js`. Lead integrates CHANGELOG. A shared identity helper is allowed only if its existing consumers and ownership are verified first.

What to implement: manually reapply the useful behavior from `b330cbe7` and `76a73043` to current source. A merge simulation found conflicts in push source, tests and CHANGELOG, so preserve old history and use a current issue-linked worktree. Current `push.js:294-323` executes package tests; `:373-380` already handles receipt reuse. Reuse `scripts/test.js` as the Forge planner and preserve generic consumer package commands. Identify Forge by the existing manifest/runner capability predicate shape from `validate.js:601-607`, not merely existence of `scripts/test.js`.

TDD steps:

1. Add failing regressions for Forge no-receipt routing to the planner and planner nonzero blocking Git push. Include a consumer repository that owns its own `scripts/test.js` but must still use its configured package command.
2. Keep/add cases showing valid receipt skips full tests while branch protection, lint and push still run; invalid/stale receipt takes the correct full route when full coverage is required. The planner supports targeted and full modes: explicitly prove the required full selection and that targeted results never mint or refresh a full validation receipt. Preserve the existing issue's full-run acceptance unless explicitly amended; preserve malformed/tampered/head/runtime/dirty/incomplete/zero-test negatives rather than duplicating the entire receipt suite.
3. Add delimiter cases: no Forge delimiter forwards real args; first `--` is consumed; a later Git `--` remains. Preserve newer shepherd startup behavior.
4. Implement the smallest routing and argument-boundary changes. Do not overwrite the current file with its old version.
5. Run `bun test test/commands/push.test.js test/scripts/test-runner.test.js` and directly relevant receipt tests if that boundary changed. Confirm the observed commands/results, not only mock counts.
6. Commit `fix(push): reuse the supervised Forge test planner`. Run one canonical full validation on the final clean head; push unchanged and verify the existing receipt prevents a duplicate full run. Required hosted checks remain separate.

Expected output: exactly one supervised full run when the gate requires full coverage and lacks usable evidence; zero duplicate full runs with usable evidence; any separately permitted targeted push gate is labeled targeted and never becomes full proof. Failed/incomplete planner blocks push, external repositories keep their command, argument and shepherd behavior survive recovery.

## Task 4: Make the validation resource budget reachable and truthful

Issue: `e0cb0671-735c-4980-944b-286d6f78fe48`. Sequential after runner-route reconciliation; not a prerequisite for preparing Tasks 1-3. If their final validation requires the new budget, explicitly land this dependency first.

OWNS: `scripts/test-full-suite.js`, `test/scripts/test-full-suite.test.js`, `lib/commands/validate.js`, `test/commands/validate.test.js`; exact command help/metadata only if required for truthful discoverability. Lead owns any shared receipt schema decision.

What to implement: reject positive explicit budgets too small for required subprocess or exclusive lanes before spawning. Current forced minimum-one behavior can exceed a Windows budget of one when the lane costs two (`test-full-suite.js:488-545`). Use the already supported `--shards N` vocabulary unless existing CLI conventions dictate otherwise, and describe it honestly as the runner's resource budget. Thread the validated argument through validate handler, executeValidate, runAllTests and runner invocation; record requested/effective settings in existing test-result evidence. Do not add an unimplemented environment-variable interface.

TDD steps:

1. Extend pure scheduler tests near the existing budget cases: Windows budget one with required subprocess/exclusive cost two rejects before spawn; budget two admits one cost-two worker; unit-only affordable combinations work; all lane grants stay within budget.
2. Extend validate tests: zero/negative/noninteger/missing argument is rejected; valid N is forwarded unchanged; absent option preserves default behavior; evidence records the selected budget; targeted/zero/missing aggregate cannot become full receipt.
3. Implement validation once at the narrow shared boundary, including exclusive lanes. Preserve full coverage and aggregate semantics.
4. Run `bun test test/scripts/test-full-suite.test.js test/commands/validate.test.js`. Then one supervised Windows run confirms measured peak admitted cost, terminal result and owned-process cleanup; do not run broad competing suites.
5. Commit `fix(validate): enforce and expose the full-suite resource budget`.

Expected output: declared effective limit is honored, impossible requests explain the minimum, all required tests still run, successful results remain compatible with ordinary receipt reuse. Store budget metadata in run evidence; do not change receipt identity or its schema merely for a concurrency setting that preserves coverage.

## Later tasks: preserve scope without starting them now

- Incident regression preparation (`d362bd71-cd0c-4178-a11e-0069382ae949`, existing behavioral eval work): reuse the current corpus/oracle and model-neutral evidence. One evaluation owner prepares the 12 synthetic development fixtures in [conversation-learning.md](conversation-learning.md), each with a legitimate counterpart and expected evidence outcome. Preserve the existing 300-case corpus, 30/100/300 tiers, split and promotion gates; version any extension rather than overwriting frozen packets. Reserve unseen holdout variants. Own evaluation fixtures only; do not edit runtime lane files or block their diagnosis while building evaluation infrastructure. The current zero-tool runner grades decisions; real tool-effect proof requires separate deterministic fixtures or an explicitly scoped isolated executor.
- Scope and observation contracts (`b4a63278-8f95-4c98-9b79-9b31526ff805`, bounded worker work, currently blocked): map incident requirements onto current public authority/lifecycle APIs first; honor its existing dependencies before runtime implementation. Preserve prior valid authorization, scope revision/revocation, target-versus-coordinator identity and observed-versus-delivered status. Add fields only for concrete gaps. Initially shadow new repetition/progress heuristics; test valid waiting and authorized repetition. No generic shell-enforcement claim or autonomous policy rewrite.
- Monitoring delivery (`4439b12e-36d6-4e76-8b5a-a4c409c6c17e`): reconcile the existing activation-observability issue. A live watcher, stored verdict and active-session notification are different observations. Test missed delivery and a fresh explicit pull; bind readiness to the current head/check snapshot. No second monitor daemon.
- Detector false positives (`e00dc2ef-1b3c-4343-afef-521942959f1a`): the documentation-save check reproduced a legitimate-prose false block in the retired-command guard. A separate small fix owns that test file and retains true-command rejection. Add the incident as a valid-action evaluation case; don't weaken the gate or mix its implementation into this plan.
- Model/workflow evidence (`02f5ea90-4a1a-462f-9b22-54eb5d37f6b3` is existing completed infrastructure, not a new implementation issue): verify current fields and extend through the open behavioral-eval/evidence issues. Join actions to observed route, exact inputs and outcome; keep missing attribution unknown. Run the frozen same-harness 2x2 only after instrumentation works, with independent state and complete failed/interrupted denominators. Produce one reproducible report before considering model-routing changes.

- Freshness alignment (`8d51c08b...`): first accept or reject the replacement acceptance in plan.md. Then one owner updates ship/readiness, monitor update policy, canonical skills and projections. Test dirty tree, remote failure, head/base races, behind branches and skipped candidate updates. No current rule is silently bypassed.
- Review convergence (`1bc68fd8...`): use a bounded feedback window and one coherent correction batch; retain new-head checks. Avoid unbounded waiting for reviewers.
- Evidence ledger/pipeline (`9072274f...`, `2e2dd4e8...`): reconcile existing receipt/aggregate issues first; one input identity and resolved test plan; full reference execution in shadow before selective gates. Keep exact-SHA restrictions until separately redesigned.
- CI/fixture consolidation: prove equivalent coverage and environment identity before deleting duplicate work; retain OS-specific assertions and meaningful package installation. Reuse `scripts/benchmark.js` only after verifying the selected group executes the current canonical command; its legacy validate group is not automatically representative.
- Graft experiment: defer until the reliability wave has capacity; fixed five-task structural-only disposable-clone comparison specified in plan.md. No Forge adapter or automatic hooks until measurable benefit and a reusable capability journey exist.

## Landing and final handoff

First land the package root fix if required Windows checks block the train. Otherwise take the smallest ready independent lane. Refresh and validate only the selected candidate where current policy permits; mandatory freshness behavior is unchanged until its policy PR lands. No simultaneous edits of reserved files. Full-suite proof and hosted integration proof are distinct.

For each child issue, save `summary`, `decisions`, `artifacts`, `next` and exact head/test/CI identifiers; re-prove ownership before closure. Check all required final-head and merge-SHA results. Leave parent/remaining issues open. A green retry alone is insufficient to close the package reliability issue.
