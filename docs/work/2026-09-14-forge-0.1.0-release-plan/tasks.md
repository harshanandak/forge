# Execution tasks

This task list begins after this planning checkpoint is accepted. Every implementation task uses a dedicated issue-linked worktree. Sol writes and integrates; Luna gathers evidence and reviews bounded lanes.

## Task 0 — reconcile current authority and branches

**Owner:** main integration agent  
**Outcome:** one live issue/branch map replaces stale planning labels.

1. Re-fetch the release root, restructure epic, PR5/PR6/PR7, all direct blockers, and package/stability gates.
2. For PR4B children, compare each acceptance criterion with current `origin/master` and exact-head receipts.
3. Close with evidence, reopen the parent, or assign missing work. Do not infer completion from the parent status.
4. Verify the four auto-stubs contain no unique acceptance; supersede them.
5. Record the exact PR5 head and external Companion clean/dirty boundary.
6. Update dependency edges so PR7 represents the actual release gate.

## Task 1 — freeze the provider and receipt seam

**Owner:** one Sol contracts owner  
**Files:** `packages/contracts/**` only, plus package-local tests.

1. Write failing conformance cases for provider identity, packet/hash binding, cancellation/cleanup evidence, and all four terminal outcomes.
2. Add the smallest additive contract/API changes.
3. Prove current WorkPacket and RunReceipt fixtures still parse under the compatibility policy.
4. Publish the exact source SHA, contract digest, schema versions, and N/N-1 rules in the stage handoff.

## Task 2A — standalone Memory

**Owner:** Sol Memory owner  
**Issue:** `12d92893`  
**Files:** `packages/memory/**` and Memory package tests/docs.

1. Start with a failing packed-install journey: create default Memory, store, recall with provenance, close, restart, recall.
2. Add public authority/receipt acceptance cases for idempotent duplicate, conflict, stale head, wrong capability, and incomplete evidence.
3. Implement the supported default local assembly without Flow imports.
4. Prove stable setup/unavailable errors on Windows and Linux.

## Task 2B — standalone Flow and monitor reconciliation

**Owner:** one Sol Flow owner  
**Issues:** `1ff3d2f9`, plus only the unresolved behavior from `6ddd30c6` and `c5112cd4`  
**Files:** `packages/flow/**`, owned monitor runtime paths, and Flow tests/docs.

1. Start with a failing packed-install execution using the deterministic local provider.
2. Cover PASS, FAIL, INCOMPLETE, NOT_EXECUTED, timeout, cancel race, provider loss, cleanup, and duplicate/conflicting outcomes.
3. Implement the public Flow assembly and canonical receipt producer.
4. Reuse the single Flow monitor runtime; do not add another Shepherd engine.
5. Prove no Memory-private import, no authority mutation, and no orphan process.

## Task 2C — external Agent Companion package

**Owner:** Sol in the Agent Companion repository  
**Forge issue:** `8d14651d` remains blocked until prerequisite contracts are met.

1. Preserve the existing dirty checkout and divide it into reviewable external commits.
2. Fix the parallel batch-settle and command-ordering failures.
3. Add a public package entrypoint/exports and exact version provenance.
4. Implement the generic provider contract in Companion rather than Forge.
5. Pass the shared provider conformance suite, restart/resume, progress backpressure, cancellation, and cleanup checks.
6. Publish or pin a clean immutable artifact. Do not add it to the Forge 0.1.0 BOM.

## Task 2D — bounded PR5 facade

**Owner:** Sol PR5 owner  
**Issue:** `5f4da13f` with the release-required portion of `e8e72233`.

1. Rebase `codex/pr5-integration` onto current `origin/master` without touching user-owned roots.
2. Run existing focused capability/Doctor/preflight tests at the rebased exact head.
3. Keep unsupported adapter tiers explicitly unavailable.
4. Add only package presence/setup diagnostics required for standalone Memory and Flow.
5. Ship the bounded facade slice; leave full adapter implementation in its dedicated issues.

## Task 2E — parallel authority, controls, and validation

Run these as separate, non-overlapping worktrees:

- Claim projection and migration preflight: `9e31a2f0`.
- Hook control projection: `7268bc9b`.
- MCP registry/consent projection: `9658c21a`.
- Skill mirror authorization/recovery: `209d80bc`, `c94f36f9`.
- Validation/process isolation: `50d3f2c3`, `fd64f6c9` and directly overlapping active runner issues.

Each lane owns only its named modules and focused tests. The validation owner cannot change product behavior; product owners cannot tune the shared runner.

## Task 3 — serialize facade and package integration

**Owner:** main Sol integration agent.

1. Merge Memory before Flow after both pass package-local validation.
2. Update root manifests, `bun.lock`, version compatibility, generated manifests, and facade composition in one integration lane.
3. Resolve runtime workspace packaging and global install issues.
4. Pack Contracts, Memory, Flow, and the facade; run all journeys without workspace links.
5. Freeze package candidates and the compatibility/BOM record.

## Task 4 — migration and rollback

**Issue:** `f2a96ff1`.

1. Capture beta.5 state inventory and a verified backup.
2. Prove dry-run, successful cutover, interruption recovery, and rollback.
3. Prove sole-writer authority and no shadow writes.
4. Verify Beads is migration/rollback compatibility only.
5. Bind receipts to the exact package candidate BOM.

## Task 5 — release convergence

**Issues:** `eb2f1753`, then `8e634347`.

1. Resolve every must/conditional disposition in `plan.md` against live state.
2. Run packed Memory, Flow, and facade journeys on Windows and Linux.
3. Run the exact-head full suite and security gates; require a durable `PASS` aggregate.
4. Run the minimal supported-skill acceptance corpus; move continuous self-improvement work out of the release gate.
5. Freeze signed source/package/contract BOM and rollback artifacts.
6. Perform a metadata-only version, changelog, documentation, tag, and publish promotion.
7. Re-fetch the live release root and enumerate every dependency before declaring completion.

