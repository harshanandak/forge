# Forge capability-to-issue plan

Prepared 2026-09-15. Status: Astra final planning gate PASS at document/source-evidence rung 2 with Feedback as an eighth independent namespace. Source baseline: `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c` plus refreshed selective Kernel issue reads. This is a local planning artifact; it does not change repository, issue, PR, or release state.

## Candidate public capability scopes

The 24-family inventory reduces to eight coherent public scopes:

| Scope | Public responsibility | Shared runtime owner |
|---|---|---|
| `forge.authority.v1` | authorization, work, claims, leases, stages, gates, transitions and receipt acceptance | Kernel authority and transactional store |
| `forge.knowledge.v1` | capture, recall, search, typed knowledge, provenance, lifecycle and enrichment | selected knowledge store/index |
| `forge.evidence.v1` | execution, usage and evaluation evidence intake/query | durable evidence owner |
| `forge.feedback.v1` | consent-bound product feedback preview, submission, status, redaction, lifecycle and export | durable feedback owner sharing approved persistence infrastructure without authority mutation |
| `forge.execution.v1` | packet execution, bounded control, handlers, process lifecycle and result production | execution host and selected provider |
| `forge.monitoring.v1` | event reduction, durable observation, cursors, terminal state and delivery state | reducer plus selected durable observation owner |
| `forge.integration.v1` | typed integration operations and provider contracts for harness, delivery, Git, CI, deployment and other external boundaries | admitted adapter and host grants |
| `forge.composition.v1` | resolve, preview, adopt and compose capabilities, providers and presets | configuration/activation host; authority records adoption |

These eight scopes are public API namespaces. They are not eight indivisible activation units, provider interfaces, stores or grant categories. Operations within a namespace may have different dependencies and independently selected providers. `forge.integration.v1` does not provide a universal `invoke` operation that replaces domain semantics: harness execution and control implement execution contracts, delivery implements delivery contracts, and Git/CI effects retain narrow effect contracts.

`@forge/contracts` remains independently publishable as a neutral format, validation and interoperability library. It owns no authority, state or activation.

Capability IDs do not encode npm package names. Package versions identify the Forge distribution; capability contract versions identify interoperability. Implementations and presets have separate identities and digests.

## Inventory families that remain internal

The following do not currently justify top-level public scopes:

- receipt construction and normalization: internal execution machinery producing public Contracts receipts;
- knowledge retention, redaction, supersession and hygiene: operations within knowledge invariants;
- feedback triage and insight derivation: internal feedback/knowledge analysis that can propose actions but cannot mutate authority;
- PR lifecycle: `authority.pr` operations plus admitted Git/CI integrations;
- migration, backup and restore: explicit administrative authority operations; domain projections remain operations of their owning scopes;
- bounded loops, handler invocation, process control and supervision: execution operations/modules;
- monitor durability bridge: monitoring adapter surface over the selected durable owner;
- Git, CI, deployment, review, merge, Shepherd and handoff: integrations and composed operations, not new authority scopes.

An inventory family becomes a separate top-level scope later only after a real independent consumer proves a coherent API, replaceability need, lifecycle/failure contract and supported journey. Useful lifecycle, recovery, projection and PR operations can remain public within their owning namespaces without becoming new top-level scopes.

## Presets and release packages

Memory and Flow are versioned first-party presets:

```text
forge.preset.memory.v1
= authority + knowledge + evidence + feedback + monitoring

forge.preset.flow.v1
= execution + monitoring + composition
```

The reference Forge workflow is another optional preset. Presets own selection and supported options only. They do not own state, authority, permissions, implementations or processes.

The intended 0.1.0 publication model is one Forge distribution plus the independent Contracts library. `@forge/memory` and `@forge/flow` are not permanent release identities. During migration they may exist as internal forwarding entry points. After the bounded consumer audit completes, record the known support commitments and migration result. Retire new Memory/Flow publication when that decision is supported; retain temporary forwarding adapters only for identified commitments. An incomplete audit is unresolved, not evidence of no consumers. Preserve previously published artifacts.

Supported first-party capability and adapter implementations ship in the distribution and remain inactive until requested. External applications, harness executables and services are declared prerequisites rather than silently bundled or started.

## Minimal manifest

```json
{
  "schema_id": "forge.capability-manifest.v1",
  "capabilities": [
    {
      "id": "forge.knowledge.v1",
      "implementation": "builtin.local",
      "implementation_digest": "integrity-reference",
      "activation": "on-demand",
      "operations": {
        "recall": {
          "resources": ["project-store"],
          "permissions": ["project.read"]
        },
        "capture": {
          "resources": ["project-store"],
          "permissions": ["project.write"]
        }
      }
    }
  ],
  "presets": [
    {
      "id": "forge.preset.memory.v1",
      "selects": [
        "forge.authority.v1",
        "forge.knowledge.v1",
        "forge.evidence.v1",
        "forge.feedback.v1",
        "forge.monitoring.v1"
      ]
    }
  ]
}
```

The static manifest describes available capability and implementation identities, contract versions, activation behavior, dependencies and per-operation resource and permission requirements. Resource declarations resolve to an existing owner; they are not instructions to create another store. Contracts is a library/schema dependency, not an activatable capability. The host computes the effective configuration revision from the selected preset versions, implementation identities and digests, options and capability contract versions. Actor, project, operation, deadline, idempotency, artifact, authority and resolved-configuration context belongs on each operation request.

## 0.1.0 issue disposition

Observed state was read from the live Kernel at `2026-09-15T02:20:52+05:30` against remote source baseline `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`. The observed columns are evidence; the disposition column is a planning recommendation and has not been written to any issue.

| Issue | Observed state | Observed dependencies | Recommended disposition |
|---|---|---|---|
| Distribution completeness (`95372af8-da00-42e0-af64-0111ddab3405`) | `in_progress`, P0 | none | Include; sole owner of root package/workspace/lockfile/packed-install changes; replace stale `@forge/memory-contracts` wording with `@forge/contracts` |
| Contracts rename (`4d41ffb7-8793-4a17-a30b-92130db69672`) | `done`, P0 | none | Reuse as evidence and freeze the neutral contracts needed by parallel lanes; completed rename alone does not prove scope completeness |
| Product architecture (`d6a74dc8-10f7-4be9-9761-2467c3df4798`) | `in_progress`, P0 | none | Surviving architecture parent; rewrite independent-product language to capability namespaces and presets while preserving applicable acceptance and dependent edges |
| Memory assembly (`12d92893-19a9-45b2-9c84-00891a82cff0`) | `open`, P0 | none | Reframe as knowledge/authority/evidence/feedback/monitoring consumer journey and Memory preset, not permanent package proof |
| Feedback contract (`0f6ce951-2493-4c08-ac61-2a158b363a79`) | `open`, P1; read `2026-09-15T02:33:45+05:30` | none; parent `518e49a3-d47c-4616-8ab5-f41dd08d060e` | Split current mixed scope: 0.1.0 owns local `forge.feedback.v1`, transport-neutral envelope, privacy/schema validation, receipt idempotency, timeout-after-accept/unknown, status lookup and durable acceptance; hosted HTTPS origin/path, public URL, retention service and network controls remain later under the cloud parent |
| Flow runner (`1ff3d2f9-22c3-403c-a700-18aa18762093`) | `open`, P0 | none | Reframe as execution/monitoring/composition consumer journey and Flow preset, not permanent package proof |
| Capability facade (`5f4da13f-a813-4e91-a4f8-806755384f31`) | `open`, P0 | `1eddb71d-f630-4584-9816-30bb3db16b8f` | Include; owns lightweight facade, manifest discovery, activation, effective configuration, Doctor and compatibility diagnostics |
| Root facade prerequisite (`1eddb71d-f630-4584-9816-30bb3db16b8f`) | `done`, P0 | `209d80bc-f521-4947-9953-e5b5bf7020f6`, `9c7ff0a8-a8f3-4b73-a989-318121eb0ae0`, `a22882a0-4e68-4933-867b-ed36c8f208e3`, `c2a3c655-ade2-4156-a8dc-e6b4ee2827ad` | Reuse as predecessor evidence; do not infer completion of the new activation/configuration scope |
| Memory backend registry (`5037a7da-d49b-4015-a3fa-aac34425078e`) | `done`, P0 | `3eb1db42-eaa3-4847-9878-7b77310d1beb` | Reuse the existing registry and local floor; do not create another adapter registry |
| Memory projection (`forge-2agy.5`) | `done`, P1 | `forge-2agy`, `forge-2agy.4` | Reuse provenance/rebuildable-projection mechanisms; not proof of cloud service readiness |
| Provider registry (`forge-2agy.6`) | `done`, P1 | `forge-2agy`, `forge-2agy.5`, `forge-5146`, `forge-wj36` | Reuse for provider/capability selection; add only missing activation behavior |
| Lazy skill/MCP contract (`forge-2agy.6.4`) | `done`, P1 | `forge-2agy.6` | Reuse for inactive-until-selected behavior; render-time consent/drift remains separate |
| Claim reconciliation (`9e31a2f0-49c2-4d83-a936-1674871679a2`) | `open`, P1 | none | Include before migration/cutover |
| Migration and recovery (`f2a96ff1-d238-4341-8d14-ef45d08d4b43`) | `open`, P0 | Memory assembly, Flow runner, capability facade, claim reconciliation | Preserve all four dependencies; own additive migration, shadow comparison, rollback and native recovery after capability and claim contracts freeze |
| Hook controls (`7268bc9b-4a64-4ff5-bd83-4ec92481211c`) | `open`, P1 | none | Include; keep warn/deny/approval behavior honest per harness and distinct from authority |
| MCP controls (`9658c21a-f31e-4a5d-b9de-157065013473`) | `open`, P1 | none | Include render/configuration consent and drift behavior without claiming runtime authority |
| Harness delivery (`a5101337-0afb-4322-b823-8dca531b4f81`) | `open`, P1 | `3b863d8b-1e42-4f75-bb45-6a5a8da0de6b` | Narrow mixed scope to the universal durable return floor, four-harness delivery adapters, capability matrix and visible fallback warnings; separate dashboard/historical assumptions before ownership freeze |
| Actor/run identity (`7b60525b-a1e2-4c94-a6b4-81fa76459a24`) | `open`, P1 | `15d5d9f2-c0bf-48ef-92ca-62d3a9f7f77a`, `465f7e62-1928-4bcf-97a5-c2db05504a7e`, `e4d530eb-104e-4e5e-9280-ff19ac781878` | Preserve dependency chain; define Kernel-bound actor/run identity without a second writer |
| Run/receipt authority (`85be2945-ab34-4e3c-abd3-893ee7ea3b4e`) | `open`, P0 | actor/run identity | Include the authority, receipt and completion contracts needed by cross-producer operation while keeping acceptance in Kernel authority |
| Companion bridge (`8d14651d-03a6-4727-8204-2a05ad7fb280`) | `open`, P1 | `1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`, `6f2dbe75-29ea-442e-a175-c7de13aa3c52`, `84c942f3-b7e0-4416-a7d3-11b6c783c0bc`, run/receipt authority, `ce785690-af5d-4a40-bc95-bc99d0ac9125` | Target optional-to-activate first-party 0.1.0 integration after dependencies and conformance; inclusion makes certification a release gate and cannot silently disappear |
| Skill collisions (`da760874-32c4-4011-99a2-88abe865e667`) | `open`, P0 | `205a8106-bf54-44b7-9129-6f3f111b9103`, run/receipt authority, `e4d530eb-104e-4e5e-9280-ff19ac781878` | Include only deterministic identity, provenance, collision and projection behavior required by setup artifacts; defer broader skills redesign |
| Distribution/preset decision (`bfb2f529-21c2-42c6-a00e-0cf3bf36eded`) | `open`, P2 | none | Keep as the single decision child of the surviving architecture parent; rewrite from two packages to one distribution, independent Contracts, Memory/Flow presets, audit-based forwarding adapters, importer-only Beads and no preset-owned authority |
| Final release convergence (`eb2f1753-e84e-40bb-aec8-8233fc348322`) | `open`, P0 | hook controls, MCP controls, migration/recovery | Preserve all three dependencies; sole final candidate/evidence lane after every included release gate passes |

Conflicting architecture survives through `d6a74dc8-10f7-4be9-9761-2467c3df4798` as the parent and a rewritten `bfb2f529-21c2-42c6-a00e-0cf3bf36eded` as its distribution/preset decision child. No new package-decision issue is needed. Existing acceptance requirements and dependency edges remain unless the later issue reconciliation explicitly maps them to a verified replacement.

OpenCode, Pi and DeepSeek Harness certification, hosted cloud, hosted marketplace operations, managed updates, broad community executable admission, richer visual authoring and new enrichment providers remain later unless explicitly promoted with release evidence.

Beads remains inbound import only. Remove or reject live runtime, export, synchronization and authority assumptions. Native Kernel backup/restore owns recovery.

## Conflict-free delivery DAG

```text
D0 architecture and release decisions
   `- freeze namespaces, package policy, Companion/harness disposition
      and base return/warning semantics
                 |
                 v
D1 shared public contracts
   `- one owner for @forge/contracts exports and fixtures
           |                       |
           v                       v
D2 distribution host        D3 parallel semantic lanes
   facade, manifest,         authority
   activation, config       knowledge/evidence
   resolution/revision,      feedback
   preview/adoption,         execution
   Doctor and packaging      monitoring
                             composition presets
           |                       |
           +-----------+-----------+
                       v
D4 connected consumer proof
   knowledge-only, execution-only, external receipt,
   overlapping presets and resource ownership
                       |
                       v
D5 parallel boundary lanes
   four harnesses | Companion | Git/CI/PR controls | recovery/migration
                       |
                       v
D6 final packed release
   all included D5 lanes + final distribution assembly
```

The explicit dependency graph is `D0 -> D1`; `D1 -> D2` and every D3 lane; `D2 + all included D3 -> D4`; `D4 -> every D5 lane`; claim reconciliation precedes migration/cutover; and all included D5 lanes plus final distribution assembly precede D6.

The contract owner merges before host and semantic lanes. The distribution host exclusively owns configuration resolution, preview/adoption, effective revision calculation, activation, root manifests, workspace metadata, lockfile and packed-install fixtures. The composition lane owns preset definitions and workflow composition behavior and consumes host APIs. Authority owns transactions, authorization, receipt acceptance and PR authority. Knowledge/evidence owns its domain operations and persistence implementations. Feedback owns report/envelope semantics, consent/redaction/idempotency, local durable acceptance and delivery-status separation; it cannot mutate authority. Execution owns execution/control/process behavior. Monitoring is a separate semantic lane: its reducer owner handles pure reduction/control, while its named durable-observation owner handles event persistence, outbox, cursors and delivery state. Shared-file ownership follows these semantic owners even when historical files sit under Memory or Flow directories. Harness/integration owners consume contracts and cannot edit domain internals. Generated projections update once during integration rather than independently in every lane.

## Stability, performance and simplicity gates

1. Forge install hooks and runtime discovery, root import and help do not activate unrelated capabilities or create their databases, brokers, watchers, subprocesses, credential reads or provider calls. Package-manager download and extraction are outside this activation guarantee.
2. Knowledge-only use activates no execution, workflow, credential or harness resources.
3. Execution-only use does not require either preset or durable authority when the operation is explicitly non-authoritative.
4. Overlapping presets reuse one durable owner and create no duplicate store, writer, watcher or delivery worker.
5. Configuration preview has no effect; adoption records a resolved revision; replacement content receives no inherited grant; revocation blocks subsequent consequential effects and receipt acceptance.
6. Authorized external receipts are accepted once; unauthorized, wrong-scope, stale, insufficient and replayed claims cannot duplicate or advance authority.
7. A lost response after a possible external effect returns unknown and reconciles using provider guarantees rather than blind retry.
8. Durable events commit before harness delivery; crash/replay cannot lose or duplicate accepted delivery state; acknowledgment does not imply completion.
9. Claude, Codex, Cursor and Hermes each have executable evidence for every advertised capability and reject missing required behavior before effects.
10. The same representative operation works locally and over a serialized process boundary with the same identity, result, error and artifact-integrity semantics.
11. Packed installation contains no unresolved workspace dependency and passes from a clean external consumer directory.
12. Before implementation, record baseline conditions and regression thresholds for cold CLI startup, root-import module count, peak memory, activation latency and steady-state store operations. Re-run the same measurements on the final packed artifact; investigate regressions before adding caches or concurrency.
13. Remove a legacy path only after its supported journeys have a verified replacement or an explicitly approved retirement, configuration/package migration is tested, and recovery remains available.
14. Feedback preview and submission work without either preset; consent, project and endpoint scope, redaction revision, bounded payload and artifact references, and idempotency are enforced; acceptance cannot mutate authority and delivery failure remains separately visible.

## Removal and simplification targets

- retire Memory/Flow as architectural and permanent release identities;
- remove live Beads export/sync/backend authority surfaces while keeping one-way import;
- remove no-op provider/configuration options and empty adapter methods;
- replace eager root imports with demand-driven capability loading;
- converge duplicate registries and setup/profile selectors on existing provider/configuration mechanisms;
- keep one authoritative writer per authority scope, with transactional invariants preserved;
- keep one harness capability matrix rather than hard-coded capability assumptions in multiple commands;
- remove fixed mandatory workflow profiles from the bare product; preserve them as optional presets; and
- avoid a general mapping language, event bus, plugin container, visual editor, hosted marketplace or distributed queue in 0.1.0.

## Decisions required before implementation ownership freezes

1. Validate the eight public namespaces, including Feedback as an independent builder journey.
2. Run the bounded consumer audit and decide whether temporary Memory/Flow publication adapters exist at all.
3. Confirm Companion as a targeted optional-to-activate first-party 0.1.0 integration whose adapter conformance becomes mandatory if it is included in the distribution; core and four-harness journeys must not acquire an undeclared Companion dependency.
4. Rewrite or retire the conflicting package/product issues and create only genuinely missing coverage before assigning PR lanes.
