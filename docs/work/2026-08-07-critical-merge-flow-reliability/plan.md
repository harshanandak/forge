# Critical merge-flow reliability program

- Date: 2026-08-07
- Status: proposed strategic plan
- Authority: Forge epic `f30e5d29-9099-4029-baec-af39f08b6ee3`
- Branch: `feat/merge-flow-control-plane`

## Purpose

Restore a fast, trustworthy release train by fixing Forge's control-plane truth before adding more orchestration. The program separates deterministic safety, zero-token observation, model-guided work, and persona-specific policy so models retain freedom while repeated mistakes and waiting are removed.

This integrates existing Shepherd, merge-authority, exact-SHA, and evaluation work. It does not redesign those systems.

## Verified baseline

- Recent 50 merged PRs: 2.84 h median and 30.82 h P90 from creation to merge.
- Previous 50: 1.49 h median and 17.64 h P90.
- A separate cohort audit found final-head CI nearly unchanged; delay accumulated mainly before final CI.
- 423 of 487 active issues lack acceptance criteria; 336 of 366 ready issues lack them.
- Claim projections disagree: 107 in stats, 52 visible, and only 5 unexpired claims attached to active work.
- PR #471 changed 178 lines but accumulated 44 comment/review interactions and 7 commits over 49 hours.
- Historical model lanes were not matched and lacked model-to-issue-to-PR-to-head attribution. No Sol/Luna winner is established.

## Root causes in scope

1. Readiness represents dependency and claim state, not an executable work contract.
2. Issue, claim, stage, PR, and Shepherd projections can disagree or disappear across sessions.
3. Validation can finish without a reconstructable terminal PASS, FAIL, or INCOMPLETE receipt.
4. Monitoring can observe state without reliably delivering actionable transitions to the owning task.
5. Merge checks have produced false blockers from neutral checks, stale `behind` evidence, and duplicate settle policy.
6. Parallel work lacks an authoritative next-at-bat merge slot and immutable action attribution.
7. Skills and runtime contracts drift: documented types/statuses and prerequisites do not always match Kernel behavior.
8. One workflow profile does not fit beginners, experts, asynchronous teams, forks, CI-only environments, Windows/offline users, or protected enterprises.

## Policy structure: constrain transitions, not thought

Forge policy has four layers:

1. **Hard invariants** constrain dangerous external transitions: exact head, live authority, current required checks, actionable-thread resolution, privacy, and non-destructive cleanup.
2. **Executable contracts** bound the requested outcome: purpose, observable acceptance, scope boundary, owner, dependencies, and terminal result.
3. **Configurable risk policy** selects planning depth, reviewer groups, test profile, feedback window, evidence retention, and human approvals.
4. **Model freedom** remains inside those boundaries: decomposition, tools, implementation, recovery, exploration, and safe parallelism are not prescribed.

Every rule must declare:

- the concrete failure it prevents;
- the single enforcement point;
- the evidence that proves pass or fail;
- whether it is invariant, configurable policy, or guidance;
- who may override it and how that override is audited;
- the review/expiry trigger that removes obsolete policy.

A statement without deterministic enforcement is guidance, never presented as a gate. A duplicate rule is deleted in favor of the rule closest to the protected transition. Defaults should make the safe path easier, while overrides remain explicit and never weaken the universal safety floor.

## Universal safety floor

- exact repository, issue, PR, base, and head SHA;
- live mutation authority and unexpired ownership where required;
- current required checks are terminal green;
- zero unresolved actionable review threads;
- no conflict, stale-head merge, unsafe cleanup, secret exposure, or hook bypass;
- missing or non-reconstructable evidence is INCOMPLETE, never PASS.

Everything else is configurable by risk and repository policy.

## Target flow

1. **Contract gate** — purpose, observable acceptance, risk, dependencies, and out-of-scope boundaries are required before ready.
2. **Atomic start** — actor/session identity, claim, repository proof, and isolated worktree are verified together.
3. **Bounded parallel work** — only non-overlapping owners run in parallel; each action records issue, PR, head, role/model, timing, retries, and result.
4. **One correction head** — actionable feedback is batched into one quiet window and one integrated correction SHA.
5. **Zero-token observation** — the repo-singleton Shepherd streams cursor-based actionable or terminal transitions to the owning task and reaps itself on completion, cancellation, expiry, or TTL.
6. **Sequential merge slot** — only next-at-bat refreshes base and final evidence; guarded merge re-fetches authority and exact-head state immediately before mutation.
7. **Terminal receipt** — validation, merge, cleanup, and post-merge verification persist reconstructable evidence.

## Delivery waves

### P0 — make state truthful

- Reconcile issue, claim, stage, PR, and Shepherd projections.
- Correct skill/runtime taxonomy and readiness contract drift.
- Require terminal validation receipts; zero-test and wrapper-timeout results are INCOMPLETE.
- Eliminate remaining false check, review, `behind`, and settle blockers.

Exit: authoritative projections reconcile at 100% in the test corpus; no critical false-ready, stale-head, unauthorized, or zero-test PASS case.

### P1 — remove model waiting

- Finish cross-harness fast wake adapters without moving the monitor into model or hook processes.
- Stream event deltas to an explicit owner task with cursor replay, bounded scope, TTL, and terminal predicates.
- Transfer and reap watcher ownership across daemon lease recovery.

Exit: zero model polling turns in monitored cases; no orphan watcher/subscription; P95 terminal-event delivery under 60 seconds in the controlled corpus.

### P2 — reduce correction and queue churn

- Make contract completeness part of ready policy.
- Classify review evidence as actionable, status, empty, outdated, or optional.
- Batch feedback and run full CI once on the intended final head.
- Introduce one ordered merge slot with explicit dependency and collision evidence.

Exit: median correction batches at most 1, P90 at most 2, false blockers below 5%, and duplicate full-CI runs per unchanged head below 5%.

### P3 — adapt without forking the control plane

- Add concise/resumable beginner and low-attention presentation.
- Add expert JSON/manual composition and enterprise strict policy.
- Add trusted maintainer adoption for fork PRs and headless authentication boundaries.
- Make local plan/dev usable offline while keeping ship/review/merge freshness strict.
- Run the blinded Sol/Luna evaluation only after immutable attribution is available.

Exit: the same safety corpus passes across supported harness/persona adapters with no severity-weighted escape regression.

## Measurement contract

Track median and P90 for created-to-merge, first-review-to-last-correction, and final-head-to-merge. Also track correction batches, actionable threads per 100 changed lines, duplicate CI runs per head, manual polls, model waiting turns/tokens, contract completeness, ownership reconciliation, rebases per merge, false/missed blockers, orphan processes/subscriptions, human interventions, and severity-weighted escapes.

Raw comments, issue count, merge rate, and cumulative token counters are diagnostic only; none is a standalone success metric.

## Existing decisions reused

- `docs/work/2026-07-12-shepherd-merge-safety/design.md`
- `docs/work/2026-07-29-auto-shepherd/`
- `docs/work/2026-08-01-merge-authority-head-lease/`
- `docs/work/2026-06-24-pr-shepherd-review/plan.md`
- `docs/work/2026-03-26-parallel-prs/`
- `docs/work/2026-08-05-model-neutral-eval-evidence/`

## Authoritative issue map

- Umbrella: `f30e5d29-9099-4029-baec-af39f08b6ee3`
- Contract-valid readiness: `4ee7f9a9-4fa0-42c1-bd96-96638cc9feff`
- Cross-harness Shepherd wake: `4a32d61b-8e86-481b-b8c1-f77d464e445e`
- Terminal validation aggregate: `204fbfee-82d0-4504-bc45-f70a831108a4`
- Host background transport: `60ccc100-506b-46a6-bf96-b2fce3436ed6`
- Shepherd cursor wait/events: `a696e954-af9f-4dc0-b659-23804b7eeb55`
- Shepherd lifecycle status: `d2c3cce3-7cfb-45bf-b946-7cf9a61df513`
- Ordered merge queue: `e57a19d4-d6a6-49f0-b34d-0bf6777643f8`
- Lease/presence visibility: `c29f3952-1229-4f13-afd7-416a426c916a`
- Canonical merge-train orchestration: `451c8828-6201-4c8e-b61d-49b9037797f3`

These existing issues block umbrella completion through Kernel dependency links. Their original parents remain unchanged.

## Out of scope

- Declaring a winning model from historical evidence.
- Replacing GitHub protected-branch or merge-queue authority.
- A second monitor, issue store, workflow engine, or mandatory model polling loop.
- Closing the entire historical backlog in this release line.
- Mixing unrelated product or test failures into an active implementation PR.

## Edge and failure policy

- Missing clock, lease, required-check, thread, head, or receipt evidence fails closed as INCOMPLETE or ESCALATE.
- External fork contributors never receive repository write credentials or secrets.
- Dirty worktrees are retained; cleanup requires positive merge and ownership evidence.
- Offline work may plan and develop locally but cannot claim ship or merge freshness.
- Owner-task delivery failure preserves cursor/journal state and expires safely rather than polling with a model.

## Ambiguity policy

Implementation may choose any approach that preserves the safety floor and wave acceptance. Scope, authority, privacy, destructive behavior, or public contract uncertainty requires a recorded decision before mutation. Unrelated findings become separate deduplicated issues and never expand the active PR.
