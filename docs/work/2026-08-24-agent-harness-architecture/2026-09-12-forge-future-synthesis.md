# Forge: a coherent plan after beta.7

Decisions needed: none for this recommendation. This is a proposed roadmap, not a change to approved scope or release gates.

**Continue the existing product split and organize the remaining work around three demonstrable outcomes: useful Memory on its own, useful Flow on its own, and reliable execution across different harnesses.** Adapters, skills, receipts, plugins, and retrieval systems belong under those outcomes. They should not each become a competing architecture program.

The practical order is **reconcile the release evidence → prove independent products → prove portability → add measured extensions**. Thin adapter probes and the evaluation baseline start early. Full adapter integrations and optional providers come later.

**What the current evidence changes**

GitHub lists beta.7 as a prerelease published on September 11, 2026, at commit `7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9`. Its release notes cover runtime workspace bundling and the public contracts package rename. It is a baseline to assess, not evidence that every promise in the restructuring plan is complete. [Beta.7 release](https://github.com/harshanandak/forge/releases/tag/v0.1.0-beta.7).

The tracked repository already contains Memory, Flow, and Contracts packages. However, the inspected standalone smoke test installs all three together and checks that Node can import them. The Memory package takes an injected authority broker, while durable storage implementation remains under root `lib`. These are useful boundaries, but the inspected evidence does not establish complete independent user journeys. [Standalone smoke test](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/test/integration/standalone-package-smoke.test.js#L128), [Memory authority provider](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/packages/memory/src/authority-provider.js#L37), [current storage integration](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/lib/memory/router.js#L6).

That makes the first engineering target concrete: **a new user installs one product, completes a useful task, restarts it, and retains the expected result without the Forge repository or the other product supplying hidden dependencies.** Finish extraction only where that journey demonstrates a missing boundary.

Several earlier recommendations already have implementation to reuse: Flow has an injected packet executor, package-boundary tests restrict cross-product imports, and executable harness probes distinguish successful, incomplete, and unavailable capabilities. The remaining work should connect and test those pieces, not build a second registry or executor from the older audit's description. Probe coverage is still distinct from a complete host execution adapter. [Existing executor](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/packages/flow/src/executor.js#L217), [boundary tests](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/test/structural/product-package-boundaries.test.js#L110), [capability probes](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/lib/capabilities/probes.js#L245).

**Resolve the apparent architecture conflict once**

The earlier audit says “memory informs; Kernel owns authority.” The approved product plan says “Forge Memory owns the Kernel.” Both can hold:

- **Forge Memory is a product.** It contains the Kernel, durable state, knowledge services, and public contracts.
- **Recalled memory is information.** Summaries, graph edges, and extracted facts do not grant permission, pass gates, or complete work.
- **The Kernel inside Memory owns those decisions.** It evaluates evidence under current policy.

This is already the accepted product boundary. Preserve it rather than introducing a fourth product or reopening naming as an architecture prerequisite. [Approved ownership decisions](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/decision-register.md#L13).

| Part | Responsibility | Boundary to preserve |
|---|---|---|
| Forge Memory | Durable authority, knowledge, provenance, storage, lifecycle, packet and receipt contracts | Retrieved information cannot silently become an accepted decision |
| Forge Flow | Execute authorized work, supervise processes, collect evidence, return receipts | Does not decide authoritative completion or import Memory storage internals |
| Forge facade | Installation, discovery, compatibility, integration | Does not acquire its own durable authority |
| Agent Config | Operator routing, privacy, reachable providers, preferences | A run records the policy it used; integrations do not silently copy mutable policy |
| Agent Companion | Execution provider with cancellation, traces, and receipts | Its job status is evidence for Forge to check |
| Adapters | Translate a particular host, transport, or provider contract | Advertise only capabilities they can demonstrate |
| Skills and plugins | Procedures and packaging for capabilities | Neither is a second workflow authority |

Flow independence needs two explicit modes. A stateless run consumes a portable packet and produces a local receipt; it cannot claim shared work, advance an authoritative stage, or authorize a merge. Connected Flow uses the public Memory provider contract. This distinction is already in the plan. [Flow operating modes](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/plan.md#L375).

**The delivery sequence**

| Milestone | User-visible result | Proof required to exit |
|---|---|---|
| Release reconciliation | One trustworthy account of what beta.7 delivers and what the 0.1 train still owes | Map existing acceptance criteria to exact source, package artifacts, runtime evidence, and live issue state; identify discrepancies without silently closing issues |
| Independent products | A user can choose Memory, Flow, or both | Separate fresh-install journeys, usable public entry points, restart/recovery, and declared dependencies only |
| Portable execution | The same work contract works through materially different harnesses | Shared conformance cases, truthful capability probes, failure/cancellation evidence, and independently verified receipts |
| Selective extension | One optional capability solves an observed user problem | Demonstrated improvement over baseline, bounded operational cost, reliable removal/failure behavior |

The existing release sequence is beta.6 contracts/preflight, beta.7 operational split, RC migration/freeze, then stable. Treat unmet promises from that sequence as release work; do not relabel them as optional future innovation. New product expansion should not quietly enlarge the stable release gate. [Approved release sequence](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/decision-register.md#L19).

After reconciliation, run two implementation tracks with one integrator owning shared contracts:

| Track | First useful journey | Essential failure cases |
|---|---|---|
| Memory | Install and initialize locally; store source-backed information; retrieve it with scope and provenance; restart; export/restore; supersede or forget a record | Cross-project leakage, stale/deleted injection, migration failure, unavailable enrichment provider |
| Flow | Install independently; consume a packet; execute a bounded local task; return a receipt; repeat using a connected provider | Invalid packet, timeout, cancellation race, provider loss, duplicate/conflicting receipt, process cleanup |

Memory-only onboarding should not require the user to adopt Forge's full issue workflow or configure a harness just to store and retrieve knowledge. This is a proposed usability criterion; the Kernel can remain inside the package without making every user learn its entire control model.

For the combined journey, Memory issues authorized work, Flow executes it, an adapter or Companion supplies execution, and Memory verifies the receipt before recording the result. An adapter's `completed` status alone must not close the work.

Start small host probes while building these journeys. Choose two hosts with different lifecycle/control capabilities—for example Codex and OpenCode or Pi, subject to current probes. Do not certify every named harness at once. An unsupported capability should produce an explicit unavailable result, not a prompt pretending to enforce it. DSH remains a candidate with its own capability limits to verify.

**Where all the earlier ideas fit**

| Earlier idea | Place in the roadmap | Admission rule |
|---|---|---|
| Authority snapshots, work packets, evidence and completion receipts | Shared product contracts | Extend existing schemas only where a failing acceptance case requires it; avoid competing receipt formats |
| Actor identity, leases, stale plan reconciliation, Beads/D45 consistency | Release integrity and Memory authority | Resolve contradictions that affect accepted state or promised migration behavior before expanding capabilities |
| Skill provenance, collisions, invocation preservation, atomic projections | Minimum reliable invocation for Flow and adapters | Fix demonstrated routing/installation failures early |
| Full skill manager, groups, preview UI, broad skill library | Later usability work | Add when actual users cannot manage the minimum surface reliably |
| Harness registry, permissions, conformance fixtures | Portability milestone | Early probes, then production support for two hosts through the same tests |
| Companion integration | A Flow execution-provider integration | Must use the same contracts; no special authority shortcut |
| Routing weights and privacy policy | Agent Config integration | Snapshot effective policy and provenance at run creation |
| Monitor engine, supervision, backpressure, Windows process behavior | Flow reliability | Reuse existing runtime mechanisms; durable evidence with bounded process lifecycle |
| Owned plugin registration, draining, replacement, rollback | Packaging for the first demanded executable extension | Prove installation, activation failure, cancellation/removal, and recovery for one real provider before generalizing |
| Provenance, retention, forget, redaction, supersession | Memory baseline | Required before trusting automatic ingestion or external projections |
| FTS5 evaluation and provider benchmark | Continuous evaluation from the first milestone | Fix corpus, baselines, failure cases, and measurement before implementing a candidate |
| Graphify | Optional code-navigation/blast-radius experiment | Measure affected-file/path correctness; do not judge a code graph solely by memory Recall@5 |
| Graphiti | Optional temporal-memory experiment | Admit only if temporal retrieval failures justify it and lifecycle/deletion behavior is proven |
| OpenViking | Optional context-delivery experiment | Evaluate progressive context delivery and host integration against a concrete need |
| Mem0 and GraphRAG | Research backlog | Revisit only for a specific conversational-memory or document-analysis need |
| Dashboards, marketplace, cloud skill sync, broad automatic provider selection | Deferred product expansion | Require demonstrated adoption or operating pain |
| Physical repository split | Post-stable extraction decision | Meet the existing independent-release and compatibility criteria first |

The provider placements above synthesize the earlier research you supplied. They are proposed experiment scopes, not fresh verification of each vendor's current APIs, licensing, or performance. Recheck those facts when an experiment is admitted.

There are several different adapter boundaries: harness execution adapters belong to Flow; knowledge enrichment adapters belong to Memory; CLI/MCP and other transports expose the relevant public service. They can share manifest conventions where useful without being forced into one universal execution interface.

**Use evidence to choose the next item**

Build on the existing acceptance contracts and validation matrix instead of creating another schema catalog. Add a concise view with these rows:

| Acceptance outcome | Memory only | Flow stateless | Connected | Host one | Host two | Companion |
|---|---|---|---|---|---|---|
| Fresh install and useful first task | Required | Required | Required | Required | Required | Required |
| Correct authority and scope | Required | Restricted local mode | Required | Required | Required | Required |
| Failure, restart, and cleanup | Required | Required | Required | Host-dependent semantics declared | Host-dependent semantics declared | Required |
| Traceable result or receipt | Source references | Portable receipt | Accepted/rejected receipt | Execution evidence | Execution evidence | Execution evidence |
| Independent upgrade compatibility | Required | Required | Required | Contract conformance | Contract conformance | Contract conformance |

This table states requirements, not passing results. Each implementation row should point to its existing issue, owner, dependency, exact tested artifact, result, and next missing proof. The next task is the smallest change that turns a required failing or unknown cell into a demonstrated pass.

For Memory, measure relevant source retrieval, freshness, leakage, deletion behavior, latency, and context size. For Flow, measure completion correctness, unauthorized-action attempts, interruption recovery, orphan processes, latency, and model/tool cost. For adapters, measure conformance and truthful capability reporting. Maintain safety/correctness gates separately from quality scores: a retrieval gain cannot compensate for leakage.

A synthetic corpus is the repeatable regression floor. Follow it with representative real user journeys before declaring product viability. Keep established release gates intact; use focused checks during development and the existing full candidate matrix at the release boundary. [Existing acceptance contracts](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/acceptance-contracts.md), [existing validation matrix](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/validation-matrix.md).

**The next planning action**

Reconcile the product restructuring epic (`d6a74dc8-10f7-4be9-9761-2467c3df4798`) and the multi-harness architecture epic (`44ed41f0-eda8-41a6-93cc-64ac350cc497`). Keep restructuring as the product/release plan; treat the architecture epic as a source of linked capability work, not a second mandatory release ladder. The latter was live-read as open; its research child (`f831f7c5-7e48-4a77-b327-a0c572828b8b`) remains in progress. Those labels alone do not prove the underlying work unfinished or finished.

Give each overlapping item one disposition: already evidenced, required release gap, next product improvement, bounded experiment, or superseded proposal. Reuse existing issues and dependencies. Do not bulk-close from old reports. Then select the first Memory journey and first Flow journey, assign non-overlapping ownership, and let shared contracts have one integration owner.

One concrete reconciliation example is the adapter reference: it still describes Beads as a bundled issue adapter, whereas D45 specifies migration-only use and the current issue path uses `KernelIssueAdapter`. Resolve that existing contradiction in its owning work before using the reference as a specification for new adapters. [Adapter reference](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/reference/ADAPTERS.md#L3), [D45](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-04-28-skeleton-pivot/locked-decisions.md#L587), [current issue adapter](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/lib/forge-issues.js#L104).

Keep one repository for now. The approved plan already requires at least two accepted package cycles with independent builds, compatibility, failure evidence, and release ownership before physical extraction. Package usability is the immediate goal. [Repository extraction criteria](https://github.com/harshanandak/forge/blob/7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9/docs/work/2026-08-09-forge-product-restructure/plan.md#L343).

**Evidence and scope:** Three agents contributed standalone-product inspection, adapter inspection, and an independent sequencing challenge. GitHub release and selected Kernel state were freshly read; source conclusions are rung 2 at the fetched remote SHA above. No end-to-end package journeys or provider benchmarks were run for this planning answer. Historical memory was used for orientation; current recommendations rely on the supplied audits and refreshed source evidence. This report is outside the repository; it does not mutate code, approved plans, issues, claims, or release state.
