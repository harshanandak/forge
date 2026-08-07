# Critical merge-flow reliability tasks

Work is parallel inside a wave only when file ownership and dependency checks prove no collision. Waves merge sequentially. Every implementation issue must carry its own acceptance criteria and exact file ownership before dispatch.

## Task 0 — Lock issue authority and baseline

OWNS: `docs/work/2026-08-07-critical-merge-flow-reliability/`, Forge epic fields and dependency links

- Deduplicate surfaced work against the Kernel and reference existing authoritative issues.
- Set the epic body, P0 priority, acceptance criteria, design path, wave map, and completion metrics.
- Link existing terminal-receipt, transport, event, lifecycle, queue, lease, and orchestration issues as blockers without reparenting them.
- Create only the proven-uncovered contract-ready child `4ee7f9a9-4fa0-42c1-bd96-96638cc9feff`.
- Preserve the measured baseline and cohort methodology.
- Expected output: one authoritative epic and plan; no duplicate implementation issues.

## Task 1 — P0 state truth and terminal receipts

OWNS: readiness/taxonomy, claim/status projection, validation receipt, and merge-evidence modules assigned by the authoritative child issues

TDD:
1. Add failing cases for contract-incomplete ready work, claim projection disagreement, zero-test PASS, missing terminal summary, stale head, neutral/optional checks, and false `behind`.
2. Make the smallest shared-source fixes.
3. Prove PASS, FAIL, and INCOMPLETE are reconstructable from persisted evidence.
4. Run focused suites, lint, supported full validation, and exact-head replay.

Expected output: deterministic state agrees across CLI, JSON, Kernel, Shepherd, and merge authority.

## Task 2 — P1 owner-scoped zero-token monitoring

OWNS: Shepherd lifecycle/event transport and harness capability/adapter files assigned by `4a32d61b-8e86-481b-b8c1-f77d464e445e` and existing Shepherd issues

TDD:
1. Add failing cases for each supported harness wake, duplicate wake, owner delivery, cursor replay, cancellation, TTL, restart, and watcher transfer.
2. Reuse the repo-singleton Shepherd; adapters perform only a fast idempotent wake/subscribe action.
3. Prove models never poll or host the long-running monitor.
4. Prove terminal state, owner completion, lease expiry, and no-open-PR state reap resources.

Expected output: actionable deltas reach the owner task without model waiting or orphan processes.

## Task 3 — P2 contract-ready intake and sequential merge queue

OWNS: issue contract/readiness policy, review evidence classification, merge-order/queue integration, and correction-batch instrumentation assigned by existing queue/readiness issues

TDD:
1. Add failing cases for incomplete contracts, overlapping work, outdated/status-only feedback, unchanged-head CI duplication, queue reorder, and base advancement.
2. Gate ready on the configured contract without prescribing model reasoning.
3. Batch actionable feedback into one correction head.
4. Allow only next-at-bat to refresh base and final merge evidence.

Expected output: parallel implementation remains useful while the merge train is deterministic and low-conflict.

## Task 4 — P3 persona and policy adapters

OWNS: stage prerequisite policy, presentation/adoption adapters, enterprise profile, and related documentation assigned per child issue

TDD:
1. Cover beginner, expert, async team, protected enterprise, fork contributor, multi-agent, Windows/offline, CI-only, low-attention, and security-sensitive packets.
2. Keep the universal safety corpus identical; vary only presentation and configurable policy.
3. Prove local plan/dev can operate without ship-only prerequisites.
4. Prove forks and headless agents never receive inappropriate secrets or authority.

Expected output: one control plane with persona-appropriate interaction, not separate workflow engines.

## Task 5 — Controlled promotion scorecard

OWNS: existing model-neutral evidence and immutable corpus surfaces only

TDD:
1. Join every action to issue, PR, head SHA, model, effort, role, timing, tokens, retries, and gate result.
2. Run identical blinded packets across Sol/Luna and coordination/implementation roles.
3. Treat missing, timed-out, truncated, or non-reconstructable evidence as INCOMPLETE.
4. Apply 30-case smoke, 100-case promotion, and rolling 300-case evidence thresholds.

Expected output: promotion decisions based on quality, correction work, latency, and cost; no winner claim from unmatched history.

## Merge order

1. Task 0 planning PR.
2. Task 1 P0 truth/receipt PRs, smallest independent leaves first.
3. Task 2 monitoring delivery PRs.
4. Task 3 contract/queue PRs.
5. Task 4 persona adapters.
6. Task 5 controlled evaluation and promotion decision.

One PR occupies the merge slot at a time. A newly discovered unrelated failure gets a separate deduplicated issue/PR and does not block the current slot unless it invalidates that slot's acceptance criteria.
