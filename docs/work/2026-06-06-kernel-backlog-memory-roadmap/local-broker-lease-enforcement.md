# Local Broker Safety Proof — Claim Leases & Multi-Process Contention

**Status:** Slice 1 complete (this PR). Slice 2 deferred (see below).
**Tasks:** 9.5.1, 9.5.3, 9.5.6, 9.5.9, 9.5.10 (Phase B — Local Broker Proof).

This PR proves the local Kernel broker enforces its concurrency invariants
atomically and survives real multi-process contention on a single machine /
git common-dir. It hardens the broker *primitive* (`runGuardedEvent`); wiring
the user-facing `forge claim` command surface to emit guarded events is an
explicit follow-up (see **Wiring deferral**).

## What landed

| Task | Guarantee | Where |
| --- | --- | --- |
| 9.5.6 | Event insert + projection-outbox enqueue commit atomically | `broker.js` `runGuardedEvent` `BEGIN IMMEDIATE…COMMIT`, ROLLBACK on failure |
| 9.5.9 | Concurrent idempotency-key collisions resolve to a duplicate replay, not a raw error | `broker.js` catch-block re-reads the winner's event |
| 9.5.10 | At most one **active** claim lease per issue | `migrations.js` partial UNIQUE index + `lease-enforcer.js` + `broker.js` |
| 9.5.1 / 9.5.3 | The lease invariant holds under real concurrent OS processes | `test/kernel/broker-multiprocess.test.js` + worker fixture |

## Enforcement model (two layers)

1. **Hard invariant (load-bearing):** a partial UNIQUE index
   `idx_kernel_claims_active_lease ON kernel_claims (issue_id) WHERE state='active'`
   (migration 003). This is the *only* guarantee that survives a multi-process
   race — a pre-read check cannot, because two writers can both read zero active
   claims before either commits. It mirrors `idx_kernel_events_idempotency`.
2. **Optimization + clean error path:** the pure `lease-enforcer.js`
   (`isLeaseExpired` / `planClaimAcquisition` / `buildClaimConflict`) plus broker
   integration. A live lease is detected pre-write and quarantined without
   opening a transaction; a race that slips past the pre-read is caught when the
   UNIQUE index throws, rolled back, and re-read into a `claim_conflict`
   quarantine. This mirrors the idempotency-recovery architecture exactly.

The pure evaluator (`evaluators.js`) is intentionally **unchanged**: claim
conflict needs a fresh read of claim state, which a pure function cannot do, so
it is decided in the broker transaction.

## Lease semantics (Slice 1)

A claim lease is a `kernel_claims` row with `state='active'`. A lease is **live**
iff it is active and not expired (`expires_at` null = never expires; timestamps
are UTC ISO-8601 with trailing `Z` so lexicographic compare = chronological).

- **No active claim** → insert a new active claim.
- **Active claim, expired** → reclaim: supersede the stale row to `reclaimable`,
  then insert the new active claim, atomically.
- **Active claim, live** → **conflict** (quarantine, `reason='claim_conflict'`),
  regardless of who is asking.
- **Malformed `claim.create`** → quarantine, `reason='invalid_claim_scope'`. It is
  **not** allowed to fall through as a non-claim event (the generic evaluator would
  otherwise accept and persist the event + outbox without ever creating a lease,
  leaving the issue claimable by a later caller). A claim is malformed when it has
  no `issue_id`, or an `expires_at` that is not a valid UTC ISO-8601 `Z` timestamp
  (a junk `expires_at` would make the lexicographic expiry comparison meaningless —
  locking the issue forever or making a live lease look instantly reclaimable).

**Payload consistency:** the claim scope, the inserted `kernel_claims` row, and the
conflict record all read from the **same** `normalizePayload` (`payload_json`-first)
that the evaluator uses to persist the event — so the lease can never describe a
different issue than the accepted event/outbox when both `payload` and
`payload_json` are present and disagree.

### Ownership decision: conservative, no silent renewal

`actor` is **not** currently distinct per concurrent agent — it is not populated
anywhere on the command path today (verified: no `actor` assignment in
`lib/commands/` or `lib/adapters/`). Therefore Slice 1 does **no silent
same-owner renewal**: a live lease blocks ALL new `claim.create` events, even
one with a matching `actor`. A renewal branch keyed on `actor` would let two
agents that share a git user identity silently steal each other's live lease —
the exact race this PR exists to prevent.

This is safe and non-disruptive because a genuine same-claim retry carries the
same `idempotency_key` and is collapsed to a duplicate replay (9.5.9) *before*
claim planning runs. Only a genuinely new claim against a live lease reaches the
conflict path. In-place renewal can be added later once `actor`/`session_id`/
`worktree_id` identity is reliably populated.

## Wiring deferral (conscious decision)

`runGuardedEvent` is currently a broker primitive exercised only by tests — the
real `forge claim` path runs `runIssueOperation` → `driver.issueOperation('claim')`,
a separate method, and there is no production higher-level driver implementing
`insertKernelEvent` / `loadActiveKernelClaim` / `insertKernelClaim` yet (only
test mocks and the low-level `sqlite-driver.js` `exec`/`queryAll`/`close`).

This PR deliberately proves the primitive under contention rather than wiring
the command surface, matching the stated scope ("broker safety **proof**"). The
multi-process fixture therefore proves the **DB invariant** (the partial UNIQUE
index) under real OS-process contention — the load-bearing guarantee — while the
broker's plan/recover logic on top is proven with unit-level mocks.

**Follow-up (not in this PR):** implement a real higher-level Kernel driver and
make `issueOperation('claim'|'release')` emit guarded `claim.create` /
`claim.release` events through `runGuardedEvent`, so the enforcement proven here
becomes reachable end-to-end from the command surface.

## Stage Exit Summary

- **Summary:** The local broker enforces the claim-lease invariant atomically — a DB-level partial UNIQUE index plus transactional broker logic — proven under real multi-process SQLite (WAL) contention.
- **Decisions:** (1) conservative ownership — a live lease blocks all new claims, no silent renewal while `actor` is not distinct per agent; (2) wiring deferral — the broker primitive is proven, the `forge claim` surface is a follow-up; (3) two-layer model — load-bearing DB index + optimization/recovery layer.
- **Artifacts:** `lib/kernel/migrations.js` (partial UNIQUE index), `lib/kernel/lease-enforcer.js` (pure planners), `lib/kernel/broker.js` (transactional write path + quarantine/recovery), `test/kernel/broker-multiprocess.test.js` + `test/kernel/fixtures/claim-race-worker.js` (multi-process proof).
- **Next:** implement a real higher-level Kernel driver; wire `issueOperation('claim'|'release')` to emit guarded events through `runGuardedEvent`; settle the owner-identity model for Slice 2 (release semantics + broad non-owner write guard).

## Slice 2 (deferred)

- `claim.release`: owner releases → `state='released'` (accept); non-owner
  release of a live lease → `claim_conflict`. Requires the owner-identity model
  above to be settled.
- Broad non-owner write guard: extend claim-scope to `issue.update` / `issue.close`
  so non-owner mutations of a claimed issue quarantine. This touches every
  existing broker fixture (new `loadActiveKernelClaim` stubs), so it is a
  separate change.
