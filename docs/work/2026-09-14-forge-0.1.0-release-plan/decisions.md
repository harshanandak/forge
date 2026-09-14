# Locked decisions

## Product model

1. **Memory is the authority product.** It owns Kernel state, durable knowledge, WorkPacket issuance, claims, leases, evidence acceptance, and all authoritative transitions.
2. **Flow is the execution product.** It consumes authorized packets, owns bounded execution/cancellation/cleanup, and is the only producer of canonical Forge `RunReceipt`s.
3. **Agent Companion is an independent execution-provider package and repository.** It returns provider evidence to Flow. It never imports Memory storage, writes Kernel authority, advances stages, approves gates, or authorizes merges.
4. **Forge is a stateless compatibility facade.** It composes installed products explicitly and preserves existing CLI behavior. Missing products or providers return stable diagnostics.
5. **`@forge/contracts` remains a physical shared library, not a product.** Memory governs authoritative schemas and acceptance semantics. Flow and Companion consume the library without importing Memory implementation code.

## Contract model

1. Freeze the smallest v1 surface needed by supported journeys: `WorkPacket`, authority binding, `CapabilityManifest`, provider identity, canonical hashing/idempotency, cancellation, cleanup, evidence, stable errors, and terminal status.
2. Canonical terminal status is `PASS | FAIL | INCOMPLETE | NOT_EXECUTED`. Unknown, stale, partial, timed-out, conflicting, or unverified work cannot become `PASS`.
3. Every authoritative result binds the packet hash, run/attempt identity, repository/worktree, exact head, workflow-config revision, capability digest, and lease epoch when applicable.
4. Provider-specific job, session, trace, route, usage, and downstream receipt data remains nested provider evidence. It does not become top-level authority.
5. Host-specific additions use advisory extensions unless a failing cross-provider acceptance case proves that a new canonical field is required.
6. Contracts support a declared N/N-1 reader compatibility window. Exact compatibility rules are recorded in the package baseline.
7. Installation never silently activates another product or provider.

## 0.1.0 boundary

1. Forge 0.1.0 must ship usable standalone Memory and Flow assemblies, the truthful facade, beta.5 migration/rollback, exact published-artifact proof, and reproducible Windows/Linux validation.
2. The Agent Companion bridge may develop in parallel but is not included in the Forge 0.1.0 BOM and cannot block Forge promotion.
3. PR5 ships its bounded facade/capability work with unsupported adapter tiers reported as unavailable. Full T0-T4 implementation and certification is later work.
4. Existing Shepherd, review, monitor, and merge behavior is preserved through regression evidence. The release train does not redesign it again.
5. `@forge/contracts` is not folded into Memory during 0.1.0. That would create unnecessary consumer and versioning churn. Revisit physical consolidation only after a consumer census and compatibility window.
6. Performance work enters 0.1.0 only when it repairs a measured false pass, false failure, resource contention problem, release timeout, or unusable package journey.

## Parallel work rules

1. One owner edits shared contracts. All consumer lanes start from the same frozen contract SHA.
2. Memory, Flow, and external Companion lanes own separate directories and tests. They do not edit root manifests, lockfiles, versions, generated command manifests, changelogs, or release workflows.
3. A single integration owner edits shared manifests, `bun.lock`, generated projections, cross-product fixtures, versions, and release metadata.
4. Memory merges before Flow when both change contract consumption. Companion publishes after its external source is clean and validated. Facade composition follows stable Memory/Flow APIs.
5. Old beta.5-based branches are never merged wholesale. Reuse is by reviewed commit or reimplementation against the frozen current contract only.
6. Every merge checkpoint records exact source SHA, contract digest, package versions, validation receipts, and remaining incompatible consumers.
7. Sol owns implementation and integration. Luna owns bounded exploration, evidence gathering, and review. No two agents edit the same lane.

