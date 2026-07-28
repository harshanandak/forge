# Forge 0.1.0 Stable Release Tasks

Each implementation task gets its own Kernel issue, Forge worktree, RED→GREEN→REFACTOR evidence, review settlement, and close-after-merge verification. Work starts only when its issue is S0 and unblocked. After every merge, record both implementation evidence and the Forge process friction exposed while delivering it; structural friction is immediately linked or filed and ranked so working on Forge continuously improves Forge itself.

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
- [x] Publish the 13-issue S0 list, working order, and collision map as an issue comment on `068374e5`.
- [x] Promote terminal release task `8e634347` to P0 and block it on all 13 S0 issues.
- [x] Record verified ordering edges: `f0385fa1 → c81eb263 → d362bd71`; `588e6973 → d362bd71`; `6bc72f4f → d362bd71`; `8606ea93 → cb8c7ab6`.
- [ ] Lock measurable thresholds for automatic-context precision, recall, miss rate, latency, and token cost before enabling it.

## Phase 2 — four parallel S0 lanes

### Lane A: automatic skill and diagnostic selection

- [ ] Fit canonical trigger descriptions inside the model-visible limit (`588e6973`).
- [ ] Restore the packaged agent-agnostic dispatch pointer (`6bc72f4f`).
- [ ] Make skills usable without enforcement hooks (`c81eb263`).
- [ ] Add behavioral trigger, confusing-neighbor, variance, and holdout evaluation (`d362bd71`).
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

### Lane D: test and release evidence

- [ ] Remove affected-test HEAD fallback false-greens (`10a6f241`).
- [ ] Claim and fix the release-workflow coverage issue (`af79e102`).
- [ ] Make publication consume same-SHA full release evidence, including package-skills and environment coverage.
- [ ] Build clean/upgrade/rollback Windows and Linux release journeys.

## Phase 3 — feature-complete beta.5 (2026-08-07)

- [ ] Verify all 13 S0 issues are merged, closed, and re-read from the Kernel.
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
- [ ] Test supported Claude, Codex, and Hermes discovery/invocation paths where the repository advertises support.
- [ ] Run automatic-context holdouts and inspect misses, false positives, stale retrievals, and token use.
- [ ] Run rollback to beta.5 in a disposable project.
- [ ] Publish RC1 on 2026-08-14 only after seven days of beta.5 soak.
- [ ] Allow only reproduced release-stopper fixes after RC1.
- [ ] Publish RC2 on 2026-08-21, repeat the full matrix, and reset affected evidence for every behavioral change.

## Phase 5 — stable promotion (2026-08-28)

- [ ] Fix only reproduced S0 defects from RC1.
- [ ] Verify RC2 has seven clean days and the program has at least 14 cumulative RC soak days.
- [ ] Update version/changelog/release notes together.
- [ ] Run release readiness and `npm pack --dry-run` on the exact release commit.
- [ ] Merge with zero unresolved threads and all required checks green.
- [ ] Create GitHub Release `v0.1.0` and verify OIDC/provenance publication.
- [ ] Verify npm `latest`, executable invocation, fresh install, upgrade from beta.5, and rollback.
- [ ] Close and re-read every S0 issue and the stable-release epic.
- [ ] Remove merged worktrees/branches and verify no active work was reaped.
