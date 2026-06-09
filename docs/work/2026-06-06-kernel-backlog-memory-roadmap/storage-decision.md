# Storage Decision: SQLite Kernel Authority + Dolt Projection/History

## Decision

Use **SQLite WAL as the Forge Kernel local authority** now.

Do **not** use Dolt as a Kernel authority backend for the first implementation. Keep Dolt as a first-class **projection, migration-fidelity oracle, and branchable backlog/history substrate** outside the Kernel authority path, and route product authority through the Kernel model over SQLite.

## Why

Forge Kernel authority needs fast local mutations, expected-revision checks, idempotency, claim leases, projection outbox/dead letters, and domain conflict quarantine. SQLite gives the simplest embedded substrate for that broker.

Dolt is valuable, but its strongest primitives are version-control primitives: branch, merge, history, diff, remotes, and conflict tables. Those are useful around the Kernel; they should not replace the Kernel's domain authority rules.

## Evidence from the spike

Spike script:

```text
docs/work/2026-06-06-kernel-backlog-memory-roadmap/storage-decision-spike.mjs
```

Local environment:

```text
Bun 1.3.6
Dolt 1.84.0
sqlite3 CLI unavailable, but bun:sqlite works
```

Measured Forge-like operations:

| Dimension | SQLite WAL | Dolt embedded CLI |
| --- | ---: | ---: |
| 200 issue+event+outbox operations | 118.8 ms | 2081.6 ms |
| Commit/version snapshot | implicit transaction/WAL | 2341.6 ms explicit Dolt commit |
| Duplicate idempotency key rejected | yes | yes |
| 4 worker x 50 event concurrent write test | 1992.9 ms, 0 errors | not suitable via same embedded working set without a coordinating server/branch model |
| Data history query | must be modeled by Kernel/events | built in via `dolt_history_*` |
| Branch conflict detection | must be modeled by Kernel | built in; claim conflict produced `dolt_conflicts_kernel_claims` |
| Dolt server lifecycle | not applicable | server starts locally and accepts SQL via `dolt --host ... --no-tls`, but it adds service lifecycle/TLS/client coordination to the core path |

Dolt conflict test result:

```text
base_actor,our_actor,their_actor
none,agent-a,agent-b
```

This confirms Dolt is excellent at low-level data conflict surfacing. But Forge still has to decide the domain result: whether `agent-a`, `agent-b`, reclaim, lease expiry, or quarantine is correct.

## Interpretation

### SQLite wins for first Kernel authority

SQLite is the better default for:

- local single-machine authority
- fast brokered mutations
- straightforward Bun/Node integration
- expected-revision and idempotency checks
- claim/session/worktree tables
- projection outbox and dead letters
- testability in the existing repo
- avoiding Dolt server/client lifecycle as the core hot path

### Dolt wins for adjunct capabilities

Dolt should remain first-class for:

- Beads import/export/projection fidelity
- branchable backlog experiments
- roadmap alternatives and evaluator branches
- issue/history provenance
- table-level diff/blame/log queries
- trusted offline sync experiments
- detecting data/schema conflicts during branch merges

## Architecture consequence

The storage split should be:

```text
Forge Kernel local authority: SQLite WAL
Beads compatibility / versioned backlog projection: Dolt
Project Knowledge provenance: index Kernel events + Dolt history/diffs + artifacts
Strict team authority: serialized server authority, not raw SQLite or raw Dolt merges
```

## Guardrail

For implementation clarity, **do not keep re-litigating Dolt while building the Kernel**. The implementation path is SQLite-first and SQLite-owned:

> SQLite owns the Kernel authority path. Dolt is outside the core implementation equation.

Dolt only remains relevant at explicit boundaries:

- current Beads compatibility
- optional projection/export target
- historical provenance source
- branch/merge experiments that do not block Kernel work

It must not shape the first Kernel data model, transaction contract, write API, or local authority broker.

## Follow-up work

1. Continue implementing the SQLite Kernel broker.
2. Keep Beads/Dolt interaction behind compatibility/projection adapters only.
3. Add a Dolt history indexer later only if Project Knowledge needs it.
4. Keep Dolt branch/merge as a separate backlog-planning experiment, not the default authority path.
5. Keep Dolt authority strategy closed unless there is a later accepted Project Design or ADR that explicitly reopens backend strategy.
