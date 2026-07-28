# Forge 0.1.0 Stable Release Tasks

Each S0 implementation follows its configured Forge workflow, explicitly running `/plan → /dev → /validate → /ship → /review` and then `/verify` for Critical work; any classification-based omission must be recorded rather than silently skipped. Every task gets its own Kernel issue, Forge worktree, RED→GREEN→REFACTOR evidence, review settlement, and close-after-merge verification. Each stage exit records non-empty `Summary`, `Decisions`, `Artifacts`, and `Next` fields, with test evidence and process friction when relevant. After every merge, run separate **Work** and **Process** reviews: verify the delivered behavior and then record what Forge failed to surface, trigger, retrieve, enforce, diagnose, or clean up. Structural friction is immediately linked or filed and ranked so working on Forge continuously improves Forge itself.

## Phase 0 — stabilize the baseline

- [ ] Gate and merge PR #460 at its current head; verify CI, mergeability, zero unresolved threads, and review quiet time.
- [ ] Reproduce `test/v2-fixture-corpus.test.js` failure from PR #461's pre-push lane.
- [ ] Fix the fixture failure if deterministic; otherwise prove the external transient mechanism before rerun.
- [ ] Push the frozen-lockfile fix or defer/close PR #461 with the dependency issue still tracked.

## Phase 1 — freeze the stable blocker cohort

- [ ] Export the 407 open issues into a deterministic classification input.
- [ ] Partition the inventory into eight read-only triage batches; each evaluator returns S0/S1/R/D, evidence, duplicate target, and dependency candidates in a fixed schema.
- [ ] Centrally deduplicate the eight outputs and adversarially verify every proposed S0 or closure before writing Kernel state.
- [ ] Reconcile all children/comments of `068374e5` and `ce1f84b3` against current code and merged PRs.
- [ ] Inspect every candidate in `plan.md` from its full issue record and current implementation.
- [ ] Assign S0/S1/R/D with a one-sentence evidence-backed rationale.
- [ ] Close verified duplicates/completed issues through Forge and re-read each closure.
- [ ] Add Kernel dependencies that encode the actual merge order; refuse and verify cycles.
- [x] Publish the 14-issue S0 list, working order, and collision map as an issue comment on `068374e5`.
- [x] Promote terminal release task `8e634347` to P0 and block it on all 14 S0 issues.
- [x] Record verified ordering edges: `f0385fa1 → c81eb263 → d362bd71`; `588e6973 → d362bd71`; `6bc72f4f → d362bd71`; `8606ea93 → cb8c7ab6`.
- [ ] Lock measurable thresholds for automatic-context precision, recall, miss rate, latency, and token cost before enabling it.

## Three-hour cycle board

Each cycle carries at most four non-colliding PRs from implementation through merge and cleanup.

| Cycle | Slot A | Slot B | Slot C | Slot D | Target |
|---|---|---|---|---|---|
| 1 | Mutation truth | Worktree root | Automatic memory | Automatic Shepherd | 4 merged PRs |
| 2 | Setup/config trust | Worktree linkage | Process reaping | Test fail-closed | 4 merged PRs |
| 3 | Skills-only adoption | Packaged dispatch | Skill trigger surface | Release publication gate | 4 merged PRs |
| 4 | Behavioral holdout gate | Hook integration | Beta release evidence | Contingency/stopper | Feature-complete beta.5 |

- [ ] At each cycle start, record issue ID, owner, worktree, files owned, dependency state, and expected tests for all four slots.
- [ ] At cycle end, record opened/green/merged counts, median cycle time, review turns, blocker cause, Kernel close verification, and worktree cleanup.
- [ ] Replace a blocked slot with another non-colliding ready issue instead of idling the other lanes.
- [ ] Route bounded independent implementation, tests, log analysis, or bulk triage through the installed Codex plugin when useful; keep every worker in its own Forge worktree and retain central merge/dependency ownership.

## Phase 2 — four parallel S0 lanes

### Lane A: automatic skill and diagnostic selection

- [ ] Fit canonical trigger descriptions inside the model-visible limit (`588e6973`).
- [ ] Restore the packaged agent-agnostic dispatch pointer (`6bc72f4f`).
- [ ] Make skills usable without enforcement hooks (`c81eb263`).
- [ ] Add behavioral trigger, confusing-neighbor, variance, and holdout evaluation (`d362bd71`).
- [ ] After `588e6973`, `6bc72f4f`, `c81eb263`, and `36461e50` land, use `d362bd71` as the named owner of the cross-lane integration tail: wire skill, memory, `status`, `insights`, `doctor`, `recommend`, and `upgrade` routing through one bounded hook envelope and prove selection, rejection, latency, token-budget, and error telemetry. The terminal release task remains blocked by `d362bd71`, so the cohort cannot report complete before this evidence passes.
- [ ] Include agent-triggered diagnosis for existing `status`, `insights`, `doctor`, `recommend`, and `upgrade` capabilities; full automatic skill extraction remains gated/post-stable.

### Lane B: automatic memory

- [ ] Trace the existing `lib/hook-renderer.js` SessionStart memory-inject and UserPromptSubmit memory-recall path end to end; identify why agents still miss relevant memory in real use.
- [ ] Implement the remaining ctx-grade federated recall floor (`36461e50`) without creating a duplicate hook path.
- [ ] Verify bounded SessionStart orientation/index injection is installed and reaches every supported harness.
- [ ] Make existing project-scoped prompt-time recall reliable with provenance, budgets, telemetry, and visible empty/error outcomes.
- [ ] Run positive, stale-memory, scope-isolation, duplicate, and holdout evaluations.
- [ ] Enable bounded automatic injection only after the locked thresholds pass.

### Lane C: lifecycle trust

- [ ] Preserve existing harness instructions during setup (`f0385fa1`).
- [ ] Stop lazy config from silently disabling gates (`183d38fc`).
- [ ] Make refused issue closes return failure and prove no mutation (`940b904b`).
- [ ] Fix resolved-root worktree subprocess execution (`8606ea93`).
- [ ] Fix missing work-folder marker/linkage repair on reuse (`cb8c7ab6`).
- [ ] Reap orphaned test shards and claims after stopped hooks (`87a8394e`).

### Lane D: automatic PR ownership, test, and release evidence

- [ ] Automatically attach/start contained Shepherd monitoring whenever an active open or draft PR exists (`49f438f0`).
- [ ] Keep `gh pr view` available for instantaneous detail during the approximately 60-second refresh gap, while Shepherd remains the authoritative continuing monitor.
- [ ] Remove affected-test HEAD fallback false-greens (`10a6f241`).
- [ ] Claim and fix the release-workflow coverage issue (`af79e102`).
- [ ] Make publication consume same-SHA full release evidence, including package-skills and environment coverage.
- [ ] Build clean/upgrade/rollback Windows and Linux release journeys.

## Phase 3 — feature-complete beta.5 (2026-07-31)

- [ ] Verify all 14 S0 issues are merged, closed, and re-read from the Kernel.
- [ ] Create the beta.5 release issue/worktree from the final S0 head.
- [ ] Add the missing beta.4 changelog history and replace the stale v0.0.11 release reference with the current beta-to-stable and registry rollback procedure.
- [ ] Update `package.json`, `CHANGELOG.md`, release notes, and public version references for `0.1.0-beta.5`.
- [ ] Run lint, full parallel tests, release readiness, package dry-run, install-from-tarball, and supported-platform journey tests on one SHA.
- [ ] Merge the release PR, create `v0.1.0-beta.5`, verify OIDC/provenance publication and npm `beta`, then run fresh-install and upgrade smoke tests.
- [ ] Begin 48-hour postpublish and seven-day beta.5 soak. No new command, feature, schema, setup footprint, or breaking default enters after this point.

## Phase 4 — RC1 and RC2

- [ ] Verify beta.5 completed seven days of feature-frozen soak with no open release stopper.
- [ ] Reject roadmap additions; any new feature, command, schema, setup footprint, or breaking default resets to a new beta.
- [ ] Run the complete release-candidate gate on one commit.
- [ ] Publish `0.1.0-rc.1` under a prerelease dist-tag.
- [ ] Test clean and existing repositories on Windows and Linux.
- [ ] Test supported Claude, Codex, Cursor, and Hermes clean-install, skill discovery/invocation, projection, activation, and hook-delivery paths wherever the repository advertises support.
- [ ] Run automatic-context holdouts and inspect misses, false positives, stale retrievals, and token use.
- [ ] Run rollback to beta.5 in a disposable project.
- [ ] Publish RC1 on 2026-08-07 only after seven days of beta.5 soak.
- [ ] Allow only reproduced release-stopper fixes after RC1.
- [ ] Require RC2 after any behavior change following RC1; publish RC2 on 2026-08-14 only after repeating the full matrix and resetting every affected evidence/soak gate.
- [ ] Before promotion, prove two weekly RC gates and at least 14 cumulative RC soak days.
- [ ] Exercise the complete rollback: deprecate the affected npm version, restore the prior dist-tag, revert through a reviewed PR, and preserve the failure as a Kernel issue plus regression fixture.

## Phase 5 — stable promotion (2026-08-21)

- [ ] Fix only reproduced release stoppers after RC1; every behavioral fix must enter RC2 and reset its affected evidence.
- [ ] Immediately after publishing RC2, prepare the metadata-only stable promotion PR with `package.json`, changelog, and release notes already set to `0.1.0`; run the complete same-SHA matrix, merge it, and record the resulting `master` SHA as the stable candidate.
- [ ] Freeze and soak that exact stable-candidate `master` SHA for seven clean days; any later commit creates a new candidate and restarts the seven-day stable-candidate clock.
- [ ] Verify the program has completed both weekly RC gates and at least 14 cumulative RC soak days.
- [ ] Run release readiness and `npm pack --dry-run` against the exact stable-candidate SHA.
- [ ] Merge with zero unresolved threads and all required checks green.
- [ ] Tag the already-soaked stable-candidate SHA as `v0.1.0` without another version or documentation commit; create the GitHub Release and verify OIDC/provenance publication.
- [ ] Verify npm `latest`, executable invocation, fresh install, upgrade from beta.5, and rollback.
- [ ] Close and re-read every S0 issue and the stable-release epic.
- [ ] Remove merged worktrees/branches and verify no active work was reaped.
