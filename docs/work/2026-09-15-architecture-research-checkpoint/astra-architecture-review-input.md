# Forge architecture review packet for Astra

Prepared 2026-09-15. Read-only planning input. This does not approve implementation, change an issue, or update PR #564.

Evidence baseline for repository facts: tracked `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`. Issue rows were refreshed selectively from the live Forge Kernel. Repository findings are source-level evidence, not runtime certification. The shared checkout has pre-existing user-owned changes and was not modified.

## Decision Astra is being asked to make

Recommend the smallest coherent Forge architecture and release sequence that satisfies the user intent below. Challenge the intent where it creates contradictions, weak product value, or unnecessary complexity. Distinguish:

- stable product architecture;
- 0.1.0 foundations;
- later marketplace/cloud work;
- experiments that need evidence;
- ideas that should be dropped.

Do not invent new package names or assume every capability needs its own npm package. Do not treat stale issue comments or prior planning PR language as newer than the user corrections in this packet.

## Latest user intent

1. Forge should ship one easy distribution containing its compatible first-party capabilities. Users should not manage dozens of capability installations.
2. Availability and activation are separate. Unused capabilities must remain inactive/lazy: no watchers, processes, stores, credentials, provider calls, or meaningful startup cost merely because they are included.
3. Each useful capability needs a robust public API and an independently usable consumer path. A component must not depend on another component's private code, database, checkout, configuration globals, or mandatory co-installation.
4. Components integrate through versioned capability contracts and public APIs. Integration/adapter code performs semantic translation. Configuration selects providers, options, routing, and connections; it cannot invent arbitrary API semantics.
5. The user's configuration is their setup. Bare capabilities provide mechanisms and supported options. Forge's TDD/PR workflow is a first-party reference setup, not mandatory product behavior. Other setups can be created, shared, updated, or maintained independently.
6. A future marketplace should allow Forge and community authors to publish and share setups and integrations. Installed operation must not depend on marketplace availability.
7. Setups and executable integrations have different trust boundaries. A setup may change routing or policy despite containing no code; executable integrations can access data and cause effects.
8. Memory and Flow have broad value. The full capability inventory must be accounted for rather than reducing Memory to remember/recall or Flow to execute-one-packet. The user is open to Memory/Flow becoming convenience groupings or bundles, but has not finalized whether their independently published package identity should end.
9. Forge must support returning results, progress, approvals, and continuation context to harnesses through truthful capability tiers. A skill or notification cannot substitute for runtime enforcement.
10. The architecture must accommodate local, headless, remote, and eventual cloud operation through the same semantics. A hosted multi-tenant service is not automatically a 0.1.0 requirement.
11. Future first-party integrations are unknown. The architecture must permit adding them without editing every consumer. A harness-only extension with no useful Forge integration value can remain in the harness's native plugin system.

## Corrections that override stale plans

- Keep the one-way Beads importer. Remove live Beads backend, authority, export, and synchronization behavior. Kernel-native backup/restore is separate.
- `@forge/contracts` remains independent and non-authoritative. It supplies formats, validation, hashing, identity, compatibility fixtures and schemas; it does not authorize, schedule, store credentials, or mutate durable state.
- Memory/Kernel remains the durable authority verifier/writer. Memory must accept authorized, contract-valid receipts from humans, agents, Companion, CI, or other runtimes. Flow produces receipts only for its own execution path.
- Agent Companion remains an independent downstream execution component connected through contracts. Its package name and inclusion in Forge 0.1.0 are unresolved. Do not merge its implementation into Memory or Flow.
- Supported Claude, Codex, Cursor, and Hermes adapter commitments need real implementation/certification. `UNAVAILABLE` cannot replace a promised adapter. OpenCode, Pi, and DSH need explicit release disposition.
- No implementation or new PR is authorized by this discussion. Earlier PR #564 was created prematurely and its scope is not authoritative.

## Current implementation seams that support the direction

All paths below are on tracked `origin/master`.

| Seam | Evidence | Implication |
| --- | --- | --- |
| Independent Contracts package | `packages/contracts/package.json:2`, `packages/contracts/index.js:3` | Already independently distributable and neutral |
| One root distribution composes first-party packages | `package.json:2`, `package.json:119` | One-install direction need not start from scratch |
| Memory authority-provider seam | `packages/memory/src/authority-provider.js:3`, `:25` | Authority implementation can be injected, but default assembly is absent |
| Memory backend registry | `packages/memory/src/backend-registry.js:3`, `:79` | Local reliability floor plus optional providers already exists |
| Feedback and usage evidence APIs | `packages/memory/src/feedback-intake.js:151`; `packages/memory/src/usage-evidence.js:184` | Some broad Memory capabilities are already independently callable |
| Flow execution-provider injection | `packages/flow/src/executor.js:217` | Provider replacement is already a native seam |
| Flow monitor runtime | `packages/flow/src/monitor-runtime.js:1`, `:204`, `:421` | Provider-neutral monitor/reducer primitive is separable from Memory |
| Process and skill runtimes | `packages/flow/src/process-lifecycle.js:180`; `packages/flow/src/skill-runtime.js:60` | Lifecycle, cancellation, bounded handlers and capability checks are logical modules already |
| Facade ownership design | `docs/work/2026-08-09-forge-product-restructure/facade-routing.md:6` | Intended CLI is a router, not another authority/storage owner |
| Companion public direction | external `agent-companion/src/protocol.mjs`, `src/adapters/index.mjs`, `docs/adapter-contract.md` | Can remain a downstream provider; current external baseline is not re-certified in this pass |
| Provider/extension registry issues recorded done | `forge-2agy.6`, `forge-2agy.6.4` | Existing manifest/lazy-skill mechanisms should be inspected and reused before another plugin framework |

## Capability inventory

The bounded inventory identified 12 Memory and 12 Flow families. Status varies among exported, public seam with private/root assembly, root-only implementation, and planned-only semantics.

### Memory families

1. Authority provider.
2. Work items, dependencies, claims, leases, stages, and gates.
3. Generic authorization and multi-source receipt acceptance.
4. Recall, capture, search, digest, and enrichment providers.
5. Provenance and typed knowledge.
6. Knowledge lifecycle: retention, supersession, forget/redaction, context assembly.
7. Monitor-event durability, cursors, outbox, delivery and terminal state.
8. Consent-aware feedback intake.
9. Feedback triage and derived insights.
10. Usage/evaluation evidence.
11. PR lifecycle authority.
12. Migration, native backup/restore, and rebuildable external projections.

### Flow families

1. WorkPacket execution.
2. Flow execution receipt production.
3. Bounded execution loops.
4. Skill/step execution.
5. Process lifecycle, timeout, cancellation, and cleanup.
6. Monitor reduction and terminal receipts.
7. Monitor durability bridge.
8. Efficiency/budget supervision.
9. Workflow composition and optional presets.
10. Harness execution and result/progress/continuation delivery.
11. Git, CI, deployment, and credential-context integrations.
12. PR review, merge execution, Shepherd, and typed handoff.

Detailed source map: `C:\Users\harsha_befach\Downloads\forge-planning-review\capability-extraction-map.md`.

## Highest current coupling gaps

1. No proved capability activation/lazy-loading plane for the root distribution. `bin/forge.js:29` eagerly wires broad root modules; the command registry is static. Existing provider/lazy-skill registry mechanisms may cover part of this, but current useful behavior has not been proved inactive when unused.
2. Memory exposes provider pieces without a complete supported standalone local assembly. The local broker/retrieval assembly remains in root code. Existing issue: `12d92893…`.
3. Flow exposes injected execution without a complete supported standalone runner. Existing issue: `1ff3d2f9…`.
4. PR-specific receipt trust is hard-coded to Flow in `packages/memory/src/pr-lifecycle-authority.js:492`. Generic authorized multi-source receipt acceptance is not a proven public path.
5. Six fixed Forge workflow profiles remain in `lib/workflow-profiles.js`; setup wiring is incomplete. These opinions must become an optional reference setup without weakening authorization or evidence semantics.
6. Cloud/team authority is designed but not implemented as a working provider. `lib/sync-backend.js` implements local behavior while server and Git JSONL modes report unimplemented. Local broker/schema paths and artifact reads are not portable identities.
7. A public export is sometimes only a constructor requiring caller-supplied private-like assembly. Independent import smoke is not a useful product journey.
8. The existing release/backlog plan contains conflicting package assumptions. A restructuring epic expects Memory/Flow products while another open issue describes two published packages; neither settles the newer one-distribution direction.

## Proposed logical boundaries from the research lanes

These are candidates, not selected package names:

1. Contracts and conformance.
2. Authority runtime: work, claims/leases, gates/stages/events, generic receipt acceptance, projections. Keep transactional invariants together.
3. Knowledge/evidence runtime: canonical knowledge, provenance, lifecycle, local retrieval; enrichment providers replaceable.
4. Execution runtime: packets, runners, bounded loops, skill steps, scheduling, Flow-owned receipts.
5. Process/monitor runtime: process control, cancellation, cleanup, monitor reduction, delivery attempts; durable acknowledgment stays behind one store contract.
6. Domain integrations: Git/CI/review/merge/deployment and typed handoff, each behind narrow effect APIs.
7. Identity/credential contexts: GitHub multi-account and future provider identities, independently consumable.
8. Optional aggregate bundles and setup presets.

Important distinction: logical capability API, selectable implementation, and separately published package are different decisions. The 24-family inventory should not automatically become 24 packages. A package boundary needs an independent lifecycle, useful consumer, dependency/isolation benefit, and compatibility ownership.

## Configuration and composition model

The simplest current proposal is:

```text
First-party capabilities included in one Forge distribution
          |
Public APIs + versioned capability contracts
          |
Integration implementation
  - direct compatible API
  - constrained declarative mapping when a shared executor fully represents it
  - coded adapter for semantic/lifecycle differences
          |
User-owned configuration selects implementation, options and connections
          |
Direct application call, or Flow when multi-step orchestration is needed
          |
Typed result/evidence -> selected durable service and harness delivery adapter
```

Configuration is not a programming language and cannot create authentication, semantic mapping, retries, idempotency, cancellation, isolation, or compensation. Those require executable implementations and evidence. Do not create another universal controller unless concrete coordinated lifecycle needs exceed existing registries and Flow primitives.

The first-party Forge workflow is the reference setup. It should use the same public APIs available to outside authors and demonstrate a meaningful procedure/provider/workflow replacement without core edits. Bare capability users do not inherit the TDD/PR ladder.

## Prior-art mechanisms to adapt

- n8n: constrained declarative integration authoring for simple REST operations; programmatic implementation for triggers/non-REST/complex transformations; selected workflow behavior remains pinned across node updates. Official docs checked 2026-09-15.
- Kestra: separate orchestration descriptors from runnable tasks; plugins supply capabilities and workflows compose them; defaults differ from enforced policies; same contract can support combined or distributed placement; large outputs stay outside compact execution state.
- DSH/Cordis: typed provides/requires seams, owner-bound disposal, transactional activation, deterministic overlays, scoped lifecycles, bounded draining, and durable facts separate from live progress. Do not adopt Cordis as a mandatory runtime.
- Skills research: qualified provenance, explicit invocation boundaries, collision diagnostics, progressive disclosure, and atomic projections. Skills describe procedures; they do not create transport, permission, or authority.
- Memory-provider research: local FTS5/canonical records remain reliable authority; optional Graphify/Graphiti/OpenViking/Mem0 mechanisms remain projections or experiments that must prove value.

Detailed primary-source comparison: `C:\Users\harsha_befach\Downloads\forge-planning-review\n8n-kestra-architecture-comparison.md`.

## Harness return path

Saved product design specifies Flow `MonitorSpec`, Memory-persisted sequenced `MonitorEvent`, facade/harness `DeliveryReceipt`, and terminal `MonitorReceipt`, with persistence preceding at-least-once delivery. Physical storage/acknowledgment details remain unresolved.

T0-T4 capability tiers are: durable pull, next-turn injection, active-session delivery, resume/wake, and human notification. T0 is the baseline for supported monitor targets; higher tiers require executable proof. The tiers are distinct capabilities, not substitutes for required cancellation, approval, or cleanup enforcement. A delivered approval request does not grant approval.

Compatibility policy proposed by research:

- reject malformed/incompatible contracts and missing required authority/permission/approval behavior;
- warn and explicitly fall back only for optional delivery behavior;
- bind capability evidence to executable identity, harness version, probe revision, and digest;
- revalidate affected routes on config/provider/harness change;
- never promise detection of arbitrary third-party semantics or model obedience.

## Security boundary

1. Setup files are untrusted proposals. Validate and preview their effective changes. They request capabilities; they cannot grant themselves permissions or change core integrity invariants.
2. Executable extensions cross a stronger trust boundary. Author manifests remain separate from host-issued, digest-bound grants. A separate process is not automatically a sandbox.
3. Consequential requests bind project/repository, actor, scope, operation, run/attempt, authority revision, expiry, and relevant head/lease. Generic capabilities must not become confused deputies.
4. Configuration and packets carry secret references, never values. Preserve separate Forge authority identity, GitHub API identity, Git transport, and commit authorship. Cloud needs tenant/project isolation.
5. Marketplace/update provenance identifies source, publisher, exact version/digest, contract/capability versions, requested grants, and selected lock. Provenance does not prove code is safe.
6. Security invariants remain non-configurable: sole authority writer, receipt/lease/head validation, secret exclusion, project/tenant isolation, and required enforcement.

Recommended distribution progression from the research: first prove versioned setup packages/catalog entries and offline use. Treat community executable integrations as a separate admission path. A full hosted marketplace service, automatic updates, and broad untrusted execution are later unless explicit release value outweighs the security/operation cost.

## Current targeted backlog map

| Lane | Issue | Current status / role |
| --- | --- | --- |
| Product boundary | `d6a74dc8…` | In progress P0; older independent Memory/Flow product assumption needs reconciliation |
| Contracts | `4d41ffb7…` | Done P0; reuse independent contracts |
| Memory default assembly | `12d92893…` | Open P0; proposed 0.1 foundation |
| Flow default runner | `1ff3d2f9…` | Open P0; proposed 0.1 foundation |
| Facade/capabilities | `5f4da13f…` | Open P0; thin facade, probes, Doctor, freedom envelopes |
| Claim reconciliation | `9e31a2f0…` | Open P1; must settle before migration |
| Migration/extraction | `f2a96ff1…` | Open P0 blocked by four foundations |
| Release evidence | `eb2f1753…` | Open P0 blocked by migration plus hook/MCP control work |
| Memory adapter registry | `5037a7da…` | Done P0; reuse rather than rebuild |
| Provider capability contracts | `forge-2agy.6` | Done P1; inspect implementation before another plugin system |
| On-demand skills | `forge-2agy.6.4` | Done P1; reuse |
| Hook controls | `7268bc9b…` | Open P1; required for release convergence |
| MCP control/drift | `9658c21a…` | Open P1; required for release convergence |
| Harness architecture | `44ed41f0…` | Open P1; broad parent, not all automatically 0.1 |
| Actor and run/receipt authority | `7b60525b…` -> `85be2945…` | Open dependency chain for package-neutral external execution semantics |
| Companion bridge | `8d14651d…` | Open P1 with five prerequisites; inclusion unresolved |
| Skill registry/collisions | `da760874…` | Open P0 with broad dependencies; minimum setup safety may need scoped child |
| Runtime package completeness | `95372af8…` | In progress P0; overlaps one complete distribution and packed-install proof |
| Two-package decision | `bfb2f529…` | Open P2; conflicts with newer distribution discussion and is not settled authority |

Missing canonical issue coverage:

- one-distribution versus separate Memory/Flow release identity;
- marketplace separation between setup artifacts and executable integrations;
- harness compatibility-warning payload/behavior;
- Companion inclusion/timing;
- exact lazy capability activation acceptance.

Do not file or mutate these issues during the review; identify the decisions and recommended consolidation first.

## Normative release evidence already approved in tracked design

The existing `docs/work/2026-08-09-forge-product-restructure/validation-matrix.md` requires G0-G8 evidence, Ubuntu/macOS/Windows, Node 22/24, Memory-only/Flow-stateless/Flow-connected/facade modes, Claude/Codex/Cursor/Hermes projections, beta.5 migration and recovery, contract compatibility, authority/security, monitor delivery/cleanup, continuation after session loss, capability probes, artifact integrity/provenance/OIDC/dist-tags, and an exact-head merge train. It also records 10 beta.6 synthetic journeys, 25 beta.7 canary journey/environment pairs plus 72 hours, and 50 RC pairs plus seven cumulative automated observation days.

These requirements are source-level normative design, not proof that they are implemented or still accepted unchanged after this architecture revision. Astra should recommend which remain essential, which need reinterpretation, and which should be explicitly reopened rather than silently discarded.

## Questions Astra must answer

1. What is Forge's actual product value: contracts alone, a capability platform/control plane, a reference workflow, or a combination? State the user-facing product in one paragraph.
2. Should Forge distribute one complete first-party bundle while preserving `@forge/memory`, `@forge/flow`, and `@forge/contracts` as independently consumable APIs/packages, or end some of those published package identities? Explain the compatibility and maintenance trade-off.
3. What is the minimal runtime architecture and data flow? Name owners for authority, configuration, orchestration, adapter translation, execution, delivery, and evidence.
4. Which of the 24 capability families should be stable public capability surfaces, internal modules, optional setups, or separately published integrations? Use coherent groups; do not create a schema/package zoo.
5. How should user setup/configuration work without becoming another programming language or policy authority? Distinguish bare defaults, user choices, setup packages, and non-configurable invariants.
6. What should the initial extension/marketplace model include? Separate data-only setups and executable integrations, trust/admission/update behavior, and offline operation.
7. How should the harness return path and compatibility checks behave, including required rejection versus optional warning/fallback?
8. What must be in 0.1.0, what should come later, and what should be dropped? Reconcile the current issue lanes and avoid promising a cloud service or marketplace before the core is credible.
9. What parallel PR lanes and contract-freeze checkpoints minimize semantic and merge conflicts?
10. Give 8-12 falsifiable acceptance journeys that would prove or disprove the recommended architecture before broad extraction.

Output requested from Astra:

- conclusion first;
- concrete architecture and responsibility table;
- decisions with rationale and explicit rejected alternatives;
- 0.1/later/drop classification;
- dependency-ordered parallel delivery plan;
- top risks and decisive acceptance tests;
- call out any premise in this packet that should be rejected.

Keep the answer reviewable and direct. This is architecture guidance; do not edit code, files, issues, or PRs.
