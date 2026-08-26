# Tasks

## 0. Re-lock architecture and baseline

OWNS: this work folder and Forge issue context

- Record that the pathname-lock prototype failed quality review on conditional-release and symlink TOCTOU.
- Replace the file-owner plan with the user-approved Kernel SQLite owner-row design.
- HARD GATE: independent implementation-readiness review returns zero blockers.
- Preserve baseline evidence: exact base SHA, focused shepherd baseline 204/204, and the separately tracked raw full-suite timeout.

## 1. Dormant transactional owner primitive

OWNS: `lib/kernel/migrations.js`, `lib/kernel/schema.js`, `lib/kernel/sqlite-driver.js`, `lib/pr-monitor/watch-owner.js`, matching tests under `test/kernel/**` and `test/pr-monitor/watch-owner.test.js`, `scripts/test.js`, `lib/commands/test.js`

- RED A — schema/store: extend the schema DSL/renderer with a validated table-level `PRIMARY KEY (repo, pr)`; add the repository-local singleton migration-gate schema; prove fresh-schema/additive-migration parity; exact 256/128/256-byte field bounds; exact phase/reason enums; corrupt/unknown row; `ORDER BY repo, pr LIMIT 4097` enumeration capped at 4096 rows/4 MiB; missing/uninitialized/unsafe/`:memory:` database creates nothing and fails closed.
- RED B — transaction primitive: real N-process contention; Bun-to-Node contention; held-writer timeout; killed-holder rollback; callback throw; same-connection re-entry; declared async/returned thenable rejection; timeout restoration; poisoned connection closure.
- RED C — state machine: common tagged envelopes; every phase invariant; all 15 operation-specific owner APIs including gate-bound `importLegacyStarting`; six narrow migration-gate APIs including non-mutating `readMigrationGate`, publish quarantine, bind an exact snapshot once, publish tagged conflict, retry conflict under exact evidence, and complete by exact `(state, hash)` CAS; one ordered idempotent import transaction per PR that reads the bound gate precondition and never batches owner rows; imported legacy provenance preservation; store-minted generations; stale generation/phase/PID/receipt/evidence rejection; positive migration PIDs; malformed evidence rejection; no generic clear/transition.
- RED D — evidence boundaries: provider/PID/receipt work occurs outside SQLite; changed snapshot is rejected by the second transaction; no unlocked fallback read; monitor/journal/Memory/provider/PID/retry/sleep functions are forbidden inside the transaction.
- GREEN: implement one `kernel_pr_watch_owners` row, the non-owner singleton migration gate, and narrow parameterized owner/gate transaction APIs. Replace the committed filesystem prototype; do not retain JSON owner/lock code. No production caller cutover in this task.
- REFACTOR: keep domain transitions in `watch-owner.js`, SQL/transaction mechanics in the driver, and add exact focused-test mappings.

## 2. Atomic production cutover and migration

OWNS: `lib/pr-monitor/journal.js`, `lib/pr-monitor/watch.js`, `lib/pr-monitor/watch-lifecycle.js`, `lib/pr-monitor/reconcile.js`, `lib/pr-monitor/reconcile-executor.js`, `lib/pr-monitor/shepherd-lease.js`, `lib/pr-monitor/monitor.js`, `lib/commands/shepherd.js`, and matching tests

- RED A — start/identity: direct/daemon/adopt contention, parent/child bind, exact upstream fork identity, same PR number across repositories, dead-controller/dead-watcher recovery, reopen.
- RED B — pass/stop/terminal: transaction is never held across monitor/journal/Memory/provider/PID/sleep; cooperative stop; receipt-unavailable retry; receipt replay; terminal recovery; daemon lease loss; no persisted-PID signal.
- RED C — migration/retirement: repository singleton migration gate (`quarantined | conflict | complete`); launch fencing before writer removal; stable double-snapshot hash bound before publication; every legacy row/source; deterministic one-transaction-per-PR import; canonical numeric entries; identity-unmappable evidence retained as `conflict/legacy_identity_unmappable` without a fabricated owner row; live legacy PID block; dead evidence import; owner-row durable reread before exact gate/hash completion; crashes before binding, between per-PR inserts, after inserts, after gate completion, and during cleanup; changed snapshot and corrupt enumeration preventing start/retirement.
- GREEN in one uncommitted cutover: route all production starts/stops/evidence through owner rows; remove external kill, `ACTIVE_DIRS`, PID writer, generation/cleanup-marker writers, lease watcher authority, JSON owner files, and custom owner locks; keep only the read-only one-release importer.
- REFACTOR: delete lifecycle/checkpoint code whose only purpose was synchronizing duplicated authority. Do not commit or push a mixed-authority intermediate state.

## 3. Documentation, deletion audit, and validation

OWNS: `docs/reference/shepherd.md`, validation evidence, commit/PR metadata, and `CODING_STANDARDS.md` only if review finds a reusable missed rule

- Update reference docs to Kernel owner rows, cooperative stop, two-phase evidence, fail-closed Kernel unavailability, and one-release migration.
- Prove every legacy writer/signal/JSON owner/custom lock call site is absent and compatibility reads exist only in the importer.
- Run focused tests, schema/migration parity, real multiprocess tests, Linux CI coverage, full tests, strict ESLint, targetability, `git diff --check`, and independent final review.
- Install/authenticate the official CodeRabbit CLI if absent, run `coderabbit review --agent --base-commit <exact-origin-master-sha>` locally against the complete branch diff, and fix every actionable in-scope finding before opening the replacement PR; `UNAVAILABLE` is not a pass.
- Verify every commit is Harsha-only with no Shepherd/Anthropic/coauthor trailers.
- Push, open a clean replacement PR, resolve all actionable threads, and stop at the human merge gate.
