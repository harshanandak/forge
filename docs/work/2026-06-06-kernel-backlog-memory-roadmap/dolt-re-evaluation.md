# Dolt Re-evaluation Notes

## Why this re-evaluation exists

The first roadmap correctly warned that SQLite is not a distributed merge substrate, but it treated Beads/Dolt mostly as migration/projection compatibility. That framing is too narrow. Dolt has significant capabilities that could affect Forge's storage roadmap.

## What we verified locally

Current Beads state is Dolt-backed:

```json
{
  "database": "dolt",
  "backend": "dolt",
  "dolt_mode": "embedded",
  "dolt_database": "forge"
}
```

The live Dolt repo at `.beads/dolt/forge` is clean and has an active history. Sample tables include:

- `issues`
- `comments`
- `dependencies`
- `events`
- `labels`
- `ready_issues`
- `blocked_issues`
- `issue_snapshots`
- `compaction_snapshots`
- `federation_peers`
- `interactions`

`bd dolt` exposes:

- server lifecycle: start/stop/status/show/test
- version control: commit/push/pull
- remotes: add/list/remove

Local `dolt log` shows Beads issue creation/dependency changes committed as Dolt history.

## Dolt capabilities that matter

Dolt is not just a projection file format. It provides:

- SQL tables with Git-style commit graph
- branches and merges
- remotes, clone, fetch, push, pull
- SQL stored procedures such as commit/checkout/merge
- queryable history/log/diff/system tables
- data and schema conflict detection
- cell-level data conflicts based on primary keys
- JSON-cell merge behavior for different keys
- blame/revert/backup/dump
- MySQL-compatible server mode

## What Forge may be underusing

### 1. Dolt as provenance/history

Dolt already records issue table history, diffs, commits, and authorship. Forge's knowledge layer should treat Dolt history as a first-class source, not only JSONL exports.

### 2. Dolt as branchable backlog substrate

Dolt could be valuable for:

- speculative backlog branches
- roadmap alternatives
- offline planning branches
- evaluator branches
- comparing planned issue sets before merge

SQLite local mode cannot naturally provide this.

### 3. Dolt conflict tables as low-level conflict input

Dolt conflicts are data/schema-level, not Forge-domain-level. Still, Forge can use them as lower-level evidence for its conflict quarantine system.

### 4. Dolt remotes for trusted distributed sync

Dolt push/pull/remotes may be enough for some trusted/offline workflows, even if not enough for strict team authority with claims, permissions, and live workflow gates.

### 5. Dolt server / Hosted Dolt / DoltLab as possible team backend

A serialized Cloudflare authority may still be best for governed product/team workflows, but Dolt server should be evaluated as an optional authority/hybrid backend before we assume only Durable Objects can serve team mode.

## What Dolt does not solve by itself

Dolt does not remove the need for Forge Kernel semantics:

- expected revisions
- idempotency keys
- domain-level conflict quarantine
- claim leases
- stage/run/evidence state
- workflow gates
- permissions/team roles
- projection outbox and dead letters
- frontend/API contracts

A Dolt merge can be data-valid but still product-invalid. Example: two branches may merge cleanly while producing semantically wrong claim ownership or stale workflow state.

## Revised storage conclusion

Do not pivot to Dolt-first immediately. Do not treat Dolt as mere projection either.

The safer plan is:

| Mode | Candidate |
| --- | --- |
| Simple solo local authority | SQLite WAL Kernel broker |
| Local authority with branchable issue history | Dolt optional/hybrid candidate |
| Branch/offline backlog experimentation | Dolt strongest candidate |
| Trusted distributed/offline sync | Dolt remotes should be evaluated |
| Strict team authority with claims/permissions/live gates | Serialized server authority still likely required |
| Beads migration/fidelity/history | Dolt first-class source and fidelity oracle |
| Knowledge/provenance | Dolt history/log/diff should be indexed |

## Plan amendment

A storage decision spike has now been run and recorded in:

- `storage-decision-spike.mjs`
- `storage-decision.md`
- `decisions.md` D7

The spike compared SQLite local broker behavior with Dolt embedded behavior for Forge-like issue/event/outbox writes, idempotency constraints, history queries, and branch conflict detection.

## Decision update

Current position is now:

> SQLite WAL is the first Forge Kernel local authority. Dolt is not the initial primary Kernel authority, but remains a first-class projection/history/branching backend, Beads fidelity oracle, and optional future backend candidate.

Dolt-as-authority should be deferred until a Dolt server/remotes spike proves it can enforce the same Kernel semantics around expected revisions, idempotency, claim leases, stage gates, projection outbox/dead letters, and domain conflict quarantine.

## Risk if we do not do this

If we do not evaluate Dolt properly, Forge may rebuild features Dolt already gives us: branchable database history, diff, merge, blame, revert, remotes, and conflict tables. We may also lose important Beads behavior during migration.

## Risk if we over-adopt Dolt

If we make Dolt the Kernel core without domain guards, we may confuse data-level merge success with project-authority correctness. Dolt does not automatically enforce Forge claims, stage gates, idempotency semantics, role permissions, or frontend mutation contracts.
