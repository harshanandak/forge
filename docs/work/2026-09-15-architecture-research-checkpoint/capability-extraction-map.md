# Memory and Flow: full capability extraction inventory

Decisions needed: public API shapes, setup/runtime ownership for higher-level behavior, and release disposition remain under discussion.

This is a local planning artifact, not a new implementation plan or PR. Sol researched the tracked package trees, public exports, root implementation locations and saved ownership design; main analysis reconciled the findings with the user's API-first, optional-setup and cloud requirements.

Evidence baseline: `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`. Findings are rung 2, source inspection. No capability in this table is newly runtime-certified. The inventory covers capability families, not every internal helper or every unfinished issue.

## Extraction objective

Expose the useful breadth of Memory and Flow through stable public operations and extension contracts so outside developers can build their own applications, workflows and integrations. Basic remember/recall and execute-packet journeys are necessary smoke checks, not complete product-extraction proof.

Account for every existing supported capability. Each needs an explicit destination: its owning product API, an independently consumable capability plugin, an optional setup/workflow composition, or a private implementation behind a public operation. Keep planned-only work distinguishable from implemented behavior awaiting extraction.

Public does not mean every helper is exported. Callers should not need direct database access, internal brokers, a Forge checkout or private command modules. Components depend on the public capability they consume; integration code selects providers. Independently installed defaults should serve the intended public journey, while explicit provider injection remains supported.

Status vocabulary:

- **Exported:** visible at a public entry point. This is source evidence, not proof of useful standalone behavior.
- **Split:** a public interface exists, but default or concrete assembly remains in root code.
- **Root:** implementation exists outside the product package.
- **Planned / mixed:** ownership or intended semantics are documented; a general public implementation or complete coverage was not established by this audit.

## Memory capability families

| Family | Current evidence | Outside consumer value | Extraction boundary / remaining work |
| --- | --- | --- | --- |
| Authority provider | **Split.** `packages/memory/src/authority-provider.js:3` and `:37`; concrete broker in `lib/kernel/broker.js:1948` | A custom application or orchestration service can use the same accepted state transitions | Publish stable authority operations and a supported local assembly. Keep broker, database and schema internals private |
| Work items, dependencies, claims, leases, stages and gates | **Split.** Coarse provider operations plus `lib/kernel/*` and `lib/commands/_issue.js`; ownership in product restructure `plan.md:133` | Build a different work UI or scheduler while retaining authoritative ownership and decisions | Specify typed public operations or command envelopes; avoid exposing database mutations or requiring the Forge CLI parser |
| Generic work authorization and external receipt acceptance | **Planned gap.** Current acceptance at `packages/memory/src/pr-lifecycle-authority.js:821` is PR-specific; independent receipt requirement in product restructure `plan.md:144` | Connect human actions, a custom executor, Companion, CI or a cloud worker directly to Memory | Separate generic authorization/acceptance from PR-specific bindings. Verify any authorized conforming producer; Flow cannot be the only producer |
| Recall, capture, search, digest and enrichment | **Split.** `packages/memory/src/backend-registry.js:3`, `:79`; root local assembly at `lib/memory/router.js:430` | Embed memory in another product or add a retrieval/index provider | Ship a supported local assembly and provider contract. Keep the canonical store available when enrichment fails; candidates do not become authority |
| Provenance and typed knowledge | **Root.** `lib/memory/typed-api.js:3` and `:50` | Source-backed knowledge tools, domain-specific recall and audit views | Expose stable semantic operations and source metadata; avoid tying consumers to internal tables or a particular query engine |
| Knowledge lifecycle and hygiene | **Root / mixed.** `lib/memory/hygiene.js`, `lib/project-memory.js`, root commands; ownership in product restructure `plan.md:133` | Retention, supersession, forget/redaction and scoped context in another application | Reconcile implemented versus planned lifecycle semantics individually. Provide public operations without forcing issue/claim/stage adoption |
| Monitor event durability and delivery state | **Split.** `packages/memory/index.js:265` and `:319`; constructor expects a monitor-capable driver | Durable progress and result delivery for another monitor or harness integration | Publish a clear driver/storage boundary and supported local implementation. Preserve cursor, outbox and portable evidence semantics |
| Feedback intake | **Exported interface, default assembly incomplete.** `packages/memory/src/feedback-intake.js:151` and `:237` | Consent-aware feedback collection in another application | Preserve preview, consent, atomic acceptance and idempotency; provide supported durable acceptance rather than requiring private caller assembly |
| Feedback triage and insights | **Root / mixed.** Root triage/insights commands; ownership in product restructure `plan.md:133` | Custom issue-proposal, prioritization or evaluation tools | Separate reusable analysis from optional triage policy. Proposals must not become authorized state changes by implication |
| Usage and evaluation evidence | **Exported.** `packages/memory/src/usage-evidence.js:184`; public re-exports at `packages/memory/index.js:319` | Record and analyse capability usage independently of Flow | Keep authoritative evidence distinct from analytics projections. Prefer stable operations over making schema installation the normal consumer interface |
| PR lifecycle authority | **Exported, domain-specific.** `packages/memory/src/pr-lifecycle-authority.js:821` through the lifecycle operations | An alternative PR executor or UI can retain exact-head, lease and gate checks | Preserve this domain capability without mistaking it for generic receipt acceptance. Execution/provider side effects remain outside Memory authority |
| Migration, backup/restore and external projections | **Root / mixed.** `lib/commands/migrate.js`, `lib/commands/export.js`, `lib/issue-sync/*`, authority-wrapper projection operations; product restructure `plan.md:135` | One-way importers, recovery tools and integrations with external issue systems | Separate inbound import, native backup/restore and rebuildable projections. Keep Beads importer-only; projection failure cannot rewrite accepted authority |

## Flow capability families

| Family | Current evidence | Outside consumer value | Extraction boundary / remaining work |
| --- | --- | --- | --- |
| WorkPacket execution | **Exported.** `packages/flow/index.js:93`; injected runner in `packages/flow/src/executor.js:217` | Run work through a custom local or remote provider | Preserve injection and provide a supported usable runner assembly. No private Memory dependency |
| Execution receipt production | **Exported foundation.** `packages/flow/index.js:39` | Obtain contract-bound evidence for Flow's own execution path | A receipt skeleton is not executed evidence. Other runtimes produce their own authorized conforming receipts rather than pretending to be Flow |
| Bounded execution loops | **Exported.** `packages/flow/index.js:15` and `:93` | Custom bounded retry, polling or agent loops | Expose time/budget/terminal behavior without imposing Forge's development stages |
| Skill/step execution | **Exported.** `packages/flow/index.js:12`; `packages/flow/src/skill-runtime.js:60` | Execute custom procedures with injected handlers and limits | Keep procedures distinct from enforcement; connect metadata, permissions, provenance and projection through explicit contracts |
| Process lifecycle | **Exported.** `packages/flow/index.js:20` and `:93` | Custom tool/harness runners with timeout, cancellation and cleanup | Keep OS/process providers replaceable and results truthful. Process success does not itself authorize durable state changes |
| Monitor reduction and terminal receipts | **Exported.** `packages/flow/index.js:5` and `:93` | Observe CI, deployments, queues or arbitrary external jobs | Keep the monitor provider-neutral. Shepherd is a consumer of monitoring, not its required use case |
| Monitor durability bridge | **Exported interface.** `packages/flow/src/monitor-durability.js:320`; `packages/flow/index.js:26` | Connect monitors to a selected durable service | Preserve the distinction between transient monitoring/delivery attempts and authoritative persisted evidence; avoid requiring Memory's private storage |
| Efficiency and budget supervision | **Exported.** `packages/flow/src/efficiency-supervisor.js:10`; `packages/flow/index.js:12` | Deterministic budget and replan controls in another execution product | Separate supported budget mechanism from opinionated preset thresholds; retain observable decisions and outcomes |
| Workflow composition and presets | **Root, fixed Forge assumptions.** `lib/workflow-profiles.js:1`; root plan/dev/validate/ship commands | Build workflows that do not follow Forge's development ladder | Separate reusable step/transition/gate behavior from optional Forge setup profiles. Audit generic composition coverage before selecting new public API shapes |
| Harness execution and return delivery | **Root / mixed.** Product restructure `plan.md:150` and `:423`; public lower-level primitives plus root/facade adapter work | Add a harness or a new delivery consumer without rewriting workflow policy | Versioned adapter capabilities and conformance; connected monitoring retains T0 pull, while additional return/resume/control behavior needs executable proof |
| Git, CI and deployment integrations | **Root.** `lib/commands/push.js`, `lib/commands/test.js`, provider-specific modules; ownership in product restructure `plan.md:150` | Substitute source-control, validation, CI or deployment providers | Extract narrow capability/effect APIs and independently usable adapters. GitHub credential context is its own provider, not a harness execution interface |
| PR review, merge, Shepherd and handoff | **Root despite exported primitives.** `lib/pr-monitor/*`, `lib/commands/shepherd.js`, `lib/commands/merge.js`, review adapters; product restructure `plan.md:157` | Alternate review bots/UIs or domain-specific orchestration over the same reusable mechanisms | Separate provider-neutral review/execution from the optional end-to-end workflow. Memory retains authorization; handoff carries typed evidence and continuation |

## Further decomposition proposal: capabilities first, Memory and Flow as optional bundles

The user proposed decomposing Memory and Flow themselves into smaller capabilities that can be selected and connected through configuration. This is a useful direction to evaluate. It changes the planning unit from the two package names to the capability graph. Memory and Flow may remain convenient supported bundles or public aggregate entry points over those capabilities; this is not yet an approved package restructuring.

Keep three decisions separate:

1. **Logical capability:** has a documented API, meaningful independent use case and explicit dependencies.
2. **Replaceable/configurable implementation:** supports provider selection or exposed behavior options with conformance checks.
3. **Separately published package:** needs its own installation, dependency footprint, versioning, ownership or isolation boundary.

The first two do not automatically require the third. Do not convert the 24 inventory rows into 24 npm packages by default, or keep them inseparable merely because they currently share a package name. A helper with no independent consumer is not a product capability just because it can be moved into another file.

The following behavior areas are candidates for public modular boundaries, not prescribed package names or a final package count:

| Candidate area | Inventory coverage / useful public seams | Boundary to retain |
| --- | --- | --- |
| Authority operations | Work/dependencies, claims/leases, stages/gates, guarded events, generic and PR-specific authorization/receipt acceptance, native recovery and projection operations | Distinct public operations may share one authoritative implementation. Do not split a state transition into independently committing services connected only by configuration |
| Knowledge and retrieval | Recall/capture/search/digest, typed provenance, context selection, retention/supersession/forget; selectable enrichment providers | Canonical records and their lifecycle stay consistent; index/provider selection cannot bypass deletion, scope or provenance checks |
| Feedback and usage evidence | Consent-aware intake, usage evidence, triage and derived insights | Reusable analysis/policy modules can be optional; accepted evidence and authorized mutations still use the owning public store/authority API |
| Execution and workflow primitives | Packet execution, receipts for its execution, bounded loops, skill/step handlers, efficiency controls and generic composition | Provide mechanism without the mandatory Forge stage ladder; runners and handlers can be selected independently where their contracts support it |
| Process control | Spawn/control, timeouts, cancellation and cleanup evidence | Process/provider implementation must enforce actual supported controls; configuration cannot manufacture cancellation or sandboxing |
| Monitoring and delivery | Monitor reduction, durability bridge, progress/result delivery, cursors/outbox and terminal receipts | Transient reducers and delivery adapters can vary. Durable events, acknowledgement and terminal state need a consistent store contract; this area need not become one package spanning both products |
| Domain integrations | Source control, CI, review, Shepherd, merge execution, deployment and handoff | Each integration can expose a narrow API or composition. Review/merge side effects do not acquire authority to approve themselves |
| Identity and credential context | GitHub multi-account selection and future provider identity integrations | Independently consumable and distinct from workflow, harness execution, API identity, Git authorship and transport choices |

Contracts/conformance remain the shared interoperability foundation. Optional setup packages and the Memory/Flow bundles select useful combinations; they are not another authority or orchestration engine. These categories do not claim that every mechanism is currently generic, public or independently releasable—the inventory above records the source evidence.

Three constraints bound configuration-driven composition:

- **Translation needs implementation.** Different authentication, identity, error, retry and side-effect semantics need adapter code, even when configuration chooses that adapter.
- **Atomicity needs an owner.** Fencing, conflict detection, stale-receipt rejection and durable acknowledgement require coordinated implementation, not a sequence of unrelated configuration-selected writes.
- **Runtime guarantees need enforcement.** Isolation, cancellation, cleanup and external-effect compensation cannot be guaranteed by a manifest or skill alone.

A configuration change can select a different conforming implementation of an entire boundary. It cannot dissolve the boundary's invariants. Separate public APIs or packages are possible where they call the same authoritative service; separate conflicting writers are not the goal.

Acceptance for a proposed split should show that an outside consumer can use the capability without the rest of its bundle, that a compatible implementation can be substituted where advertised, and that unrelated optional capabilities stay unloaded/unactivated. It must also show what dependency remains required and why. Reuse canonical owner tests and add consumer wiring proof rather than duplicating every internal test in every module.

The next change-impact matrix should therefore assign each family a proposed module/API owner, optional bundle membership, explicit dependencies and transactional boundary before selecting physical package splits or PRs. This preserves the user's finer customization goal while making installation and update costs reviewable.

## What this changes in the implementation plan

1. **Memory needs broader public assemblies and semantic APIs.** The package boundary cannot be considered complete while normal consumers must supply private root brokers, local retrieval assembly or workflow-specific authorization to reach basic capabilities.
2. **Flow needs both reusable primitives and separable higher-level capabilities.** Public reducers and injected execution are useful foundations. Workflow, review and integration extraction must preserve that breadth without moving Forge's fixed presets into generic core.
3. **Setup extraction is cross-cutting.** Threshold recommendations, role/stage mappings and default workflow choices belong in optional setups where they represent opinionated policy. Validation and runtime mechanisms remain with their actual capability owners.
   The user selected Forge's existing workflow as the basis for a first-party reference setup: a useful runnable example of these public capabilities that others can adapt. It must use the same supported APIs as outside consumers, with documented examples of provider/step changes and independently maintained derivatives.
4. **Domain integrations need explicit ownership.** Existing plans assigning Git/CI/review to Flow record their current product ownership; they do not require embedding every provider implementation permanently into Flow. The user's newer independent-plugin model requires an extraction decision for each.
5. **Public exposure needs conformance, not just exports.** Each family needs a realistic independent consumer and failure case at the boundary. Reuse canonical owner tests; consumer journeys prove wiring rather than duplicating the whole internal test suite.
6. **Cloud is an API constraint throughout.** Identify local-only drivers/runners, transport expectations, artifact references and process assumptions. A local implementation is valid; a local path or process-global object must not be the only possible cross-component identity.

## Use the reference setup to distinguish choices from guarantees

The user identified an additional value of the reference workflow: it reveals what is tweakable and what is standard. Every capability's public design should make that distinction explicit.

| Classification | Meaning | Example / design check |
| --- | --- | --- |
| Standard contract | Consumers can depend on the published inputs/results, errors, identity, authorization and compatibility semantics | A setup cannot silently redefine successful completion or reinterpret a receipt. Changes to these guarantees require the contract/version process |
| Configurable choice | The capability explicitly accepts a user's selection within its supported semantics | Provider binding, workflow structure, skill choice, routing, exposed budgets and policy options; changing them must not require editing core source |
| New implementation | The desired behavior exceeds exposed configuration but can implement a supported extension contract | A new execution adapter, review procedure or retrieval capability; write and test that extension instead of inventing an unsupported configuration option |
| Private detail | An implementation choice has no independent consumer use case | Keep internal table layouts and helper algorithms private instead of presenting them as settings |

Policy choices and policy enforcement are separate: users may configure the supported policy, while the operation still enforces the selected policy and its published authorization semantics. Similarly, a different workflow may select different validation steps; it cannot label an unperformed check as passed.

Apply the classification to the existing Forge reference and a distinct custom setup. If changing review style or provider selection requires a core edit, examine whether an opinion is still embedded in the wrong layer. If a setting changes the meaning of a result contract, examine whether a guarantee was mistakenly made configurable. This is a concrete architecture check, not a reason to create knobs for every internal detail.

## Required distinctions before writing the PR plan

- **Implemented but root-bound** needs extraction and compatibility preservation; do not estimate it as a fresh feature or assume it is merely a file move.
- **Exported but unusable without private assembly** needs a supported assembly and consumer proof; do not label intentional injection itself a defect.
- **Planned only** needs implementation scope and product justification; do not call it extracted merely because a manifest names it.
- **Opinionated workflow/setup** should be independently distributable over the capabilities it uses; moving it into an optional package must preserve user-visible behavior for adopters.
- **Private mechanism** can remain private if all supported external use cases are covered through stable operations. Broad API coverage is not permission to publish raw tables or internal classes.

The full change-impact matrix still needs exact file ownership, existing issue links, dependencies and proposed release dispositions for these families. This inventory is the input to that work. It does not complete the full unfinished-backlog review, approve a new release sequence or authorize implementation.

## Coverage and proof limits

Sol inspected both product package trees and public exports, their provider/store boundaries, root implementation locations, saved product ownership, and the fixed workflow-profile seam. The audit did not enumerate every root helper or establish that no undocumented alternative entry point exists. Source absence is not asserted as a universal fact.

The saved architecture archive (`docs/work/2026-08-24-agent-harness-architecture/README.md:42` and `:102`) reports earlier package-install/focused-test evidence while useful standalone journeys remained incomplete and connected authorization/execution/acceptance was not run. That is historical context, not a new test result. Fresh packed-artifact and connected-consumer evidence remains necessary.
