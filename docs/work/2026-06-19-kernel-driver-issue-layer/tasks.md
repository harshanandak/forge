# Tasks — Kernel Driver Issue Layer (K-DRV)

TDD. Each task: write failing test → confirm red → implement → green → commit. Target driver: `lib/kernel/sqlite-driver.js` (extend the returned driver object; reuse `exec`/`queryAll`). Signatures mirror the broker's fake drivers: `(operation, args, context, config)` for `issueOperation`; `(…, context, config)` for primitives. All SQL parameterized.

**Acceptance for the whole feature:** Task 9 smoke test — all 13 ops green via `runIssueOperation(op, args, root, {issueBackend:'kernel', kernelDatabasePath})`.

## Wave 1 — Foundation (reads, no events)

### Task 1 — Schema applied on a fresh DB
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-issue.test.js`
- Test: `createLocalBroker({driver: realSqliteDriver(), databasePath: tmp}).initialize()` creates `kernel_issues` (assert via `queryAll` on `sqlite_master`). Red first.
- Implement: ensure `initialize()`’s migration statements run through the real driver `exec`; add `queryAll` use if needed.
- Commit: `test:`/`feat: kernel sqlite driver applies schema on init`

### Task 2 — `issueOperation` read branch: list / show / stats
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-issue.test.js`
- Test: seed rows via direct SQL, then `issueOperation('list'|'show'|'stats', args, ctx, config)` returns contract-shaped `{ok, schema_version, command, data, next_commands}` (`data.issues`, `data.issue`, `data.counts`).
- Implement: parameterized SELECTs over `kernel_issues` (+ `kernel_comments` for show); map to contract output via `issue-command-contract` schemas.
- Commit: `feat: kernel driver read ops (list/show/stats)`

### Task 3 — Read ops: ready / search (derived readiness)
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-issue.test.js`
- Test: with deps + claims seeded, `ready` excludes blocked/claimed/closed and ranks by `priority_rank`; `search` matches title/body.
- Implement: compute ready/blocked via `readiness-model.js` over `kernel_issues`+`kernel_dependencies`+`kernel_claims` (derived, never stored). `search` = LIKE/FTS over title/body.
- Commit: `feat: kernel driver ready/search read ops`

## Wave 2 — Guarded-event primitives (event store)

### Task 4 — Event-store primitives
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-events.test.js`
- Test each: `insertKernelEvent`, `loadKernelEntity`, `listKernelEvents`, `loadKernelEventByIdempotencyKey` round-trip against the events/issues tables.
- Implement: parameterized INSERT/SELECT; entity-revision read for CAS.
- Commit: `feat: kernel driver event-store primitives`

### Task 5 — Mutation ops via guarded path: create / update / close / comment
OWNS: `lib/kernel/broker.js` (routing), `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-mutations.test.js`
- Test: `create` then `show` round-trips; `update --status` bumps `entity_revision`; stale revision → quarantine + retryable error; duplicate idempotency key → single row (replay); `comment` appends to `kernel_comments`.
- Implement: broker `runIssueOperation` routes mutation ops → builds event → `runGuardedEvent` (Task 10 covers the routing change if it grows). Driver supplies `commitGuardedAccept`'s writes (issue upsert, comment insert) + `insertKernelConflict`.
- Commit: `feat: kernel driver create/update/close/comment via guarded path`

## Wave 3 — Dependencies & claims

### Task 6 — Dependency primitives + dep.add / dep.remove
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-deps.test.js`
- Test: `dep.add` inserts; `ready` reflects the now-blocked dependent; cycle → quarantine (`dependency_cycle`); `dep.remove` deletes.
- Implement: `listKernelDependencies` + dep INSERT/DELETE over `kernel_dependencies`.
- Commit: `feat: kernel driver dependency ops`

### Task 7 — Claim primitives + claim / release (lease enforced)
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-claims.test.js`
- Test: `claim` creates a lease; second `claim` by another actor → conflict (`invalid_claim_scope`/active-claim); `release` clears it; lease invariant enforced at DB level (unique active claim per issue).
- Implement: `loadActiveKernelClaim`, `insertKernelClaim`, `updateKernelClaimState` over `kernel_claims` with the DB uniqueness invariant.
- Commit: `feat: kernel driver claim/release with DB-enforced lease`

## Wave 4 — Conflicts, projection outbox, integration

### Task 8 — Conflict + projection-outbox primitives
OWNS: `lib/kernel/sqlite-driver.js`, `test/kernel/sqlite-driver-projection.test.js`
- Test: `insertKernelConflict` persists; `enqueueKernelProjection`/`listProjectionOutbox`/`loadProjectionModel`/`markProjectionDelivered`/`recordProjectionFailure`/`deadLetterProjection` round-trip.
- Implement: parameterized SQL over the conflicts + projection-outbox + dead-letter tables.
- Commit: `feat: kernel driver conflict + projection-outbox primitives`

### Task 9 — Integration: formalize the smoke spike (ACCEPTANCE)
OWNS: `test/kernel/driver-smoke.test.js`
- Test: run all 13 ops in sequence via `runIssueOperation(op, args, REPO, {issueBackend:'kernel', kernelDatabasePath: tmp})`; assert each `success !== false` and contract-shaped output. This is the feature's acceptance gate.
- Commit: `test: kernel driver end-to-end smoke (all 13 ops green)`

## Wave 5 — Uncertain (last, deferrable)

### Task 10 — Broker mutation-routing change (only if Wave-2 needs it)
OWNS: `lib/kernel/broker.js`, `test/kernel/broker.test.js`
- If routing mutations through `runGuardedEvent` from `runIssueOperation` is more than surgical, STOP and confirm with the user (ambiguity gate). Test the read-vs-mutation routing explicitly; keep existing broker tests green.
- Commit: `refactor: route kernel mutation ops through guarded-event path`

## Notes
- No Beads removal; selection stays per-call (`deps.issueBackend='kernel'`).
- Run `bun test test/kernel/` after each task; full `bun run check` before ship.
- Beads epic/issue filing deferred to K0 (bd unreachable); record this PR's issues there once bd is repaired.
