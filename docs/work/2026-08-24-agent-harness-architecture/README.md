# Forge future research archive

This folder preserves the research behind Forge's post-beta.7 product and architecture planning. It is an evidence archive, not a second roadmap. The accepted product plan and Kernel issues remain authoritative.

## Read this first

The current boundary is:

```text
Forge Memory product  = Kernel authority + durable knowledge + public contracts
Forge Flow product    = optional execution + supervision + execution adapters
Forge facade          = install, discovery, compatibility, and routing
Recalled information  = provenance-backed input; never permission or completion authority
```

The [product restructure plan](../2026-08-09-forge-product-restructure/plan.md) and [decision register](../2026-08-09-forge-product-restructure/decision-register.md) define accepted ownership and release direction. Research in this folder supplies evidence, risks, and proposals. Where wording conflicts, the accepted product records win.

At capture time, the next integration task was **Facade, harness, and capability integration** (`5f4da13f-a813-4e91-a4f8-806755384f31`). Its current owner, lease, evidence, and completion state belong in the Kernel; refresh with `forge show 5f4da13f-a813-4e91-a4f8-806755384f31`. Planning comment `46b4013d` is the bounded entry point recorded by the integration lane. This archive does not mark that work complete.

## Archive map

| Record | Purpose | Status |
|---|---|---|
| [Original multi-harness architecture audit](research.md) | 570-line source-ledger, failure taxonomy, contract proposals, issue map, and 2026-08-30 decisions | Historical research; exact copy from commit `bc13377c53130908ce7008b992119e84bc1dad5f` |
| [Public portable-harness research](sources/2026-08-30-parallel-public-agent-harness-research.txt) | Primary-source external comparison of DeepSeek Harness, Cordis, skills, pstack, MCP, A2A, and lifecycle/security mechanisms | Historical public research input; stored as text because its bracketed citations are not Markdown reference definitions; line-ending normalization documented below |
| [User-supplied architecture audit](2026-09-12-user-supplied-architecture-audit.md) | Control-plane, receipt, skill, adapter, Companion/Config, plugin, and delivery-wave analysis | Historical supplied analysis; proposals and stale-sensitive findings labeled |
| [User-supplied memory-provider audit](2026-09-12-user-supplied-memory-provider-audit.md) | FTS5 baseline, lifecycle, benchmark gates, and Graphify/Graphiti/OpenViking/Mem0/GraphRAG dispositions | Historical supplied analysis; no provider benchmark or selection |
| [Independent agent findings](2026-09-12-independent-agent-findings.md) | Standalone-product inspection, adapter-boundary inspection, and sequencing challenge | Rung 2 source findings plus conceptual challenge; no product acceptance run |
| [Coherent future synthesis](2026-09-12-forge-future-synthesis.md) | Connects accepted product boundaries to independent usability, portability, and measured extension milestones | Proposed planning synthesis; exact preserved copy |
| [Initial package-journey baseline](2026-09-12-initial-package-journey-baseline.md) | Isolated package install, focused tests, and first executable Memory/Flow entry-point probes | Rung 4: install/tests passed; two product journeys `INCOMPLETE`; connected journey `NOT RUN` |

Source-copy provenance:

| File | Original location or ref | SHA-256 |
|---|---|---|
| `research.md` | `origin/feat/agent-harness-architecture` at `bc13377c53130908ce7008b992119e84bc1dad5f` | `15381FDDDE1C5B7E09F8262FF09716C0FBFB5C3B361B7569726FAC41E0BB0DED` |
| `sources/2026-08-30-parallel-public-agent-harness-research.txt` | Completed Parallel public report, originally captured as `parallel-public-agent-harness-research.md`; [run](https://platform.parallel.ai/play/deep-research/trun_7e2acc90d798403e93b23a28b59c2c71) | Original CRLF source: `EDDFB02A95364A3599EDF0B2E1BB55A33DB3ACEED1B808346DFAA980FE51BEE6`; committed LF-normalized blob: `129BC11076BC93976BD05E5D354057A7228CD7AD063CD6D93CADEE89B19BD380` |
| `2026-09-12-forge-future-synthesis.md` | `C:/tmp/forge-future-2026-09-12.md` | `B1E3D383496C5B6C0DB54DA019195D5C6DA9737A571BEF2E59BC57ED0EE77AB4` |

The public report's original source contained 235 CRLF line endings. Git normalized only those line endings in the committed blob; removing the carriage return before each line feed makes the two buffers equal. No text decoding or re-encoding was used, and the archive does not claim that those two byte streams have the same hash. The local paths identify capture provenance only. The repository copies above are the durable records. Raw private sessions, customer data, credentials, and untracked source-worktree state were not copied.

## Accepted, proposed, and experimental

| Class | Meaning here | Items |
|---|---|---|
| Accepted product boundary | Current design authority from the restructure records | Memory contains Kernel authority and knowledge; Flow is optional execution; facade routes without owning authority; product packages communicate through public contracts |
| Required proof from accepted plan | An existing release or product requirement whose pass state must come from current evidence | Independent Memory/Flow entry points and install journeys, connected operation, recovery, contract conformance, canary and release gates |
| Proposed architecture refinement | Research recommendation that needs reconciliation with current contracts and issues | Authority snapshots, typed handoff events, richer adapter lifecycle, skill provenance/collision UX, plugin draining and rollback |
| Measured experiment | Optional capability admitted only against a defined failing baseline | Graphify code graph; Graphiti temporal retrieval; OpenViking progressive context; later Mem0 or GraphRAG only for a concrete need |
| Deferred expansion | No current admission evidence | Marketplace, provider dashboard, cloud skill sync, vector-memory default, broad automatic provider selection, cross-harness phase hopping |

## Workstream disposition

This table is an index into existing ownership, not a new task graph.

| Workstream | Durable owner or source | Archive disposition |
|---|---|---|
| Authority, identity, leases, contracts, evidence, completion receipts | Memory/Kernel and existing authority issues; [acceptance contracts](../2026-08-09-forge-product-restructure/acceptance-contracts.md) | Accepted boundary; prove current behavior before extending schemas |
| Standalone Memory and lifecycle | [restructure plan](../2026-08-09-forge-product-restructure/plan.md), [tasks](../2026-08-09-forge-product-restructure/tasks.md), Kernel issues | Required user journey; recalled content remains non-authoritative |
| Standalone Flow and lifecycle | Same plan/tasks; Flow-owned issues | Required stateless packet-to-receipt and connected-provider journeys |
| Facade and capability probes | [facade routing](../2026-08-09-forge-product-restructure/facade-routing.md), integration issue `5f4da13f-a813-4e91-a4f8-806755384f31` | Current integration surface; reuse existing probes and truthful unavailable states |
| Skills, invocation, provenance, and collisions | Skill collision/source registry (`da760874-32c4-4011-99a2-88abe865e667`); current skill contracts | Fix demonstrated defects; broader manager and library remain evidence-gated |
| Host adapters and certification | Adapter registry (`6f2dbe75-29ea-442e-a175-c7de13aa3c52`), permission semantics (`84c942f3-b7e0-4416-a7d3-11b6c783c0bc`), certification (`8d3786a0-6d1d-4df8-8893-a7c5b710b54c`); [external execution convergence](../2026-08-09-forge-product-restructure/external-execution-convergence.md) | Thin probes start with contract work; production support follows shared conformance |
| Agent Companion and Agent Config | Companion bridge (`8d14651d-03a6-4727-8204-2a05ad7fb280`), policy compiler (`ce785690-af5d-4a40-bc95-bc99d0ac9125`) | Downstream contract consumer and operator policy source; neither becomes Kernel authority |
| Monitor, backpressure, process lifecycle, Windows | Flow reliability owners, including historical Companion backpressure (`1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`) | Reuse existing mechanisms; require bounded cancellation, cleanup, and receipts |
| Plugin lifecycle | Reversible plugin lifecycle (`4d831b25-66f5-4aed-b664-49131f7da797`) | First demanded executable extension first; marketplace deferred |
| Provider benchmark and enrichments | Memory owners; [memory-provider audit](2026-09-12-user-supplied-memory-provider-audit.md) | Build corpus and thresholds first; keep FTS5 baseline; productionize at most one justified provider |
| Beads and D45 | [locked D45](../2026-04-28-skeleton-pivot/locked-decisions.md) and owning migration/docs issues | Migration-only decision wins; refresh and reconcile contradictory references before expansion |
| Physical repository split | Accepted [plan gates](../2026-08-09-forge-product-restructure/plan.md) | Keep one repo until independent release-cycle, compatibility, failure, and ownership criteria pass |
| Marketplace, dashboards, cloud sync | None accepted | Deferred pending demonstrated user or operating need |

## Sequencing guardrails

Use the accepted restructure plan as the release spine. Use the architecture epic as capability evidence and linked implementation work, not as another mandatory ladder.

After shared contract proof, standalone Memory and Flow usability can proceed in parallel with one owner for shared contract changes. Start thin probes early so two materially different hosts test the contract while it is still cheap to change. Begin the evaluation corpus before provider implementation. Memory does not wait for complete plugins or production adapters. Keep one repository until the accepted extraction gates pass. Productionize at most one enrichment provider after it wins a defined benchmark and representative user journey.

## Normative records and live authority

Read these before turning an archived proposal into work:

- [Product restructure plan](../2026-08-09-forge-product-restructure/plan.md)
- [Tasks](../2026-08-09-forge-product-restructure/tasks.md)
- [Acceptance contracts](../2026-08-09-forge-product-restructure/acceptance-contracts.md)
- [Validation matrix](../2026-08-09-forge-product-restructure/validation-matrix.md)
- [Facade routing](../2026-08-09-forge-product-restructure/facade-routing.md)
- [External execution convergence](../2026-08-09-forge-product-restructure/external-execution-convergence.md)
- [Decision register](../2026-08-09-forge-product-restructure/decision-register.md)

Kernel authority records:

- Product restructure epic: `d6a74dc8-10f7-4be9-9761-2467c3df4798`
- Multi-harness architecture epic: `44ed41f0-eda8-41a6-93cc-64ac350cc497`
- Original architecture research child: `f831f7c5-7e48-4a77-b327-a0c572828b8b`
- This preservation child: `dd86f303-c0a9-4a7b-8bb0-7bff4de70e00`
- Current integration task at capture: `5f4da13f-a813-4e91-a4f8-806755384f31`
- Standalone Memory assembly follow-up: `12d92893-19a9-45b2-9c84-00891a82cff0`
- Standalone Flow runner assembly follow-up: `1ff3d2f9-22c3-403c-a700-18aa18762093`

Refresh each with `forge show <id>` before relying on status, ownership, dependencies, or completion.

## Evidence boundary

The 2026-09-12 source-code findings are rung 2 at exact tracked SHA `7393dd9d82ae43cb128dc64d7ae7b4cab48c21f9`. Selected Kernel state and the beta.7 GitHub release were live-read for the synthesis. The independent sequencing challenge was conceptual. A later [rung-4 package baseline](2026-09-12-initial-package-journey-baseline.md) proved isolated package installation and 31 focused tests, then classified the Memory and Flow entry-point journeys `INCOMPLETE` and the connected authorize-to-execute-to-receipt journey `NOT RUN`; it did not prove end-to-end standalone or connected acceptance. No external provider benchmark was run. Historical reports contain older source refs and status; do not treat them as current without refresh.
