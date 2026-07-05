# Kernel JSONL Portability Projection (D16)

**Roadmap:** forge-2agy.9.6.x — Beads/Dolt retirement portability prerequisite.
**Decision:** [D16](../2026-06-06-kernel-backlog-memory-roadmap/decisions.md) — "Kernel JSONL portability projection".
**Gates:** `forge-2agy.9.1.8` (Dolt hot-path retirement). Adjacent to D22 `fresh-clone-no-beads-acceptance`.

## Problem

Today `.beads/issues.jsonl` in git is what makes the backlog clone with the repo, diff in
PRs, and survive disk loss. `kernel.sqlite` is a local binary that does none of that. There
is currently **no consumer** that reads `kernel_outbox` (target `jsonl`) and writes a
git-tracked, deterministic JSONL export. Without a Kernel-owned export/import replacement,
retiring Beads silently deletes the portability/bootstrap story.

## Design intent (from D16)

- The Kernel owns **deterministic-order** JSONL export/import artifacts for intentionally
  published clone/bootstrap and reviewable portability snapshots.
- Exports are **explicit projections** — NOT auto-exported on routine mutation or push, and
  NOT the durability mechanism for close/verify state (that stays in local SQLite / server
  authority).
- The projection is the **Kernel's own surface**, not a "Beads compatibility" feature.

## Decisions

### D16-a — Kernel-native JSONL schema (not Beads-shaped)
The projection records mirror the Kernel authority columns directly, not the Beads export
shape (`_type`, `depends_on_id`, numeric priority). We reuse only the *pure* JSONL helpers
(`parseJsonl`/`stringifyJsonl`) from `lib/adapters/beads-kernel-compat.js`. Record shapes:

- `issues.jsonl`: `{ kind, id, title, body, type, status, priority, priority_rank, created_at, updated_at, entity_revision }`
- `comments.jsonl`: `{ kind, id, issue_id, body, actor, visibility, created_at }`
- `dependencies.jsonl`: `{ kind, id, issue_id, blocks_issue_id, dependency_type, created_at }`
- `manifest.json`: `{ schema_version, source, counts, content_sha256 }` (timestamp-free → deterministic)

### D16-b — Write location: `.forge/kernel/` (git-tracked, NOT `.beads/`)
`.forge/` is the established Kernel-owned, git-tracked directory. `.beads/` is gitignored and
must stay out of the write path (dolt-hot-path-retirement & github-projection acceptance).

### D16-c — Determinism contract
Records are normalized to the canonical key set/types, then sorted by stable byte-order keys:
issues by `id`; comments by `(issue_id, created_at, id)`; dependencies by
`(issue_id, blocks_issue_id, dependency_type, id)`. JSON keys are emitted in fixed insertion
order. Same logical state → byte-identical files. `manifest.content_sha256` is the sha256 of
the three concatenated JSONL files.

### D16-d — Outbox-driven consumer, full-snapshot rebuild
`kernel_outbox` entries for target `jsonl` are **dirty markers**. Draining them performs ONE
full-snapshot write covering all of them (idempotent rebuild). On success, every drained
entry is marked `done`. On write failure the batch increments `attempts`; entries below
`maxAttempts` return to `pending` with a backoff `next_attempt_at`; entries at/above
`maxAttempts` are dead-lettered (`kernel_dead_letters` row + outbox `status=dead`). Projection
failure never mutates Kernel authority.

### D16-e — No `schema.js` change
`kernel_outbox` already has `next_attempt_at`; `kernel_dead_letters` already exists; `target`
is free TEXT so `'jsonl'` needs no migration. This also avoids the PR 5 (taxonomy) conflict on
`schema.js`.

### D16-f — Additive broker methods only
broker.js gains read/update outbox methods (`listProjectionOutbox`, `loadProjectionModel`,
`markProjectionDelivered`, `recordProjectionFailure`, `deadLetterProjection`) delegating to new
driver methods. The append/CAS path (`enqueueKernelProjection`/`insertKernelEvent`/
`runGuardedEvent`) is untouched — PR 3 owns it (parallel-safe).

### D16-g — Dedicated `forge export` command; `sync.js` NOT auto-wired
A standalone `lib/commands/export.js` (export + `--import` bootstrap). `sync` is deliberately
NOT modified to auto-export, because D16 forbids auto-export "on routine mutation or push".
Portability artifacts are git-tracked, so ordinary `git`/`forge sync` already carries them.

## Round-trip / bootstrap

`importProjection(writeProjection(model))` deep-equals the normalized model. Bootstrap path:
fresh clone → `forge export --import` reads `.forge/kernel/*.jsonl` → Kernel model for status.
The manifest hash is verified on import (integrity).

## Security (OWASP)

- A01/A03: projection dir is resolved and constrained under the project root; no shell-out, no
  `bd`; `execFileSync`-free. JSONL parsing wraps `JSON.parse` with line-scoped errors.
- A08: manifest sha256 integrity check on import detects tampered/corrupt snapshots.
- No secrets are projected (only issue/comment/dependency authority columns).

## Files

- create: `lib/kernel/projection-jsonl-writer.js`, `lib/commands/export.js`,
  `test/kernel/projection-jsonl-writer.test.js`, `test/kernel/broker-projection-outbox.test.js`,
  `test/commands/export.test.js`, `test/fixtures/kernel-projection/*`
- modify: `lib/kernel/broker.js` (additive outbox read/update methods)
- not modified (by design): `lib/kernel/schema.js` (D16-e), `lib/commands/sync.js` (D16-g)
