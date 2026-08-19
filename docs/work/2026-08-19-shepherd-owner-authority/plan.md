# Shepherd watcher authority rebuild

Issue: `2de19e09-2e1b-47f6-a876-dc5a00250836`

Status: architecture revised after Task 1 quality review

## Decision and boundary

PR #537 and the discarded `watch.owner.json` prototype are requirements evidence, not patch bases.

One row in the shared Forge Kernel SQLite database is the sole authority for one repository/PR watcher generation. The repository singleton lease elects the daemon only. Memory owns durable monitor events and terminal receipts. The event journal remains a compatibility projection and never owns watcher lifecycle.

The two-PR delivery preserves the public `forge shepherd`, `daemon`, `watch`, `events`, and `--adopt` envelopes. This foundation PR adds the dormant authority contract only; the dependent cutover PR changes stop handling to cooperative state transitions and removes persisted-PID signalling.

## Why the previous designs failed

The original implementation copied ownership through `shepherd.lock.watchers`, `watch.pid`, generation claims, cleanup markers, `ACTIVE_DIRS`, process state, and terminal receipts. Those stores could not transition atomically.

The first replacement collapsed state into `watch.owner.json` but added a custom pathname lock. Token verification followed by rename/delete was not conditional: a successor could replace the path between the check and rename, letting a stale predecessor delete the successor. Parent-directory `lstat` followed by path-based file access also admitted a junction-swap TOCTOU. Repeated local repairs moved the race rather than removing it.

SQLite already supplies the required cross-process serialization, rollback, conditional mutation, Windows support, shared worktree path, WAL mode, and bounded busy handling. The owner row therefore belongs in the existing Kernel database instead of another filesystem protocol.

## Authority location and table

All processes resolve the canonical Kernel database through the Git common directory:

`<git-common-dir>/forge/kernel.sqlite`

Migration creates `kernel_pr_watch_owners`:

| Column | Contract |
| --- | --- |
| `repo`, `pr` | `NOT NULL` table-level composite primary key. Lowercase canonical `owner/repo` and positive PR number. |
| `version` | Integer `1`. Unknown versions fail closed. |
| `generation` | Store-minted opaque identifier, maximum 128 UTF-8 bytes. |
| `phase` | `starting`, `running`, `stop_requested`, `terminal_pending`, `complete`, or `blocked`. |
| `controller_pid` | Positive PID only in `starting`. |
| `watcher_pid` | Positive PID in active watcher, terminal-pending, or permitted blocked-legacy states. |
| `started_at`, `updated_at` | Canonical ISO timestamps; update never precedes start. |
| `heartbeat_at` | Required for `running` and `stop_requested`. |
| `terminal_receipt_id` | Immutable Memory receipt id, maximum 256 UTF-8 bytes, required in terminal states. |
| `block_reason` | Bounded migration reason required only in `blocked`. |
| `legacy_evidence_hash` | SHA-256 provenance required for imported or blocked legacy evidence. |

The row is the only per-PR watcher-generation authority. No watcher arrays, PID files, claim markers, cleanup markers, `ACTIVE_DIRS`, JSON owner files, lock directories, or SQLite shadow rows may participate in per-PR lifecycle decisions. The release-scoped migration gate answers only whether cutover completed and contains no PR identity, generation, PID, phase, or receipt.

The Kernel schema DSL and DDL renderer are extended with a table-level `primaryKey: ['repo', 'pr']` contract. Both fresh-schema creation and additive migration render the same composite `PRIMARY KEY (repo, pr)` declaration; a unique secondary index is not an acceptable substitute. Schema validation rejects an empty key, unknown columns, duplicate columns, nullable key columns, or a table that mixes field-level and table-level primary keys.

## Phase invariants

| Phase | Required identity | Permitted successor |
| --- | --- | --- |
| `starting` | controller PID; watcher PID null; no receipt; legacy hash only for gate-bound imports | `running`, delete through exact `abortStarting` |
| `running` | watcher PID and heartbeat; controller null; no receipt | heartbeat, `stop_requested`, `terminal_pending` |
| `stop_requested` | watcher PID and heartbeat | heartbeat, `terminal_pending`, exact nonterminal release |
| `terminal_pending` | last watcher PID and verified receipt | `complete` after exact PID is dead |
| `complete` | both PIDs null and verified receipt | `starting` only with fresh provider proof of reopen |
| `blocked` | bounded reason and legacy hash; positive PID for live reasons | delete or `complete` only through evidence-bound recheck |

There is no generic transition or clear. The module exposes only `reserveStarting`, `reserveReopened`, `bindRunning`, `heartbeat`, `requestStop`, `recordTerminal`, `completeTerminal`, `abortStarting`, `releaseNonterminal`, `recoverDeadStarting`, `recoverDeadWatcher`, `markLegacyBlocked`, `recheckLegacyBlocked`, `importLegacyComplete`, and gate-bound `importLegacyStarting`. Imported legacy provenance is preserved through later lifecycle transitions.

The separate migration-gate surface exposes only `readMigrationGate`, `publishMigrationQuarantine`, `bindMigrationSnapshot`, `publishMigrationConflict`, and `completeMigrationGate`. Reading never creates or mutates the gate; launch is permitted only after a valid read returns exactly `complete`.

Every API returns `{ ok, changed, reason, record }`. Invalid input, missing Kernel authority, busy timeout, corrupt rows, unknown versions, and ambiguous migration evidence return tagged fail-closed envelopes and never fall back to filesystem authority.

## Transaction contract

The SQLite driver exposes a narrow, domain-specific owner-row transaction. It does not expose a raw database handle or a generic transaction callback.

Each transaction:

1. Uses a dedicated file-backed connection to the canonical Kernel database.
2. Applies the existing bounded busy timeout, then `BEGIN IMMEDIATE`.
3. Reads the exact primary-key row.
4. Applies one synchronous decision: no-op, parameterized insert/update, or exact delete.
5. Commits on success and rolls back on any failure.
6. Restores timeout and closes/poisons the owned connection on rollback or restoration failure.

Normal owner operations read and mutate one exact owner row. The migration import operation may additionally read the singleton gate as an immutable `(state, snapshot_hash)` precondition, but still mutates at most one owner row. Gate transition operations mutate only the singleton gate. No API mutates the gate and an owner row together or exposes a generic batch callback.

Same-connection re-entry, declared async callbacks, returned thenables, `:memory:` databases, uninitialized or unsafe database paths, and silent database creation are rejected before owner access.

Owner transactions are short. They may validate fields, compare a snapshot, mint a generation, and mutate one row. They must never call GitHub, inspect PID liveness, persist/read Memory, acquire the event journal lock, run a monitor pass, sleep, retry externally, or call another Kernel operation.

## Two-phase evidence protocol

Operations that require provider, PID, or receipt evidence use:

1. Short read transaction: capture the complete owner snapshot.
2. Outside SQLite: gather provider state, PID liveness, or immutable receipt verification.
3. Short write transaction: re-read and compare repo, PR, generation, phase, relevant PID, receipt/evidence hash, and snapshot timestamps before mutation.

Any mismatch returns `stale_evidence` without mutation. `recheckLegacyBlocked` always uses this two-transaction form. `authority_unavailable` never performs an unlocked fallback read.

## Runtime protocol

### Start

Direct, adopted, and daemon starts use the same `reserveStarting` row transaction. Exactly one contender inserts or recovers a generation. The hidden child binds its watcher PID only against the exact starting generation/controller tuple.

A live controller or watcher is never replaced. Stale-but-live remains blocked until the PID dies. True live-generation fencing remains follow-up issue `4516c0b9-0d3e-45a3-b232-61a8078bbeba`.

### Monitor pass

The watcher reads and validates its row in a short transaction, releases SQLite, runs the bounded monitor/event/Memory work, then checkpoints heartbeat or terminal state through a second exact-generation transaction. No Kernel writer lock spans the monitor pass.

### Stop and terminal

The daemon writes `stop_requested`; it never signals a persisted PID. The watcher observes the phase between passes.

Terminal flow is receipt first, owner row second: persist the immutable Memory receipt outside the owner transaction, then conditionally move the unchanged row to `terminal_pending`. Completion requires a later exact row transaction after the recorded watcher PID is confirmed dead. A crash leaves a retryable row or replayable receipt, never invented completion.

### Reopen

`reserveReopened` is the only `complete -> starting` operation. Fresh provider evidence is gathered outside SQLite, then the transaction compares the exact completed generation and receipt before minting the new generation.

## Legacy migration

One release keeps a read-only importer for `shepherd.lock.watchers`, numeric/object watcher entries, `watch.pid`, `watch.startedat`, generation/cleanup markers, direct watchers, and pre-v1 terminal receipts.

The same migration adds `kernel_pr_watch_migration_gate`, a repository-local singleton safety gate with `singleton = 1`, `state = quarantined | conflict | complete`, `snapshot_hash`, bounded `conflict_code`, and `updated_at`. It never stores a watcher generation, PID, phase, or receipt and is not watcher authority. Starts and daemon retirement fail closed until the gate is `complete`; after completion, only `kernel_pr_watch_owners` decides watcher lifecycle.

Cutover is ordered and crash-recoverable:

1. Acquire the legacy repository singleton lease, publish the SQLite gate as `quarantined`, and route every new direct, daemon, and adopt launch through the gate before disabling legacy writers in the new binary.
2. Read every legacy source, canonicalize any available repository/PR identity, and hash the exact bounded snapshot. Provider, PID, and receipt verification happens outside SQLite.
3. Reread the legacy sources and require the same hash before mutation. A changed snapshot restarts discovery without publishing owner state, for at most three attempts; the third mismatch persists `conflict/legacy_snapshot_changed` and fails closed. Once stable, a short transaction CAS-binds that exact hash into the still-`quarantined` gate before any owner insert. An already-bound different hash is a conflict and is never replaced.
4. Process canonical identities in deterministic `repo, pr` order. For each identity, run one short idempotent owner transaction that reads the singleton gate as a precondition, requires `quarantined` plus the exact bound hash, and conditionally inserts or confirms only that PR row: verified live PID becomes `blocked/legacy_live_pid`; verified dead terminal evidence becomes `complete`; verified dead open evidence becomes recoverable `starting`. No transaction spans multiple owner rows. Existing nonmatching owner state is a conflict, never overwritten.
5. Reread every inserted row, the bound gate hash, and the legacy snapshot. Only an exact three-way match may CAS the gate from `(quarantined, snapshot_hash)` to `(complete, the same snapshot_hash)`; compatibility cleanup begins only after that durable reread.
6. Cleanup is idempotent and never removes evidence for a live PID, a conflicting row, or a failed reread. A crash before hash binding repeats discovery; a crash after binding resumes only from the same hash; a crash after row insertion revalidates those rows against the bound hash; a crash after gate completion resumes cleanup without changing authority.

Evidence with a canonical `(repo, pr)` but unreadable, conflicting, lossy, or unverified lifecycle data becomes the corresponding `blocked` owner row. Evidence whose repository or PR identity itself cannot be canonicalized does **not** fabricate `pr = 0` or another owner row: the gate becomes `conflict/legacy_identity_unmappable`, the exact source is retained, and all starts and retirement remain blocked until an operator or later importer can map it. Arbitrary invocation of an older Forge binary after cutover is outside the local-runtime guarantee; every process and artifact present during cutover is fenced by this protocol.

New code writes only SQLite owner rows. The compatibility importer is read-only after the gate reaches `complete`, and all legacy writers are deleted during the atomic production cutover.

## Bounds and failure policy

- `repo` is at most 256 UTF-8 bytes; `generation` 128; `terminal_receipt_id` 256; canonical timestamps exactly 24 ASCII bytes; `legacy_evidence_hash` exactly 64 lowercase hexadecimal bytes.
- `block_reason` is exactly one of `legacy_live_pid`, `legacy_conflict`, `legacy_unreadable`, `legacy_lossy`, or `legacy_receipt_unverified`. Only `legacy_live_pid` may retain a positive watcher PID.
- `conflict_code` is exactly one of `legacy_identity_unmappable`, `legacy_snapshot_changed`, or `legacy_owner_conflict`.
- Owner enumeration uses `ORDER BY repo, pr LIMIT 4097`, accepts at most 4096 rows and 4 MiB of canonical encoded row data, and returns a tagged fail-closed envelope if either cap is exceeded.
- All strings are UTF-8 byte-bounded before SQL execution; no truncation or coercion is permitted.
- Busy/unavailable/unsafe Kernel authority fails closed; no database or filesystem fallback is created.
- A killed process during a transaction rolls back. A killed process after commit leaves the committed row authoritative.
- Monitor, Memory, journal, provider, PID, and sleep dependencies are asserted not to run inside the owner transaction.
- SQLite WAL is local-host authority only; no network-filesystem coordination is claimed.

## Required verification

- Real multi-process N-contender start produces exactly one generation.
- Bun-to-Node contention against the same database on Windows and Linux CI.
- Held writer times out with `authority_unavailable`; callback and owner access never run.
- Killed holder rolls back and the next process acquires.
- Transaction success, callback throw, re-entry, async/thenable rejection, timeout restoration, and poisoned-connection closure.
- Every phase invariant and every operation-specific CAS, including stale generation/PID/receipt/evidence.
- Provider/receipt evidence changes between snapshot and write transaction are rejected.
- Missing, uninitialized, unsafe, or `:memory:` Kernel authority performs no owner read/write and creates nothing.
- Bounded enumeration overflow and corrupt-row reads return tagged invalid results.
- Integration proof that monitor, journal, Memory, provider, PID, retry, and sleep work never executes in the owner transaction.
- One-release migration matrix for every legacy source and ambiguity.
- Focused, full, strict ESLint, targetability, migration/schema parity, cross-platform, and `git diff --check` gates.

## Success criteria

1. One Kernel row is the sole per-PR watcher authority.
2. Concurrent starts converge on exactly one generation.
3. Stale generations cannot mutate replacements.
4. Terminal receipt and dead-PID recovery converge to `complete` without false proof.
5. Fork identity remains the upstream repository identity.
6. Corrupt, busy, missing, or ambiguous state fails closed.
7. Every old authority writer/signal is absent after the production cutover.
8. No production transaction spans monitor, Memory, journal, provider, PID, retry, or sleep work.
9. Focused and full validation pass before a replacement PR opens.

## Out of scope

- Merging the replacement PR; the human merge gate remains.
- General distributed locking or network-filesystem support.
- Live stale-watcher takeover without downstream journal/Memory fencing.
- A production harness-stream adapter that consumes Claude `stream-json` (or Codex/Cursor/Hermes equivalents); the existing generic monitor core is preserved but that adapter is separate work.
- Delivery-efficiency, comment-amplification, attribution, and CI-latency follow-ups already tracked separately.
