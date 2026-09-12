# Independent findings: standalone products, adapters, and sequencing

**Captured:** 2026-09-12

**Purpose:** Preserve the three bounded agent results used by the [future synthesis](2026-09-12-forge-future-synthesis.md).

**Authority:** Research input only. The first two inspections are rung 2 at `origin/master` SHA `7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9`; the sequencing challenge is conceptual review and has no fresh runtime proof. Observed seams are not acceptance proof.
**Privacy:** This record contains findings and repository pointers, not raw session or customer payloads.

## Standalone-product inspection

At the inspected SHA, the workspace packages are real package boundaries, while complete standalone product behavior remains unproven.

### Memory

- `@forge/memory@0.1.0-beta.6` declares only `@forge/contracts`, ships `index.js` and `src`, and has no binary or storage dependency (`packages/memory/package.json:2-16`).
- Its public index exports authority/provider wrappers, backend registry, feedback, PR lifecycle, usage evidence, and `createMonitorStore`; it does not construct a Kernel database (`packages/memory/index.js:319-330`).
- `createMemoryAuthorityProvider` requires an injected broker implementing the Kernel authority method set (`packages/memory/src/authority-provider.js:3-18,37-59`).
- Monitor durability requires an injected monitor-capable SQLite driver (`packages/memory/index.js:265-316`); usage evidence also requires an injected driver (`packages/memory/src/usage-evidence.js:184-200`).
- Durable authority and storage remained in the root package at this SHA: the local memory router uses `lib/project-memory`, and SQLite monitor primitives live in `lib/kernel/sqlite-driver.js` (`lib/memory/router.js:6-24,388-411`; `lib/kernel/sqlite-driver.js:5354-5375`).
- Package tests prove API shape and driver validation. They do not prove that the package independently opens its database or exposes a Memory CLI (`packages/memory/index.test.js:9-32`).

### Flow

- `@forge/flow@0.1.0-beta.6` declares only `@forge/contracts`, ships `index.js` and `src`, and has no binary (`packages/flow/package.json:2-16`).
- It exports execution, monitor, lifecycle, supervision, and skill APIs (`packages/flow/index.js:3-29`).
- Execution requires an injected synchronous run provider; packet validation requires caller-supplied expected live evidence (`packages/flow/src/executor.js:32-42,217-263`).
- Connected monitor behavior requires an injected six-method store and delivery callback (`packages/flow/src/monitor-durability.js:320-332`).
- The package tests use injected runtimes. The inspected standalone smoke test installs all three packages together and only requires them; it does not execute a Memory-only or Flow-only journey (`test/integration/standalone-package-smoke.test.js:128-161`).

### Proposed acceptance milestones

These are missing proof proposals, not a complete runtime audit or claims that every capability is globally absent.

1. Memory wraps the required authority, storage, migrations, projections, and public client/file entry points behind the package. Prove exact authority semantics, backup/restore, and a Memory-only isolated build/test (`docs/work/2026-08-09-forge-product-restructure/plan.md:639-647`).
2. Flow supports packet-file to receipt-file stateless operation, connected provider wiring, lifecycle and monitor durability, and failure injection without Memory-private imports (`plan.md:649-660`).
3. The approved plan calls for `forge-memory` and `forge-flow` binaries, isolated sparse-pack installs, and 25 clean Windows/Linux standalone and connected canary journeys over 72 hours before beta.7 exit (`plan.md:358-383,800-807`). No such canary was run in this inspection.

## Adapter-boundary inspection

At the inspected SHA, the accepted product ownership is coherent: Memory is the durable authority and foundation, Flow is optional execution, and the facade routes between them. Standalone Memory does not depend on completion of the adapter or plugin program.

### Accepted product boundaries

The accepted source is the [product restructure plan](../2026-08-09-forge-product-restructure/plan.md):

- Memory owns Kernel authority, durable memory, packets and receipts, leases, projections, and migrations, and is usable without Flow (`plan.md:133-148`).
- Flow owns execution, skills, monitors, process lifecycle, Git/CI/PR adapters, and Shepherd. It communicates through `@forge/contracts`, an injected public Memory provider, and portable files; it does not import Memory storage, broker, or schema internals (`plan.md:150-163`).
- Memory-only, Flow-only, and adapter changes have separate validation scopes (`plan.md:174-182`).
- The monorepo topology is extraction-ready, while physical separation waits for measured compatibility, failure-injection, ownership, and release evidence (`plan.md:327-356`).

The naming distinction is essential: the **Forge Memory product contains Kernel authority**. Recalled information, summaries, graph edges, and extracted facts are knowledge inputs and do not confer authority.

### Observed reusable seams

- The Memory backend registry keeps local writes first and degrades safely when optional enrichment fails (`packages/memory/src/backend-registry.js:79-157`).
- Memory authority and monitor durability are injected (`packages/memory/src/authority-provider.js:25-59`; `packages/memory/index.js:265-316`).
- Flow's packet executor handles idempotency, mutation authorization, and terminal receipts; monitor durability accepts an injected store and delivery callback (`packages/flow/src/executor.js:217-274`; `packages/flow/src/monitor-durability.js:320-417`).
- Skill runtime behavior is injected through metadata, handlers, and capabilities (`packages/flow/src/skill-runtime.js:60-117`). Structural tests limit Memory and Flow imports to `@forge/contracts` (`test/structural/product-package-boundaries.test.js:9-14,110-135`).
- `KernelIssueAdapter` wraps the broker, while `GreptileReviewAdapter` wraps an injected GitHub client (`lib/adapters/kernel-issue-adapter.js:43-95`; `lib/adapters/greptile-review-adapter.js:22-80`).
- Executable capability probes can return honest `PASS`, `INCOMPLETE`, or `UNAVAILABLE` (`lib/capabilities/probes.js:18-28,245-332`). Capability truth is distinct from a production host delivery adapter.
- Plugins at this SHA load agent definitions into the monolithic CLI (`bin/forge.js:33-155`).

### Smallest proposed sequence

1. Lock shared contracts and negative fixtures; use thin harness probes as contract-design tests.
2. Prove Memory-only add, recall, search, and receipt behavior over the local floor and injected authority provider.
3. Prove stateless Flow `WorkPacket -> RunReceipt` with an injected runner and contracts only.
4. Add provider-specific delivery adapters after Flow core, with honest unsupported results (`plan.md:649-660`).
5. Complete standalone entry points and facade routing as part of the independent user journeys, rather than after the whole adapter program.

### Historical documentation conflict

At this SHA, `docs/reference/ADAPTERS.md:3-5,9,24-30` described Beads as a bundled reference adapter, while D45 specified migration-import-only behavior (`docs/work/2026-04-28-skeleton-pivot/locked-decisions.md:587-599`) and the live issue route used `KernelIssueAdapter` (`lib/forge-issues.js:104-123`). Treat D45 as authoritative and verify current tracked state before acting; this finding does not establish that the conflict still exists.

## Independent sequencing challenge

This lane challenged the supplied source findings; it performed no new tool or runtime verification.

The strongest correction is to prove portability while shared APIs remain cheap to change. Thin implementations should exercise standalone Flow and two materially different hosts early. Full production adapters and Companion integration can follow. Otherwise the packages may look independent while encoding one runtime's assumptions.

### Proposed milestones

1. **Release baseline:** reconcile the product-restructure and architecture epics against beta.7 in one dependency and decision map. Classify old items as invariant, current release outcome, measured experiment, or obsolete. Do not create a new umbrella epic.
2. **Boundary conformance:** demonstrate Memory as the sole authority writer; keep knowledge and contracts in the Memory product; require Flow to consume a versioned WorkPacket and return a complete RunReceipt; prove standalone Flow has no Memory storage dependency; prove connected Flow uses an injected public provider; keep the facade free of independent authority or orchestration.
3. **Parallel product outcomes:** prove Memory install/init, authority, retrieval/provenance, export/import or backup/restore, upgrade/repair, and recovery; alongside Flow deterministic packet execution, truthful failure/cancellation evidence, portable receipts, and repeatable standalone runs.
4. **Portability:** run the same corpus through standalone Flow and two hosts with different capability sets. Unsupported behavior must be explicit. Treat Companion as another contract consumer.
5. **Measured extension:** define the corpus and thresholds before implementation. Keep FTS5 as baseline. Admit an enrichment provider only for a demonstrated failure at acceptable operational cost. Graphify is optional; Graphiti and OpenViking remain laboratory candidates until temporal or contextual failures justify them.
6. **Repository separation:** keep independent packages in one repository. Consider a physical split only after two accepted release cycles prove stable contracts and conformance without repository-private dependencies.

### Scope traps

- Renaming authority data as remembered content.
- Allowing Companion to become a second control plane.
- Building a generic plugin or skill manager before a demanded extension needs it.
- Turning every researched system into a roadmap commitment.
- Treating a synthetic benchmark win as product proof.
- Replacing deterministic skill invocation and collision handling with a large management surface before observed failures require it.

### Proposed planning view

Attach one acceptance view to the existing product and architecture epics. Use outcome rows and `standalone`, `connected`, two distinct hosts, and `Companion` columns. Each cell records current evidence, missing proof, owner, and release target. Old ideas survive when they fill a failed or unknown cell.
