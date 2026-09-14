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
2. Add public authority/receipt acceptance cases for idempotent duplicate, conflict, stale head, wrong capability, and incomplete evidence. Include a contract-valid receipt from a non-Flow executor with Flow uninstalled.
3. Implement the supported default local assembly without Flow imports.
4. Prove stable setup/unavailable errors in package-local Windows and Linux development smoke; final RC coverage expands to the approved platform/runtime matrix.

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
5. Ship the bounded facade slice without closing PR5. Implement and certify supported Claude, Codex, Cursor, and Hermes T0-T4 adapters in subsequent dedicated slices with explicit path ownership. Close PR5 only after those supported behaviors pass; truthful installed-version degradation does not excuse missing implementation.

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
4. Verify Beads is inbound-import-only, retire runtime/export surfaces, and prove rollback through Kernel-native backup/restore.
5. Bind receipts to the exact package candidate BOM.

## Task 5 — release convergence

**Issues:** `eb2f1753`, then `8e634347`.

1. Resolve every must/conditional disposition in `plan.md` against live state.
2. Freeze the signed source/package/contract BOM, tag the exact candidate, and publish immutable prerelease packages in dependency order under `next`.
3. Run the exact-artifact matrix against those registry packages on Ubuntu, macOS, Windows, Node 22 and 24, Memory-only, Flow stateless, Flow connected, facade installs, and Claude/Codex/Cursor/Hermes projections with truthful T0-T4 degradation.
4. Prove migration/rollback, monitor/cancellation/cleanup, package integrity/provenance/OIDC/dist-tags, and one sequential merge-train simulation.
5. Run the exact-head full suite and security gates; require durable `PASS` receipts for every G0-G8 lane.
6. Run the minimal supported-skill acceptance corpus; move continuous self-improvement work out of the release gate.
7. Accumulate at least 50 distinct clean RC journey/environment pairs and seven automated observation days across RCs with no unresolved S0/S1 event. A behavioral change creates a new RC; unaffected evidence remains reusable only when the BOM proves unchanged inputs.
8. Perform a metadata-only version, changelog, documentation, and `latest` promotion of the accepted RC. Reverify fresh install, beta.5 upgrade, and rollback from the promoted artifacts.
9. Re-fetch the live release root and enumerate every dependency before declaring completion.
