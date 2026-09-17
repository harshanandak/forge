# Forge delivery reliability: evaluation and implementation proposal

Prepared 2026-09-17. Status: independently reviewed proposal; review corrections incorporated, implementation has not started.
Planning issue: `86c08a2e-7ccc-4da0-8912-1fd4ec5e3495`.
Pipeline parent: `2e2dd4e8-5144-4d77-9c7d-67dee25d7c6b`.
Source baseline: `origin/master` at `bd1abbd8ab63b590fd916dad379e0a575542fcc7`, fetched 2026-09-17.

## Decision and purpose

Improve delivery reliability before broad Forge 0.1.0 capability extraction. First recover the existing push fix, diagnose package installation failures, and make CI failure propagation truthful. Then bound local resource consumption and reconcile freshness policy before consolidating equivalent validation work. Reuse the runner, receipts, issue authority and required-check machinery already present.

The immediate benefit is fewer failed or repeated delivery attempts. Sustainable five to ten healthy PR landings per working day is a capacity goal, not a measured promise. Count merged changes with healthy terminal checks, not branches opened or tests skipped.

This document applies the plan critics/synthesis sub-skills to existing research. It is not a completed full plan-to-dev transition: implementation approval, worktree baselines and runtime acceptance remain pending. The review packet is [review-input.md](review-input.md); task details are [tasks.md](tasks.md); review attribution and corrections are [review.md](review.md).

The user-requested conversation audit and future-model evaluation are integrated in [conversation-learning.md](conversation-learning.md). The pasted earlier delivery recommendation is retained through this consolidated plan, with four reviewed corrections: the CI lane has a writer prerequisite, the stale push patch needs selective recovery, delayed branch refresh needs an explicit policy decision, and Graft is not a prerequisite for the reliability fixes. These are substantive corrections, not independent alternative plans.

Subsequent user direction selected a bounded Graft-assisted capability map before choosing implementation. Its source findings and observed tool blocker are preserved in [graft-capability-map.md](graft-capability-map.md). The delivery sequence below remains a proposal; this research authorization does not approve runtime changes or PR creation.

## Evidence already available

The preserved delivery analysis is on `docs/architecture-research-checkpoint`, head `d5438badcb8c71e946fe87018173bf1ad76d3f31`, at `docs/work/2026-09-15-delivery-environment/delivery-environment-analysis.md`. The architecture research archive remains separate and is not superseded by this operational plan.

- Tracked source includes the resource-aware full-suite runner, receipt reuse and the fail-closed validator from merged PRs #538/#547/#562. Extend them instead of creating replacements.
- The push fix remains in a clean registered worktree on `fix/push-resource-aware-docs`, head `76a730435ff7cb867ebdcb6a0b607ec38064e43f`, with two unmerged commits. No PR is open for this branch. Its historical test results are not proof against the current base.
- The latest master Tests run was refreshed on 2026-09-17 and is still failed: [master run](https://github.com/harshanandak/forge/actions/runs/34961763392), [Windows Node22 job](https://github.com/harshanandak/forge/actions/runs/34961763392/job/104356802367). The root-tarball install returned status=null and the test reached 60,154.41 ms against its 60,000 ms test limit; Bun reported one dangling process killed. The job had 8,668 passed, one failed and 33 skipped tests. Windows Node24 and the Ubuntu/macOS matrix controls passed. [PR run](https://github.com/harshanandak/forge/actions/runs/34953454360) also has successful Windows runs, which establish intermittency but not the cause. Network, npm, process ownership, working-directory and resource explanations remain hypotheses until measured.
- The September 15 analysis measured a 15.3-minute median in a bounded 30-run Tests sample for account routing. That is a historical branch sample, not a current global latency or flake-rate estimate.
- The shared root is dirty with pre-existing user work. Planning is isolated in `.worktrees/delivery-reliability-plan`; implementation uses a separate linked worktree per issue.

Source inspection is evidence rung 2. Historical hosted failures are runtime evidence for that historical head. No benchmark, fresh full suite or claimed speedup is established by this planning exercise.

## Existing work and exact ownership

| Work | Existing issue | Status observed | Next treatment |
|---|---|---|---|
| Push runner parity | `11e5ef49-5ae3-4cd0-a32e-0f233fc00ce8` | in_progress / validate | Recover and revalidate existing patch |
| Windows package smoke | `48386b65-4cab-4e75-9363-07a352e5997e` | open | Bounded diagnosis, then root fix |
| CI failure propagation | `ff0985f9-db02-482c-a08a-1a593e04cc88` | open | Blocked on legitimate workflow writer; then propagate test failures |
| Hand-maintained workflow authority | `a541c8ca-579d-4b8e-9bfd-7980b7547302` | open | Resolve the sanctioned edit/commit path before CI edits |
| Earlier test.yml writer proposal | `2db62bdd-f12e-4be5-b4f1-9c8eb65cd54a` | open | Reconcile with the workflow-authority issue; no competing grant mechanism |
| Validation resource budget | `e0cb0671-735c-4980-944b-286d6f78fe48` | open | Expose and enforce existing scheduling budget |
| Local receipt reuse | `4aed2cc8-57eb-451b-bb3a-02bbdd93af49` | in_progress / review | Verify remaining acceptance; do not reimplement |
| Durable terminal aggregate | `204fbfee-82d0-4504-bc45-f70a831108a4` | in_progress / validate | Reconcile exact implementation/evidence before closing |
| Freshness policy | `8d51c08b-8a02-480c-b6cd-d497deb769ea` | open / ship | Resolve acceptance conflict described below |
| Review convergence | `1bc68fd8-e515-4c2b-9d80-90525242ad25` | open | Batch known feedback and bind results to reviewed head |
| Evidence ledger | `9072274f-a14f-4518-b7b1-15eae0eba97d` | open | Extend existing evidence identity only after reliability |
| Risk-based pipeline | `2e2dd4e8-5144-4d77-9c7d-67dee25d7c6b` | open / blocked | Keep dependencies on convergence and evidence ledger |

The table is a dated planning snapshot. Kernel issues own status and dependencies. Do not create competing implementation issues or close parents because neighboring code merged.

## First implementation wave

Two ready preparation lanes, at most two concurrent code owners, one lead integrator. The CI lane is blocked on an existing authority prerequisite. Sol writes code; Luna handles bounded diagnosis/evidence gathering; the lead reconciles shared contracts and reviews results. Independent review is bounded by a concrete artifact, rather than repeated open-ended panels.

| Lane | Initial exclusive files | Result |
|---|---|---|
| Push parity | `lib/commands/push.js`, `test/commands/push.test.js` | Forge full push without a valid receipt enters the supervised runner; consumer repositories keep their configured command; valid receipt still avoids duplicate tests |
| Package reliability | `test/integration/standalone-package-smoke.test.js`, then only the helper proven to cause failure | Preserve real tarball/install/CLI journey and fix the measured timeout cause |
| CI propagation (blocked) | `.github/workflows/test.yml`, `test/ci-workflow.test.js` | After a legitimate writer exists, run edge tests with Bun and propagate failures into CI Gate |

Reserve `scripts/test-full-suite.js`, `scripts/test.js`, `lib/commands/validate.js`, `lib/validation-receipt.js`, `package.json` and shared fixture helpers to the integrator until one lane proves it needs them. Transfer ownership explicitly and record a dependency before edits. The lead owns shared CHANGELOG/documentation entries. Disjoint filenames alone do not establish logical independence.

Prepare push parity and package diagnosis in parallel. Land package reliability first if its failure blocks required checks; otherwise land the smallest ready independent fix with relevant platform proof. An OS path-filter omission is not a reason to omit relevant Windows validation, and master runs still need healthy terminal results. Do not merge a CI change that exposes a genuine failure and then suppress that failure to finish the train. Merge and inspect terminal checks for the merged commit before closing each child issue.

The refreshed master result makes package-install diagnosis the current first landing priority. Its test is already in an exclusive lane, so adding another exclusivity label is not a root fix. Measure pack, install, installed CLI startup and setup separately in the existing helper. Do not infer that the full 60 seconds belonged to network installation from a null exit status alone.

Recovery of the push patch must preserve its commits and clean worktree. The source review found merge conflicts in `push.js`, its tests and CHANGELOG, so reapply the useful behavior in a new issue-linked integration worktree against current source; do not blindly cherry-pick. The old probe merely checks for `scripts/test.js`, which a consumer repository can also own. Reuse the stronger Forge identity/capability predicate shape in `lib/commands/validate.js:601` (manifest and runner existence). Recover argument passthrough and external-repository fallback while preserving newer receipt and shepherd code. Never reset the old worktree or force-push to recover history.

The CI fix is also more than removing `|| true`: `test.yml:393` runs Node against tests importing `bun:test`. Use the canonical Bun invocation and retain the existing affected-plan condition and `followup-tests` ownership in CI Gate. A skipped no-work lane is distinct from an executed failed lane. Add result output only through the existing artifact path.

Fable identified and Sol independently confirmed an authority prerequisite: workflows are protected, and `test.yml` currently has only the Bun-pin writer. That writer derives exact pin changes from source HEAD and rejects unrelated edits. A human manually staging the change has no automatic exemption. Resolve the existing hand-maintained workflow issue and reconcile its earlier writer proposal before editing CI. Its design must preserve exact content-bound authority and normal, non-bypassed commits; do not add a blanket grant or overload the pin writer. This prerequisite is a separate owned change, not hidden scope inside the CI fix.

Push routing also has a coverage boundary: `scripts/test.js` can choose targeted or full execution. A targeted planner pass is a push gate, never a full validation receipt. Preserve the push issue's full-suite acceptance: when that gate requires full coverage, select and prove the existing full mode through the canonical planner. Do not silently substitute targeted execution or claim every planner invocation is a full run. Any change to that acceptance requires explicit reconciliation in the issue first.

## Freshness policy must be reconciled explicitly

The existing freshness issue requires behind=0 before development, validation, ship and push, and invalidates proof whenever the base moves. The proposed throughput model refreshes only a selected landing candidate. These are different policies. This plan does not silently amend the issue or installed skills.

Proposed replacement acceptance, requiring explicit acceptance before implementation:

1. Fetch/observe the default base when starting or resuming work and record it. Development and focused review may continue on a behind branch, with that condition visible; their results are not a merge authorization.
2. Distinguish local worktree evidence from final integration evidence. A base advance does not change already-tested local bytes, but does invalidate any claim about compatibility with the new base.
3. Final ship/readiness and protected landing require the selected candidate to satisfy current base policy, required checks, exact reviewed head and current integration proof. If the base or head moves, recompute the affected authorization; server protection remains the last guard.
4. Change branch-update automation, including PR Monitor's existing update-branch action, only as part of this explicit policy change. Initially use one human/lead-selected candidate and manual supported updates; no new scheduler or distributed lock.
5. Align CLI behavior, monitor policy, canonical skills and generated projections in one later PR with an integrator-owned file set. Do not narrow required OS, security, migration or release coverage.

The first reliability fixes can be prepared under current rules. They do not depend on accepting the replacement policy. The promised reduction in sibling refresh churn does depend on it; do not claim it from a prose-only operating rule.

## Resource and environment work next

After runner routing converges, expose the supported worker/resource budget through the canonical receipt-producing command. Reject an explicit budget that cannot admit the required lane, with the minimum valid value; if normalization is chosen instead, show requested and effective values and record both. Never silently exceed the advertised budget. Decide the public option spelling from existing CLI parsing; do not invent unsupported environment variables.

Start with one broad local validation at a time and bounded focused tests elsewhere. Measure tool executable paths/versions, available memory, concurrent child cost, wall time and owned-process cleanup on a quiet and representative loaded host. Reuse current runner artifacts and benchmark scripts; no monitoring service is needed.

A native Linux pilot is optional after Windows behavior is understood: its own checkout in Linux filesystem, Linux-native pinned Git/Node/Bun, and separate dependencies. A checkout under `/mnt/c` with Windows Bun is not a Linux baseline. Keep Windows-specific coverage. Do not disable antivirus, delete worktrees or terminate unidentified processes as performance tuning.

## Learn from delivery incidents without delaying the repairs

Alongside the first two preparation lanes, one bounded evaluation owner can prepare synthetic incident cases using existing corpus/evidence infrastructure. It owns evaluation fixtures and research artifacts only, not push, CI, package, validator or protected-authority source. Every runtime fix still carries its own meaningful negative and legitimate tests. Coordinate shared schemas through the integrator; do not require a new monitoring platform before fixing known defects.

The conversation audit adds scope/publication errors, stale monitoring claims, speculative review expansion and expensive validation before cheap preflight to the existing reliability cases. Enforce only established deterministic authority and evidence facts at supported boundaries. Start new progress/repetition heuristics as advisory observations with valid counterexamples. Preserve API/harness enforcement limits and local conversation privacy.

After terminal evidence is reliable, use matched model-by-workflow trials to measure verified outcomes, false blocks, correction effort and cost. Do not infer model intelligence from conversation anecdotes or merge latency. Keep the authority contract stable while versioned routing and workflow policies can improve with future models. Details, source anchors, sampling limits and the controlled trial design are in conversation-learning.md.

## Evidence reuse and CI consolidation later

Use the existing signed local receipt for unchanged clean validate-to-push reuse. Do not extend its TTL or share it across machines/worktrees as a shortcut. A broader ledger needs explicit command, exact source, toolchain, lock/config/policy and result provenance. Current ledger acceptance prohibits cross-SHA evidence reuse; content-equivalent reuse across commits would be a new design decision.

First generate a shared resolved test plan in shadow mode while full required checks continue to run. Cover docs, ordinary source, cross-platform behavior, authority/security and migration changes. Any unknown impact or missing coverage routes to the conservative full plan. Only consolidate fixture setup and checks proven equivalent in input, platform and assertions. A Linux pass cannot stand in for Windows path, process or install behavior.

Batch known review corrections into a coherent head; do not wait indefinitely for perfect feedback. A later comment still triggers the required focused correction and relevant validation. Use the existing convergence issue and keep exact reviewed-head checks.

## Graft: optional exploration experiment

Graft addresses repeated source exploration; its documented content-hash cache is a graph-extraction cache, not Forge test-result evidence. The relevant official sources are the [README](https://github.com/trailhq/Graft/blob/main/README.md), [changelog](https://github.com/trailhq/Graft/blob/main/CHANGELOG.md) and [telemetry policy](https://github.com/trailhq/Graft/blob/main/TELEMETRY.md). Prior vendor measurements are hypotheses for Forge, not measured local gains.

The user moved a bounded architecture pilot forward; that supersedes the earlier recommendation to defer all Graft work until after the reliability wave. The isolated 0.18.0 SDK attempt stopped before graph generation on a native dependency build prerequisite. The source map remains useful; Graft adoption and measured benefit remain unproved. A later retry should use a disposable pinned checkout and an environment with the required native build prerequisites. Use structural mode, no automatic harness wiring and no model summaries; disable telemetry using the supported setting. Do not add a Forge dependency or modify global hooks.

Use five fixed tasks drawn from routing, receipt invalidation, cancellation, package installation and CI dependencies. Compare current source search plus saved research against that same baseline plus Graft, using equal model/tool budget and source snapshot. Prepare expected files/callers independently and include a dynamic-registration case; alternate arm order to reduce warm-context bias. Count setup, graph refresh and tool startup cost in amortized results, and report cold and warm results separately.

Check edit, delete, branch-switch and separate-worktree freshness. Promotion requires no observed answer/source regression and a proposed >=20% median exploration-time or token improvement, with the metric chosen before running. Five tasks are a pilot, not statistical certification. A graph omission never justifies skipping mandatory tests. If the pilot misses that bar or consumes capacity needed by the reliability work, stop and retain the findings. Begin with CLI use if it succeeds; a capability adapter requires a demonstrated reusable API journey later.

## Acceptance, metrics and stop conditions

| Boundary | Required observation |
|---|---|
| Child/CI failure | Nonzero exit, null result, cancellation and missing aggregate cannot produce successful push or required CI status |
| Receipt reuse | Unchanged valid receipt produces zero duplicate full runs; a gate requiring full coverage runs exactly one supervised full suite when evidence is invalid; targeted planner output never becomes full proof |
| Isolation | Different worktree/head/runtime, dirty files, failed/zero/targeted/incomplete evidence are never accepted as full proof |
| Package smoke | Measured root cause or explicit unresolved diagnosis; focused regression plus consecutive clean Windows runs, sample size and timings reported; no retry-dependent completion claim |
| Resources | Peak admitted child cost <= declared effective budget; timeout/cancellation leaves no owned orphan processes |
| Merge | Required final-head and merged-commit checks are terminal and healthy; current strict protections are retained |
| Later selection | Shadow sample shows preserved required coverage; unknown cases choose full execution |

Record local focused test time, broad validation time/count, receipt hit/miss reason, push overhead, hosted queue and execution separately, review revisions, base updates and retry rate. Reuse existing JSON/JUnit/benchmark outputs. A realistic five-candidate burst is a later acceptance exercise after policy reconciliation; longer samples are needed for meaningful p50/p90 claims. The suggested 20-30-minute landing service time is a target to test, not today's SLA.

Pause implementation for unresolved authority, unowned shared-file changes, or evidence of a wider product bug. Known failures within the lane remain its diagnosis target; unresolved required-check failures block landing and closure. File or link the exact follow-up and re-scope with the lead. Do not grow package diagnosis into a runner rewrite or turn a graph pilot into a marketplace project.

## Boundaries and next entry

No marketplace, capability extraction, cloud runner provisioning, new cache service, test suppression, weaker branch protection, machine-wide tuning or automatic bulk worktree cleanup belongs in this wave. Cloud portability remains a future product constraint and does not require cloud deployment of this developer workflow now.

Before implementation: settle review corrections; select the first ready existing issue; read/claim/prove its live lease; recover or create its linked worktree; verify exact toolchain and focused baseline; run the negative regression then the smallest root fix. A docs-only planning change does not require rerunning the whole source suite solely to validate the prose. Planning completion is not runtime proof or permission to open implementation PRs.
