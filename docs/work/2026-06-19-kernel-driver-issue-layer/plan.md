# Design — Kernel Driver Issue Layer (K-DRV)

**Slug:** kernel-driver-issue-layer · **Date:** 2026-06-19 · **Status:** planned (D34 external-planner artifact)
**Branch:** feat/kernel-driver-issue-layer · **Worktree:** .worktrees/kernel-driver-issue-layer
**Beads ceremony:** deferred — bd/Dolt unreachable (K0). Epic/issue filing happens after K0; this artifact satisfies the `/dev` entry contract per D34 (structured tasks + acceptance criteria).

## Purpose

The Forge Kernel cannot serve a single issue today. A smoke spike ran all 13 issue ops via `issueBackend=kernel` and every one threw `Kernel local broker driver must provide issueOperation()`. Root cause: `lib/kernel/sqlite-driver.js` implements only `exec`/`queryAll` + migration/backup/FTS5 self-tests; the high-level + guarded-event methods the broker requires are missing. The broker's domain logic (#220) was proven against **inline fake drivers** in tests — never the real SQLite driver. This feature implements the real driver method surface so the kernel becomes a working issue backend, unblocking dogfooding, the Beads→kernel migration (K8), and the default-flip (K11).

## Success criteria (measurable)

1. **Acceptance = the smoke spike:** `create, list, ready, show, update, comment, claim, release, dep.add, dep.remove, search, stats, close` all succeed via `runIssueOperation(op, args, root, { issueBackend: 'kernel', kernelDatabasePath })` against a fresh DB — `success !== false`, contract-shaped output (`{ ok, schema_version, command, data, next_commands }`).
2. All `requireDriverMethod` / `requireGuardedDriverMethods` assertions in `broker.js` are satisfied by the real driver (no throws).
3. Existing kernel tests stay green (broker, broker-concurrency, broker-multiprocess, lease-enforcer, evaluators, projection-jsonl-writer, taxonomy-validator, readiness-model).
4. Idempotency, DB-enforced claim leases, stale-revision quarantine, and dependency handling behave per #220 against the **real** driver (not just fakes).

## Out of scope

- Beads removal / hot-path burn-down (K9). Kernel runs **alongside** Beads.
- Beads→kernel issue migration of the 389 legacy issues (K8).
- Persistent `issueBackend: kernel` config / default-flip (K11) — selection stays per-call (`deps.issueBackend`).
- Agent skills, hooks, MCP.

## Approach selected

Implement the 16 missing methods on the existing `lib/kernel/sqlite-driver.js` (extend its returned driver object, reusing `exec`/`queryAll`) as parameterized SQL over the existing `kernel_*` schema.

**Key decision — how mutations honor the guarded-event machinery.** The `KernelIssueAdapter` routes all 14 ops to `broker.runIssueOperation` → `driver.issueOperation`. But mutations must keep #220's event-sourcing guarantees (CAS, idempotency, leases, quarantine), which live in `broker.runGuardedEvent` (`evaluateKernelEvent` + `commitGuardedAccept`). A driver method cannot call back into the broker. Resolution:

- **Reads** (`ready/list/show/search/stats`) → `driver.issueOperation` does direct parameterized `SELECT`s (no events).
- **Mutations** (`create/update/close/comment/dep.add/dep.remove/claim/release`) → routed through the **guarded path**: `broker.runIssueOperation` detects mutation ops and builds the kernel event, calling `runGuardedEvent`, which uses the driver's low-level primitives (`insertKernelEvent`, `loadKernelEntity`, `insertKernelClaim`, …). The driver implements the **primitives**; the broker keeps orchestration. This requires a small, surgical change to `broker.runIssueOperation` routing (Task 10) and maximizes reuse of the proven guarded path.
- *Rejected alternative:* `driver.issueOperation` does all writes directly — simpler but bypasses event-sourcing/idempotency/quarantine, throwing away #220's value.

## Constraints

- Honor `issue-command-contract.js` output schemas + error shape (`{code, message, exit_code, retryable}`) and `next_commands` hints.
- Honor taxonomy (4 types `epic/task/bug/decision`; 5 stored statuses; `ready`/`blocked` derived via `readiness-model.js`, not stored).
- Parameterized SQL only (no string interpolation of values) — SQL-injection safe.
- WAL + transactions; idempotency keys; DB-enforced single active claim per issue.
- Zero new Beads/Dolt coupling; works on `node:sqlite` (≥22.13) and `bun:sqlite`.

## Edge cases (Q&A decisions)

- **Empty DB:** `ready`/`list`/`stats` return empty/zero shapes, not errors. Schema auto-applied via broker `initialize()` before first op.
- **Stale revision** on update/close → `evaluateKernelEvent` quarantines (`insertKernelConflict`); op returns retryable error.
- **Duplicate idempotency key** → replay as duplicate (no double-write).
- **Claim on already-claimed issue** → conflict (`invalid_claim_scope`/active-claim), not silent overwrite.
- **dep.add creating a cycle** → quarantine (`dependency_cycle`).
- **close with open dependents** → allowed but surfaced (dependents recomputed as ready/blocked by the read model).

## Ambiguity policy

7-dimension rubric per `/dev` decision gate. ≥80% confidence: proceed + document. <80%: stop and ask. The reads-vs-guarded routing (Task 10) is the most likely gate — if the broker change proves larger than surgical, stop and confirm.

## Technical research

**Driver contract the broker requires (17 methods; `exec` exists, 16 to build):**
`issueOperation` · `insertKernelEvent` · `loadKernelEntity` · `listKernelEvents` · `loadKernelEventByIdempotencyKey` · `listKernelDependencies` · `loadActiveKernelClaim` · `insertKernelClaim` · `updateKernelClaimState` · `insertKernelConflict` · `enqueueKernelProjection` · `listProjectionOutbox` · `loadProjectionModel` · `markProjectionDelivered` · `recordProjectionFailure` · `deadLetterProjection`.

**Schema (already defined, `lib/kernel/schema.js`):** `kernel_issues` (id/title/body/type/status/priority_rank/created_at/updated_at/entity_revision/parent_id/sprint_id/release_id/stage_state/labels/acceptance_criteria/estimate), `kernel_dependencies`, `kernel_comments`, `kernel_priority_events`, `kernel_claims`, plus events/conflicts/projection-outbox/dead-letters tables. Build SQL against these — do not alter the schema.

**Reference spec:** the inline fake drivers in `test/kernel/broker.test.js` (e.g. `async issueOperation(operation, args, context, brokerConfig)`) define exact method signatures `(…, context, config)`. Mirror them.

**OWASP:** A03 Injection — parameterized SQL only (primary risk). A01/A08 — local-file DB, filesystem doctor (separate); low remote surface.

**TDD scenarios (min):** (1) read on empty DB returns empty shapes; (2) create→show round-trips contract-shaped data + revision; (3) double-claim → conflict (lease enforced) on the real driver; (4) idempotent create replay = single row; (5) dep.add then `ready` reflects the blocked dependent.

## Artifacts

**This design phase:** `docs/work/2026-06-19-kernel-driver-issue-layer/plan.md`, `tasks.md`.

**Produced during `/dev` (now complete):**
- Implementation: `lib/kernel/sqlite-driver.js` (16 driver methods), `lib/kernel/broker.js` (mutation routing + revision-conflict recovery), `lib/kernel/evaluators.js` (`buildConflict` export).
- Tests: `test/kernel/sqlite-driver-issue.test.js`, `sqlite-driver-events.test.js`, `sqlite-driver-mutations.test.js`, `sqlite-driver-deps-claims.test.js`, `driver-smoke.test.js` (13-op acceptance).

## Next

**Stage gate outcome:** the Task 10 ambiguity gate (broker mutation routing) resolved as **surgical** — `runGuardedEvent` body extracted to `runGuardedEventImpl` + an additive mutation branch in `runIssueOperation`; `runGuardedEvent`'s behavior/return shape unchanged, all existing broker tests green (commit `962b54c`). No escalation was needed.

**Status:** implemented, validated (`bun run check` green; smoke 13/13; kernel suite green), shipped as PR #224. The kernel runs **alongside** Beads — no default change.

**Follow-ups (post-merge):** K0 (bd/Dolt repair → file these issues into the kernel), K8 (Beads→kernel migration of legacy issues), K11 (default-flip to the kernel backend). Multi-process issue-CAS is now DB-backed (revision compare-and-swap at the row write).
