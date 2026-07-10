# 0002 — Team server backend: libSQL family

**Date**: 2026-07-09
**Status**: proposed
**Supersedes-in-part**: control-plane Slice 7 (Cloudflare team-authority backend)

## Context

Forge's local authority is SQLite WAL (`PD-20260606-sqlite-local-authority`,
ADR-0001). The broker parses that SQLite file directly and classifies write
conflicts by matching **substrings** of the engine's error text —
`/UNIQUE constraint failed/i` plus `/kernel_claims\.issue_id/i` (claim lease) or
`/idempotency_key/i` (idempotency) — in `lib/kernel/broker.js`. Team /
multi-machine authority was always deferred to "a serialized server authority
later" (`PROJECT_DESIGN.md`).

We must now choose that server backend. The dominant constraints are: (1) keep
migration near-zero by reusing the SQLite engine and its error dialect the broker
already depends on; (2) preserve the local-first, single-writer serialized
authority model; (3) minimize lock-in so the authority stays portable; (4) scale
to many orgs × many projects with durable backup and low-latency reads.

An earlier plan targeted Cloudflare D1 + Durable Objects (control-plane Slice 7),
partly justified by a belief that Cloudflare would break the broker's conflict
classification. That justification was **overstated** and is corrected here.

## Decision

Adopt the **libSQL family** as the team server backend.

- **Target:** self-hosted **`sqld`**, deployed with **namespaces**
  (`--enable-namespaces`, one namespace per project, serialized single-writer
  primary), **embedded replicas** on each client (local/offline reads; writes
  route to the namespace primary), and **bottomless replication to S3** for
  continuous durable backup. No automatic write failover exists, so provide a
  **scripted promote-from-bottomless runbook** on a fast-restart platform
  (Fly.io Machines / k8s StatefulSet+PVC / VPS+volume).
- **On-ramp:** **managed Turso** as a config-swap alternative for teams that want
  zero-touch HA — same client, same engine, same error dialect; swap the
  connection target, not the code.
- **Reject Cloudflare** on **runtime-paradigm / engine** grounds — the foreign
  Workers + Durable-Objects execution model and the heaviest lock-in — **NOT**
  on error-text grounds. Cloudflare D1 **does** surface raw SQLite constraint
  text, and the broker matches substrings, so the conflict invariant would in
  fact survive. That correction is deliberate and load-bearing: it keeps
  Cloudflare re-openable (spike `cc25a59a`) rather than dismissed on a false
  premise.

libSQL is verified (2026-07-09) to be literally SQLite (byte-identical error
strings), MIT-licensed, and actively maintained (last commit 2026-07-01; ~185
commits/52wk, rising), with self-hosting officially endorsed by Turso even as
they build a separate (still-beta) Rust engine.

Do not lock this ADR to `accepted` until the verify-before-lock checklist passes.

## Consequences

- **Positive — near-zero migration.** Same engine, same error strings; the
  broker's substring classifier keeps working unchanged (guarded by the CI
  conflict-substring contract, kernel `d4ce47bb`).
- **Positive — local-first is native.** Embedded replicas preserve
  offline-capable reads and the single-writer serialized-authority model Forge
  already assumes.
- **Positive — lowest lock-in.** OSS engine + portable SQLite files; a team can
  self-host `sqld`, move to managed Turso, or export the file and leave.
- **Trade-off — serialized single-writer per namespace.** Correct for
  authority; it caps per-namespace write throughput and means **no automatic
  write failover** — the one real operational cliff.
- **Negative — ops burden.** Self-hosted `sqld` needs the promote-from-bottomless
  failover runbook, tested restores, and regional placement. Managed Turso trades
  this away for company/roadmap risk.
- **Negative — no native webhooks.** External-sync eventing (ADR-0004) must be
  Forge-built, not backend-provided.
- **Watch — engine longevity.** Turso is investing in a separate Rust engine;
  mitigated because authority is a portable SQLite file — if `sqld` stalls, the
  file moves to any SQLite-compatible host.

## Alternatives considered

- **Cloudflare D1 + Durable Objects** — rejected as target. Best-in-class
  serialized authority (Durable Objects) and native webhooks, but a foreign
  Workers runtime and the heaviest lock-in. It surfaces SQLite constraint text
  and the broker matches substrings, so it does **not** break the conflict
  invariant — it stays re-openable via spike `cc25a59a`, not dismissed.
- **Managed Turso (as target)** — same engine reuse and lowest ops burden, made
  the **on-ramp** rather than the target because of embedded-replica
  de-investment signals and company/roadmap risk; kept as a zero-config-swap
  fallback.
- **Fly LiteFS / rqlite / Litestream** — rejected: replication/consensus layers
  over SQLite that either weaken the single-writer authority contract or add
  operational complexity without the namespace + embedded-replica model.
- **Neon / Supabase / PlanetScale** — rejected: Postgres/MySQL dialects force a
  SQL rewrite and break the broker's SQLite error-substring contract; not
  local-first.

## Verify-before-lock checklist

Move to `accepted` only after:

1. **libSQL error-text parity (linchpin):** run the broker's conflict cases via
   `@libsql/client` against a remote `sqld` and confirm
   `kernel_claims.issue_id` and `idempotency_key` still appear verbatim in the
   UNIQUE-constraint messages.
2. **Turso embedded-replica roadmap for new accounts** — the A-vs-C tiebreaker:
   confirm embedded replicas remain first-class for newly created accounts.
3. **`sqld` HA / failover reality:** confirm single-writer-per-namespace behavior
   and a scripted, tested promote-from-bottomless runbook.
4. **Cloudflare `<table>.<column>` token** (only if keeping CF on the table):
   confirm D1/DO still emit `kernel_claims.issue_id` in the UNIQUE message.
