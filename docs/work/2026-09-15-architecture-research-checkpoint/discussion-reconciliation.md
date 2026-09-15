# Forge 0.1.0: package, customization, composition, and cloud reconciliation

The independent Astra review and main-agent recommendation are saved in [astra-architecture-guidance.md](astra-architecture-guidance.md). That shorter document is the proposed planning baseline; this file remains the longer discussion/research record.

Decisions needed: release scope remains provisional. This is a local discussion draft, not an approved implementation plan.

Prepared 2026-09-14. No PR, Kernel issue disposition, or release commitment is changed by this document. It consolidates the current discussion so the useful research and remaining gaps are not lost.

## The intended outcome

Yes: independently usable packages, customization without editing Forge source, composition through supported contracts, and eventual cloud operation can fit one architecture. They need to be designed together. Extracting directories into packages alone does not deliver these outcomes.

The smallest coherent approach is to finish the existing public boundaries, ship useful default assemblies, and prove those assemblies with independent consumers. Configuration selects implementations; contracts carry work and evidence; an authority service validates durable state changes. The location of execution must not change those semantics.

Cloud compatibility belongs in the design now. A production hosted service is a separate delivery commitment; it adds operation, authentication, tenancy, deployment, recovery, and capacity work that package extraction alone does not provide.

## Current simplifying proposal: capabilities are the product; setup is the user's choice

The user's n8n/Kestra comparison is analysed in [n8n-kestra-architecture-comparison.md](n8n-kestra-architecture-comparison.md), using current official documentation. It sharpens integration authoring (declarative mappings where supported, coded adapters otherwise), versioned behavior for existing setups, and local/remote execution boundaries. These are mechanisms to reconcile with Forge's existing implementation, not dependencies or a proposal to clone either product.

The latest discussion sharpens the model: packages provide bare capabilities and supported customization APIs. The user's configuration is their setup—what to enable, disable, select, connect and route. It is not a separate product or an additional mandatory control layer. A first-party or marketplace setup is a convenient way to supply those choices, not their permanent owner.

The smallest proposed architecture is:

```text
Independent packages expose public capabilities
                     |
        versioned capability contracts
                     |
    direct compatible APIs, or small adapters
                     |
User setup selects providers, options and connections
                     |
       application, service or harness consumer
```

This diagram describes responsibilities, not a requirement that every call traverse a central Forge service. If a package already implements the required public contract, call it directly. Introduce an adapter only where translation is needed. A harness adapter is one consumer/integration route; ordinary API consumers do not need a harness or its plugin loader.

| Supplied by the ecosystem | Chosen by the user |
| --- | --- |
| Stable public operations and supported configuration options | Which capabilities to use and their option values |
| Capability contracts and compatibility/conformance checks | Which compatible implementation to bind and where to route it |
| Adapters for API and host differences | Which integrations to enable or disable |
| Optional reusable workflow/setup packages | Adopt a supplied workflow, customize it or build another |
| Diagnostic and safe-apply mechanisms | When to accept configuration and package updates |

Package-specific customization stays with that package's published API/schema. Shared configuration carries selections and bindings without reimplementing every package's settings. Changes to configuration must be interpreted through the selected capability's documented semantics; an arbitrary setting cannot create a feature the implementation does not support.

Configuration can bind compatible APIs and supply declared options. It cannot reliably invent semantic translation, authentication behavior, error handling or cancellation for arbitrary APIs. An integration author implements that adapter once, proves its conformance and supplies an example. Setup authors can then compose it; end users need not write adapter code for an already supported integration.

There is no demonstrated need for a new universal controller or plugin engine at this point. Reuse the existing contracts, public APIs, provider registration/injection and diagnostics where they fit. Move opinionated profiles and generation to optional setup ownership as clarified below; do not preserve them in core merely under the name of configuration resolution.

Memory and Flow are independently valuable capability providers, not mandatory middleware for every extension. A simple integration may call a selected API directly. Use Memory when the application chooses its durable authority/knowledge capabilities; use Flow when it chooses its execution/composition/monitoring capabilities. Other consumers may use the same APIs without adopting the rest of Forge's default composition.

Unknown future integrations should motivate stable extension seams, not speculative abstractions. Reconsider additional coordination machinery only when a concrete accepted use case needs it—for example, recovery or replacement spanning several providers, hosted tenant isolation, or cross-orchestrator continuation. Those needs require explicit implementation and proof; configuration alone does not solve them.

Sol challenged this simpler model using the existing provider registry, Flow exports and saved adoption design. Main analysis retained user ownership of binding/routing choices: Forge supplies the mechanism and compatibility checks, not an automatically imposed workflow or provider policy. This is still a proposal under discussion, not an approved rewrite or a new public package naming decision.

## Explicit user requirement: APIs first, composition as the reason for Forge plugins

The user clarified this after the research reconciliation: components must be truly independent and integrate through their public APIs. Future Forge plugins should create value by using and composing those APIs. A feature that only extends a particular harness can use that harness's native plugin architecture; wrapping it in Forge adds no value by itself.

The architectural rule is dependency on a capability contract, not on another component's identity or private implementation. A component declares the capability it needs. Integration code selects and connects a conforming provider. Explicit supported dependencies on contracts or public client libraries are acceptable; hidden dependencies on another product's installation, database, process, configuration globals or source tree are not.

For example, Flow can consume a public execution-provider contract without special knowledge of Companion. A separate bridge maps that contract to Companion's public API. Replacing Companion then changes the selected provider or bridge, not Flow's workflow engine. The same principle applies to receipt acceptance, retrieval and GitHub account context. Components themselves must also be usable by applications outside Forge.

An API can be an in-process library interface or a remote service interface. Preserve transport-neutral semantics for identity, errors, cancellation, retries and evidence; do not force local consumers through a network service solely to claim independence.

**Plugin value criterion:** a Forge plugin supplies a useful capability to other API consumers, composes existing capabilities into a new outcome, or provides a meaningful Forge integration such as governed execution and evidence. It need not depend on multiple components. Its description should identify the APIs it consumes/provides and the resulting user value. A harness-only feature with no such integration value should remain a native harness plugin.

The public release must make extension possible without reading private implementation code:

- Publish capability-specific APIs and contracts with supported inputs, outputs, errors, lifecycle, permissions and compatibility behavior. Define retry/idempotency, limits, cancellation and progress behavior where the operation needs them.
- Keep contract versions distinct from provider implementation versions. Reject incompatible requirements clearly and document breaking changes and migration paths.
- Provide standalone examples, a custom-provider example and executable conformance fixtures. Prove replacement with an independently implemented provider, not only two wrappers around shared internals.
- Test consumers against public packages/APIs with sibling source trees and private storage unavailable. Direct database reads/writes are not an integration shortcut.
- Prove that installing or removing an unrelated optional plugin does not change a component's behavior. Configuration and integration code own explicit activation and provider selection.
- Preserve enforceable authority and security rules across every implementation and transport. Extensibility cannot depend on trusting plugin claims of successful authorization or completion.

The release objective is a clear, robust, versioned API foundation that external contributors can build on. The protocol's usefulness and compatibility need proof before any claim that it is an industry standard. This requirement sharpens the existing package/customization/composition journeys; it does not authorize a new implementation PR or settle the remaining release scope.

## Latest boundary clarification: minimal products and optional setup plugins

The user clarified that maintained settings, profiles and opinionated setup belong in optional setup plugins. The bare product should not depend on those presets. Users can supply, configure and update their own choices through the public API/configuration surface. This supersedes any interpretation of this draft that makes Forge's recommended profile system part of mandatory product behavior.

| Bare product responsibility | Optional setup plugin responsibility | User ownership |
| --- | --- | --- |
| Public APIs, input validation and supported capability contracts | Recommended workflow profiles, role/skill mappings and provider selections | Choose a supplied setup, a third-party setup or explicit manual configuration |
| Execute explicit valid inputs/configuration and report missing required capabilities | Generate or apply configuration through supported APIs | Inspect and edit configuration without keeping the setup plugin installed |
| Enforce the configured authorization boundary and invariant data/contract integrity rules | Offer policy presets and explain their consequences | Select policy within supported semantics; preset choice does not redefine what validation or authorization means |
| Report effective runtime state and actionable compatibility errors | Guided onboarding, profile selection and optional upgrade assistance | Decide when a setup update is applied and preserve local customizations |

Profiles are packaged choices, not a required runtime dependency. A generic configuration mechanism may remain where runtime consumers actually require it; preset catalogs, profile inheritance and generation logic should live in the setup plugin when only setup needs them. Do not preserve a profile framework in core merely because it already exists.

Distinguish configuring a capability from installing its implementation. Removing a setup plugin must not remove a runtime provider the user still needs, and a setup plugin must not be required on the execution path after it has produced valid configuration. Declare separately any runtime plugins a setup recommends; activate them only through explicit selection.

Bare does not mean unusable: a user must be able to call the documented APIs with explicit inputs and selected providers. Deterministic operational behavior and input validation remain part of those APIs. It means no mandatory Forge workflow, profile catalog, agent role preset or silent policy activation.

Setup updates should show the proposed changes and their ownership, preserve user-edited values, and surface conflicts rather than overwrite them silently. Removing the setup plugin should leave user configuration and data intact unless the user explicitly asks to remove them. Exact merge/update mechanics still need design; do not assume a new configuration state store is necessary.

Acceptance additions for discussion:

1. Install and use each bare product through public APIs without a setup plugin, profile catalog, generated harness files or mandatory workflow.
2. Apply an optional setup plugin, inspect its proposed configuration, and observe only explicitly selected activation.
3. Perform the same configuration manually with the same runtime result; generated files are not a privileged authority path.
4. Change a generated setting, then update/reapply setup without silently losing the user's change.
5. Remove the setup plugin and continue using the configured product and independently installed runtime providers.

This changes the ownership proposed for existing adoption/workflow profiles, role bindings, configuration generation and onboarding. Reuse useful implementation during extraction, but map these surfaces to setup versus runtime before assigning PR ownership. No extraction or release-scope decision is implemented by this clarification.

## Product direction: portable integration architecture and a marketplace of setups

The user further clarified the intended offering: Forge provides the architecture that connects independent components to harnesses; a marketplace can offer multiple opinionated setups on that architecture. Shared configuration and API contracts make those choices portable. This is a product direction from the discussion; a marketplace service and its release date have not been approved for implementation.

The three layers are:

1. **Integration foundation:** independent component APIs, versioned contracts, capability/configuration validation, and adapters for supported harness behavior. Components remain useful without installing the whole Forge composition.
2. **Installable setups and capability plugins:** workflows, role/skill selections and recommended configuration, plus separately declared runtime providers where needed. Forge's own opinionated setup is one choice, not privileged behavior built into the bare products.
3. **Marketplace/distribution:** discover and distribute alternative setups and plugins with declared requirements, versions and compatibility evidence. This distributes existing capabilities and compositions; it must not become a required online service for running an installed setup.

Universal configuration means shared semantics for intent, required capabilities, provider bindings and policy, with explicit versioning. It does not mean identical native files, identical host features, or one schema containing every possible setting. Capability-specific configuration can be namespaced and validated by its published schema; harness adapters translate only the supported portions. Unknown or unsupported required semantics must produce an actionable incompatibility, not a silent approximation.

Users should be able to inspect and edit the configuration directly. A setup plugin is a convenient author of that configuration, not its permanent owner or a prerequisite for runtime interpretation. Credentials remain references resolved in the execution environment rather than portable secret values embedded in a shared setup.

A proposed user journey is: choose a setup, inspect requirements and proposed changes, select compatible providers, apply configuration, use it through a supported harness, then customize or replace it without rewriting component code. Removing or changing a setup preserves user data and explicit local choices. Combining two setups is allowed only where their requirements and configuration ownership are compatible; do not promise arbitrary recipes can merge without conflict.

Before calling this foundation ready for ecosystem use, prove two meaningfully different setups against the same unmodified core, at least one independently authored public-API consumer, and a supported second harness with explicit capability differences. Verify that the user can make equivalent configuration manually and use installed capabilities without the marketplace being reachable.

An initial catalog of versioned setup packages may establish the distribution value before a full marketplace service is needed. Discovery, hosting, trust/review policy and update delivery are separate scope decisions. This recommendation limits the first implementation surface; it does not discard the user's marketplace direction.

## First-party reference setup: learn from Forge's own workflow

The user proposed using Forge's existing workflow as inspiration for how others can tune and build their own setups. Make it a maintained first-party reference setup built on the same public APIs and configuration available to everyone. It should remain useful as a ready-made workflow as well as an example; it receives no hidden access to private component internals.

The saved Forge development workflow provides the starting material: planning/research, implementation, validation, shipping, review and post-merge verification, with the corresponding skills, adapters and evidence behavior. Preserve the supported behavior for users who select that setup while extracting it from mandatory bare-product behavior. This is a proposed reference implementation, not a claim that the extraction is complete.

The reference should explain the purpose of each step, the capability it consumes, the configuration that selects it, and the evidence it returns. Show where a user can change an exposed option, where they can bind another compatible provider, and where a genuinely new behavior requires an adapter or capability implementation.

Its further purpose, clarified by the user, is to make the boundary visible between standard contract guarantees, user-configurable choices, new extension implementations and private internals. The capability extraction map now records this classification. Use the reference setup to discover misplaced fixed opinions and unsafe configurable guarantees, not merely as a tutorial after the architecture is finished.

| Example customization | What the reference should demonstrate |
| --- | --- |
| Different research or review procedure | Replace a selected skill/handler using the same declared input/output contract |
| Different executor or harness | Change a compatible provider binding and show capability differences before execution |
| Different workflow shape | Add, remove or rearrange supported steps with explicit dependencies and terminal behavior; preserve any required authorization at the affected operation |
| Different operating budget | Configure exposed concurrency/time/output controls and observe the resulting bounded outcomes |
| Different integration | Use an alternative compatible source-control, CI or other capability adapter without rewriting the workflow engine |
| A user's own setup | Derive a separate setup, preserve its provenance, and choose whether to follow upstream setup updates or maintain it independently |

Avoid presenting an exhaustive menu of knobs as the main onboarding experience. Provide one working reference and a small number of changes that produce visibly different behavior. At least one example should depart meaningfully from Forge's development-stage ladder so the documentation demonstrates reusable capabilities rather than renaming the same fixed workflow.

Acceptance proposals:

1. Install the reference setup over independently packed components and complete its supported journey without private imports or privileged setup behavior.
2. Build a distinct custom setup from that example using only documented APIs/configuration; run the same conformance checks.
3. Replace one compatible provider and one workflow procedure without changing component source.
4. Upgrade the first-party reference setup while an independently maintained derivative remains unchanged; explicitly following derivatives receive a reviewable update rather than overwritten edits.

This reuses the workflow work already done. It does not justify reimplementing the existing workflow before the capability-extraction and setup/runtime ownership map is complete.

## Update model: evolve the architecture without overwriting user workflows

The user identified the practical reason for the separation: Forge needs to distribute improvements to its architecture, reusable mechanisms and its own opinionated workflows while users can maintain different workflows. An architecture upgrade must not silently replace the choices users built on it.

| Update stream | What changes | Boundary to preserve |
| --- | --- | --- |
| Component/API foundation | Public implementations, contract versions, supported transports and correctness fixes | Existing supported consumers continue under the published compatibility policy; breaking changes require an explicit migration path |
| Runtime capability plugin | Execution, retrieval, account routing or another provided capability | Provider requirements and behavior remain compatible with declared consumers; installing a newer provider does not select it silently |
| Setup/workflow package | Opinionated profiles, procedures, role/skill mappings and recommended bindings | Only users who choose that setup receive its proposed behavior/configuration changes; their edits are not overwritten automatically |

Forge can ship improvements in all three streams, including a maintained first-party setup using capabilities from several packages. Distribution does not require embedding that setup into the packages' mandatory runtime. The architecture can evolve for everyone within its compatibility commitments; the first-party workflow can evolve for its adopters.

Three user choices need clear semantics:

- **Follow a setup:** record the chosen setup/version and offer its updates with a visible change preview and compatibility checks. The user controls adoption unless they explicitly configure an automatic-update policy.
- **Customize a setup:** preserve user-owned changes. Where the new setup and local edits conflict, expose the conflict and retain the last valid effective configuration until resolved. The exact update/merge mechanism remains to be designed.
- **Build independently:** depend only on selected public APIs/contracts and capability packages. There is no obligation to install or receive Forge's workflow presets.

Keep package version, API/contract compatibility, setup version and effective user configuration distinct. Reuse normal package versioning and existing provenance/lock mechanisms where sufficient; do not invent a new universal version system or store. A setup may declare compatible component/provider versions, but cannot promise that every future version will work.

Update acceptance should distinguish changes to configuration from data/schema migrations. A configuration preview is not sufficient proof of safe storage migration. Preserve the existing backup, interrupted-upgrade, recovery and post-cutover-write requirements when durable data changes.

Proposed checks:

1. Upgrade a compatible core component while two different user workflows continue unchanged.
2. Upgrade Forge's first-party setup while an unrelated/custom setup remains unaffected.
3. Update a selected setup with a local user edit: preserve the edit or report its conflict before applying changes.
4. Reject an incompatible provider/contract combination with an actionable version/migration explanation; do not partially activate it.
5. Recover a failed setup/provider activation to the prior working configuration. Verify data migration recovery separately when that update changes durable storage.

These are proposed update semantics, not an implemented updater or a promise of automatic compatibility. Exact support windows, migration policy and marketplace update controls remain release-planning decisions.

## Full capability extraction: Memory and Flow as foundations for other products

The source-backed inventory is saved in [capability-extraction-map.md](capability-extraction-map.md): 12 Memory and 12 Flow capability families, current export/assembly status, outside-consumer value and extraction boundaries. It is a bounded inventory, not completed issue-by-issue release disposition or runtime certification.

The user subsequently proposed making these capabilities smaller independently usable building blocks, with Memory and Flow potentially becoming optional bundles over them. The inventory now evaluates logical capability APIs, selectable implementations and separately published packages as distinct decisions, and proposes candidate boundaries with their transactional constraints. This is a discussion proposal; do not treat the current Memory/Flow package names as fixed extraction units or automatically publish one package per inventory row.

The user clarified that Memory and Flow contain broad capabilities and must expose that useful breadth so other developers can build their own solutions on top. Reducing Memory to remember/recall or Flow to a single execute operation would not establish the intended product value. Those starter journeys remain useful checks, but cannot be the complete extraction acceptance criteria.

The extraction target is every existing supported product capability that has an independent consumer use case. Each must have a deliberate disposition: public API in its owning component; separately consumable capability plugin; optional setup/workflow composition; or internal implementation supporting a public operation. Nothing should disappear from the accounting simply because the initial package entry point does not export it.

Do not confuse broad capability exposure with exporting every helper, database table or internal class. External developers need stable operations and extension contracts. They should not need to reproduce private coordination, storage or permission logic to use a capability. Preserve that logic behind the public operation rather than delegating correctness to callers.

For each capability family the change-impact map must record:

- Existing implementation and its current owner, including code still in the root facade or private assemblies.
- Whether the capability is implemented and publicly usable, implemented but incompletely exposed, or only planned. Exported names alone do not prove a working public journey.
- The outside developer's use case, the API inputs/results and required dependencies, and whether it works standalone or needs an explicitly selected service.
- The extension points consumers can implement and which authority/integrity semantics remain enforced.
- Local/headless/remote assumptions, compatibility behavior, and a representative independently installed consumer check.
- The existing issue/PR mapping, extraction ownership and any release disposition requiring discussion.

Public entry points should enable direct use of a capability without making the caller adopt Forge's opinionated end-to-end workflow. For example, using a monitor should not automatically start a PR workflow; accepting authorized evidence should not require Flow to have produced it. Exact API shapes must follow the existing implementations and contracts, not be invented before the inventory.

SDK, CLI, MCP and remote service surfaces can be adapters over the same public operations where useful. Duplicating the capability implementation in each transport would recreate the coupling this architecture is meant to remove. A public API does not require exposing every transport in the first release.

Full extraction accounting is a planning requirement. It is not a claim that every planned capability already exists or that every future idea must be implemented for 0.1.0. The release proposal must explicitly show any retained private capability, omission, or deferred extraction, its impact on outside consumers, and why; do not silently substitute a tiny subset for the product.

## Current user requirements and corrections

- Memory must work independently of Flow and Companion.
- Flow must work independently, with explicit distinctions between standalone execution and execution connected to durable authority.
- Companion remains an independent execution component. Integrate the external work through contracts; do not copy its runtime into Memory or Flow. Its package name and inclusion date are not settled here.
- Keep the independent `@forge/contracts` library. Memory governs authority semantics; that does not require absorbing the physical Contracts package.
- Memory must accept authorized, contract-valid receipts from humans, agents, and other runtimes. Flow is the producer for its own execution path, not the only permitted producer.
- Keep the one-way Beads importer. Remove live Beads authority/backend/sync/export coupling. Kernel-native backup and restore remain distinct from Beads migration. Earlier planning text saying to remove the importer is superseded by the user's correction.
- Preserve the supported harness commitments. A generic adapter seam or an honest `UNAVAILABLE` result does not by itself implement a promised adapter.
- Customization and composition are desired product outcomes, not automatically post-0.1.0 enhancements.
- The architecture must accommodate cloud execution and storage. Local filesystem and single-process assumptions must be identified before freezing public contracts.
- The multi-account GitHub integration should be considered an independently usable adapter, with optional Forge plugin packaging. This is the user's proposed extension direction, not a completed extraction or finalized release commitment.
- Main agent owns planning; Luna gathers evidence; Sol implements after the scope and contracts are agreed. This draft does not authorize implementation or another PR.

## Component model

| Component | Responsibility | Customization boundary |
| --- | --- | --- |
| Contracts | Versioned packet, receipt, capability, error, and event formats plus consumer fixtures | Consumers implement supported contracts without importing other packages' private code |
| Memory | Durable records, authority verification, provenance, retrieval, retention, and acceptance of evidence | Retrieval/enrichment providers and public authority access; external indexes do not become authority |
| Flow | Workflow composition, scheduling, bounded execution, monitoring, and receipts for its execution | Workflow definitions, skill handlers, execution providers, supported host adapters |
| Companion | Reusable downstream jobs, progress, cancellation, recovery, and executor receipts | Its existing host adapters and a contract bridge to Forge |
| Forge CLI | Convenient composition of installed products, explicit configuration, optional setup invocation, and diagnostics | Public APIs and selected providers; profile catalogs and opinionated generation belong in optional setup plugins |
| Agent Config | Operator/machine routing, privacy, reachability, and provider policy | Resolved policy is captured for a run rather than copied into another mutable policy store |

Skills are procedures and triggers. Plugins package replaceable capabilities. Neither becomes another authority store or scheduler by default. Forge's recommended workflow belongs in an optional setup package; the bare products do not activate it implicitly.

Contracts has no execution or authority of its own: it cannot authorize work, schedule jobs, store credentials or mutate durable state. Physical package independence, ownership of contract semantics, and authority to accept a state change are three separate properties.

An illustrative connected path is:

```text
Resolved project and operator policy
                  |
                  v
Memory authority -- authorized work + immutable policy/capability snapshot
                  |
                  v
Executor: Flow, Companion bridge, or another authorized runtime
                  |
                  v
Receipt + durable artifact references
                  |
                  v
Memory verifies identity, scope, freshness and idempotency, then records outcome
```

Flow may use Companion as its execution provider. Other callers may use either directly. Standalone execution produces evidence without pretending it acquired a connected authority lease.

## GitHub account integration and the proposed extension standard

The user's GitHub example is a useful test of whether the architecture is extensible beyond agent execution. A GitHub integration should be able to handle account selection and credential delivery for Git/GitHub operations without importing Flow scheduling or Memory's private database. Forge can supply project identity, the authorized operation and policy context; the integration returns its result and evidence through an appropriate capability contract.

Keep three roles distinct:

- A contract specifies a capability's inputs, outputs, failure cases and compatibility requirements.
- An adapter translates that capability into a particular external system's behavior. A GitHub identity/transport adapter and a harness execution adapter have different operations; they need not share an artificial universal job interface.
- A plugin is the installable registration and lifecycle packaging for one or more capabilities. It may supply adapters or workflow steps. Packaging is optional for direct library use.

Contracts should remain independently distributable and versioned. A plugin may contribute a namespaced contract extension, but it must not silently replace the base rules for identity, authority, permissions or receipt validation. The host validates compatibility and grants before invoking a selected provider.

This allows a small common registration model and capability-specific interfaces. It does not require making every internal helper a plugin, putting a second orchestrator above Flow, or requiring all integrations to install every Forge product.

If the same composition host is needed by several independent products, its implementation can also be reused behind a narrow API. Do not make Memory-only users install Flow to load a retrieval provider, or make direct GitHub-adapter consumers install Forge's workflow engine. A separate public host package should follow demonstrated reuse and a clear responsibility, rather than being introduced solely to make the diagram symmetrical.

The extension boundary should permit an application outside Forge to consume the contracts and adapters. Forge is then one host of the protocol, not a hidden prerequisite for every integration. The replaceable surfaces are behavior and providers; authority validation, credential isolation and evidence rules remain enforceable for a connected deployment.

| GitHub integration responsibility | Forge responsibility | Acceptance case |
| --- | --- | --- |
| Resolve the intended account for a repository/operation | Supply project context and explicit operator/project policy | Two projects use different accounts without changing a machine-wide default |
| Supply scoped credentials to the intended Git or `gh` invocation | Authorize the operation and protect secret boundaries | Concurrent operations do not cross account contexts or expose credentials in packets/logs |
| Return actionable auth/reachability errors and operation evidence | Interpret evidence for the relevant workflow or authority decision | Missing/expired credentials produce a clear result rather than silently selecting another identity |
| Support declared local or headless execution modes | Schedule/route only where required capabilities exist | A cloud worker resolves credentials in its own environment; desktop executable paths are not transferred |
| Expose independently consumable operations | Optionally compose them with Forge commands, workflows or other plugins | A standalone consumer and a Forge consumer use the same integration behavior |

Transparent account routing for ordinary tools is a separate acceptance requirement from a working `forge github run` wrapper. If that ordinary-tool experience remains desired, the plan must test it explicitly; plugin extraction alone does not prove it works.

Calling this a reusable extension protocol is a reasonable goal. Calling it a new industry standard would be premature. First prove independent consumers, stable compatibility/versioning, understandable errors and documentation, and the ability to implement a provider without private Forge knowledge. GitHub account routing is a valuable third capability family alongside execution and memory retrieval because it exposes assumptions that two similar harness adapters might share.

Sol's targeted source check found existing work to extract rather than redesign: `docs/work/2026-09-08-github-account-context/plan.md:13`, together with `lib/github-context.js` and `lib/commands/github.js`. The saved design uses native GitHub CLI credential storage, opt-in clone-local selection and child-scoped credentials. GitHub API identity, Git authorship and Git transport must remain distinct. The independent provider should preserve these semantics and be exercised by both a non-Flow consumer and a harness consumer. This is source evidence; a standalone extracted provider has not been runtime-proven by this review.

## What the current code already gives us

Source inspection was against tracked `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`. These are source-level findings, not new runtime certification.

| Area | Existing foundation | Gap to close and user value |
| --- | --- | --- |
| Independent Contracts | Own manifest, public entry point, schemas and fixtures: `packages/contracts/package.json`, `packages/contracts/index.js` | Prove packed installation independently and settle compatible release versions; consumers can rely on an actual distributable contract |
| Memory assembly | Injected backend registry and authority-provider wrapper: `packages/memory/src/backend-registry.js:79`, `packages/memory/src/authority-provider.js:25` | Ship a supported default durable assembly so a user need not invent a Kernel broker; retain injection for customization |
| Flow assembly | Injected runner, packet validation, receipt observation, bounded outcomes: `packages/flow/src/executor.js:217` | Ship a useful supported runner assembly. Injection itself is not a defect; missing default execution is the user-facing gap |
| Receipt acceptance | Validation and persistence exist in PR lifecycle authority: `packages/memory/src/pr-lifecycle-authority.js:879` | Define and prove generic acceptance independently of the stricter PR-linkage path, whose executor check at line 492 is Flow-specific |
| Profiles and role bindings | `lib/adoption-profiles.js`, `lib/workflow-profiles.js`, `lib/commands/role.js`, `lib/config-writer.js` | Reuse useful code while separating setup presets/generation from runtime configuration contracts; show selection, precedence and conflicts through supported diagnostics |
| Skill composition | Role/subskill definitions and bounded injected handlers: `lib/core/runtime-graph.js`, `packages/flow/src/skill-runtime.js` | Connect registry, invocation, provenance, configuration and runtime behavior consistently rather than creating another router |
| Facade | Ownership is documented in `docs/work/2026-08-09-forge-product-restructure/facade-routing.md`; current `bin/forge.js` still imports broad internals | Route through public product APIs; optional-package absence should be actionable rather than an internal import failure |
| Installation proof | `test/integration/standalone-package-smoke.test.js:156` installs Contracts, Memory and Flow together in its probe | Add isolated useful journeys; loading all packages together does not prove each works alone |
| Companion | Tracked external baseline has request/receipt protocol and adapter control surfaces; its manifest is private and lacks a public package entry point | Preserve completed external work, reconcile its actual integration head, and define the Forge bridge and distribution journey before calling it a published independent package |

The central finding is assembly, wiring and conformance work around existing mechanisms. That does not eliminate genuine authority or lifecycle gaps, but it avoids treating every archived idea as a new framework to build.

## Reconciliation of the inspirations

The sources here are the saved architecture research, not a fresh upstream product/version audit. Recommendations below are proposals for Forge; none imply the external products have been installed or benchmarked.

| Inspiration or mechanism | Value for Forge | Smallest useful implementation | Scope distinction |
| --- | --- | --- | --- |
| DSH/Cordis typed `provides`/`requires` seams | Swap a provider without changing its consumers | Reuse capability registry and injected providers; validate requirements and version compatibility before selection | Basic configurable providers are relevant now; a complete reactive dependency runtime is not established as necessary |
| Owned activation and disposal | Prevent duplicate handlers, orphan jobs and partial activation | Validate candidate before activation; owner-bound cleanup, bounded cancellation, explicit failure | Minimal lifecycle accompanies executable providers; hot replacement and full rollback orchestration need separate acceptance cases |
| Deterministic profile overlays | Users can explain why a behavior/provider was chosen | One documented precedence path with source provenance and a per-run resolved snapshot | Reuse current config/profile mechanisms; avoid an additional configuration database |
| Separate durable facts from live progress | Recovery and cloud reconnect do not depend on an open terminal | Durable outcomes and cursored progress; bounded transient observations | Needed at execution boundaries; no generic event-bus project is implied |
| Matt Pocock/PStack skill mechanics | Selective installation, fewer accidental triggers, less context use | Qualified provenance, explicit manual-only versus auto-eligible behavior, progressive loading, collision diagnostics | Add portable mechanics; do not copy host-specific assumptions or invent unenforceable invocation guarantees |
| Composable workflow steps | Replace review/research/execution behavior without editing core | Configure existing roles/handlers; specify input/output and terminal behavior; test a custom step | Prove a real custom workflow before designing an unrestricted workflow language |
| Evidence and completion receipts | Avoid stale head, stale lease and partial-validation success | Fresh subject/environment bindings, artifact provenance, tri-state outcomes, idempotent acceptance | A foundational correctness requirement; extend schemas for concrete failure cases rather than accumulating envelopes |
| PStack independent evaluation | Avoid promoting anecdotal improvements | Reuse the frozen corpus and independent scoring; preserve disagreement and failures | Evaluation tooling stays outside runtime authority |
| Event-driven scheduling | Reduce duplicate work, idle turns and conflicting edits | Ready dependencies, explicit ownership, bounded progress, cancellation and critical-path measurements | Reuse Flow's scheduler/monitor work; agent count is not the performance objective |
| FTS5 plus optional projections | Keep memory available when an enrichment provider fails | Canonical records first; provider candidates rehydrated and reauthorized before context inclusion | Default reliable memory first; retrieval enrichment must show additional value |
| Graphify code graph | Dependency paths, blast radius and architecture navigation | Optional exact-revision graph queries with evidence/confidence and affected-file evaluation | Candidate experiment; no new authority store and no duplicate remember/recall commands |
| Graphiti temporal relationships | Queries across changing facts and relationships | Provenance, supersession, deletion and temporal-query evaluation | Fix misleading existing surfaces before claiming support; evaluate against local retrieval |
| OpenViking progressive context | Lower context load and observable retrieval | Apply progressive loading and retrieval traces where existing Forge context selection benefits | Native mechanism or isolated connector experiment; adopting the external platform is not decided |
| Mem0 fact extraction and retrieval | Potential future conversational/personal recall | Scoped proposals, source mapping and controlled extraction-versus-retrieval evaluation | Only with a concrete user requirement; extracted facts do not become authoritative automatically |
| GraphRAG collection analysis | Batch understanding of large stable document sets | Isolated analysis job if required | No established requirement for operational-memory integration |

Cleanup is not the same as reversing external effects. Disposing a plugin cannot undo a deployment or remote write. Such operations need their own authorization, idempotency, reconciliation or compensation evidence.

## Discussion proposal: returning results to harnesses without silent incompatibility

The user raised a further requirement: components must also return information to the calling harness coherently through Forge's APIs, contracts and skills. Detect incompatibility and explain it, but evaluate feasibility and end-user value before committing to a larger compatibility system. The mechanisms below are proposals, not a locked release decision.

**Feasibility assessment:** a bounded compatibility and delivery system is feasible. It can validate declared contracts, detect known capability/configuration drift, test supported integrations and report observed delivery failures. It cannot guarantee that arbitrary future plugins, undocumented harness changes or model behavior will never break. The product should promise explicit compatibility checks and honest outcomes, not universal compatibility.

### Separate the data path, delivery path and instructions

```text
Harness call
    -> host adapter / public API client
    -> component or composed plugin
    -> typed result, progress, request for approval, or continuation reference
    -> adapter validates and translates for the selected harness capability
    -> supported tool response, progress channel, queued delivery or notification

Skills explain when to invoke capabilities and how to interpret the result.
They do not replace transport, authorization or evidence validation.
```

A component returns through its public API without knowing whether the consumer is Codex, a web application or another service. A harness adapter owns host-specific delivery. Integration code owns the connection between them. A skill may provide the human/model-facing procedure, but ordinary API consumers must not need a skill loader to use the component.

Connected execution can persist outcomes and delivery evidence through the configured durable service. A standalone API can return its result directly. Do not require every utility plugin to create an issue, a durable workflow or a background monitor merely to return a value.

| Information | Required behavior | Boundary that must stay honest |
| --- | --- | --- |
| Final result or error | Validate a typed result and render a bounded summary with references when needed | A well-formed response does not prove its factual content; completion still needs the relevant evidence |
| Progress | Use a supported progress channel, with bounded output and duplicate suppression | Optional live progress may be unavailable while final-result delivery still works |
| Approval request | Use an actual supported approval/authorization path | A notification or prose instruction is not equivalent to an enforced approval gate |
| Continuation/handoff | Carry stable context and artifact references through a supported return, queued injection or resume path | A harness without resume cannot truthfully advertise resumed execution |
| Asynchronous outcome | Track delivery separately from computation; reconnect/retry only under supported idempotency semantics | Queued, transport-accepted, injected, seen and acted-on are different claims; report only what can be observed |

### Smallest useful compatibility checks

Use existing contract validators, capability probes, provider/skill registries, delivery evidence and Doctor diagnostics. A new always-running compatibility service or universal abstraction is not justified by this requirement alone.

| Trigger or mismatch | Recommended treatment | User-facing explanation |
| --- | --- | --- |
| Unsupported required API/schema version or malformed contract payload | Reject the affected invocation or receipt | Name the consumer/provider and required versus supported contract, with a supported upgrade or selection action |
| Missing permission, identity binding or required approval capability | Block the affected operation | Explain which guarantee cannot be enforced; never silently switch to an observational fallback |
| Missing optional streaming or notification capability | Warn and use an explicitly allowed supported delivery route | State what will still arrive, when it can arrive, and which live behavior is unavailable |
| Skill/provider name collision or incompatible projection | Diagnose before automatic selection; require an unambiguous supported selection | Show the conflicting sources/versions and the chosen precedence or unresolved conflict |
| Relevant provider, harness or effective configuration changes | Revalidate the affected route at configuration application, invocation or reconnect | Explain that previous compatibility evidence no longer covers this combination |
| Lost connection, duplicate delivery or late result | Reconcile through cursors/idempotency and current authority; preserve unconfirmed state | Show pending/failed delivery or stale result rather than silently marking it received or complete |
| Plugin crash or cleanup failure | Bound and isolate where the platform supports it; return honest failure/incomplete evidence | Identify the failed capability and its effect on the requested outcome; do not claim a sandbox or successful cleanup without proof |

Keep a run's selected compatible versions/configuration stable where supported. Do not silently hot-swap an in-flight dependency. Security revocation or incompatible changes need explicit invalidation/cancellation handling; pinning must not preserve revoked permission.

Diagnostics should describe one actionable problem: the affected operation, expected capability, observed mismatch, impact, and available recovery. Deduplicate repeated warnings. A user should not need to read raw manifests or traces for routine setup. Unrelated optional-plugin incompatibility should not block unrelated working capabilities.

### What to prove before admitting this to the release

1. A synchronous API result returns correctly to each promised harness through its supported adapter.
2. One asynchronous job loses its connection and later returns without duplicate actions or false delivery/completion claims.
3. An optional progress capability is absent: the user gets one clear explanation and a proven final-result route.
4. A required approval or permission capability is absent: the affected operation does not run.
5. A plugin/contract upgrade is incompatible: detect it before activation where possible, preserve the last working configuration, and identify the affected consumer.
6. A skill collision or host projection drift produces an actionable diagnostic instead of a silent changed behavior.
7. A provider passes schemas but violates a meaningful contract behavior: consumer/conformance fixtures catch the known case. Schema validation alone is insufficient.

These checks extend the existing supported-harness and release proof, not a substitute for it. The exact set and release timing still need discussion.

### Ideas to defer or drop unless evidence justifies them

- Drop the promise to predict every future breaking change or guarantee that a model obeys a skill. Neither is enforceable through API schemas.
- Drop warnings that have no identified impact or recovery action. Constant generic warnings reduce the usefulness of real failures.
- Avoid a new meta-router, a second scheduler, a generic event bus or duplicated per-plugin compatibility engines. Reuse the existing owners of these behaviors.
- Defer hot replacement, automatic compatibility repair and broad third-party plugin discovery until a concrete consumer needs them and failure/recovery behavior is proven.
- Do not require Forge packaging for native harness plugins that consume or provide no useful Forge capability.

The user value is predictable results, fewer silent failures, understandable setup and safer upgrades across supported combinations. If a proposed mechanism does not improve one of those outcomes, it should not enter the product merely to complete an architectural diagram.

### Saved research that already defines this return path

Sol's bounded follow-up recovered the following source-level evidence against the same tracked baseline. These are existing design and validation requirements; implementation coverage for every contract was not audited in this pass.

| Existing requirement | Saved source | Reconciliation |
| --- | --- | --- |
| Flow `MonitorSpec`, Memory-persisted sequenced `MonitorEvent`, harness/facade `DeliveryReceipt`, terminal `MonitorReceipt`; persist before at-least-once delivery with idempotent IDs and acknowledged cursors | Product restructure `plan.md:423`; `decisions.md:26` records unresolved physical storage/ack details | Reuse these contracts for connected monitoring. Do not add another receipt family or claim the storage/ack design is already fully implemented |
| T0 durable pull, T1 next-turn injection, T2 active-session delivery, T3 resume/wake, T4 human notification | Product restructure `plan.md:447` | Supported monitor targets retain T0; additional routes require proof. These are distinct delivery capabilities, not interchangeable safety guarantees or a simple quality ranking |
| Capability evidence binds executable identity, harness version, probe revision and result hash | Product restructure `plan.md:223` | Unknown, stale, unprobed or usage-limited capability evidence cannot support a required operation. Reprobe the affected route rather than trusting a harness brand name |
| Qualified skill provenance, invocation metadata, conflict preference and atomic projections | Architecture `research.md:448`; product restructure `acceptance-contracts.md:54` | Validate projections and diagnose drift; skill text cannot implement missing host permission controls |
| Changed surfaces map to owning tests, dependent routes, contract fixtures and platform additions | Product restructure `validation-matrix.md:20` and `:8` | Reuse existing change-risk/conformance selection for development and upgrade checks. Block known breakage; identify unverified external consumers without promising their behavior is safe |
| Monitor events do not grant approval or merge authority; handoff has typed continuation | Product restructure `plan.md:465`; architecture `research.md:414` and `:439` | Delivering an approval request does not approve it. Resume against a fresh accepted authority decision where one is required |

The existing research explicitly rejects universal mid-response injection. The useful supported promise is delivery through a declared, proven route with honest pending or unavailable status. A fallback should match the operation's needs, not simply select the highest-numbered tier.

For an uncancellable worker, authority revocation and rejection/quarantine of late receipts can prevent stale results from becoming authoritative; they do not prove that the process or its external side effects stopped. That limit must remain visible in the result and in which operations are permitted to start (`external-market-architecture-research.md:89`).

Keep two checks distinct: development/release conformance catches known breaking changes before shipping; setup/run/reconnect checks detect incompatible installed combinations and observed delivery failures. Together they provide practical protection without a new system that purports to predict every break.

## Cloud: requirements to preserve now

The user explicitly expects Forge eventually to work in the cloud. Design for local, remote and hybrid placement using the same product contracts. Do not define cloud as merely running today's CLI inside a container.

| Boundary | What must be possible | Acceptance evidence to require |
| --- | --- | --- |
| Workspace identity | A packet identifies repository/revision and permitted roots; the worker resolves its own absolute checkout path | The same logical job works in different temporary directories on two machines; no sender-specific drive path is required |
| Durable authority | A run names its authoritative service/store; workers access it through a public interface | Two workers cannot both commit success under an expired/replaced lease; authority remains valid after a worker exits |
| Storage placement | Local SQLite remains useful; remote workers need not share its filesystem | Restart the authority service and worker independently without losing accepted records; no concurrent shared-drive SQLite design is assumed |
| Artifacts | Receipts use identifiable, retrievable artifacts with integrity and access scope | Evidence remains verifiable after the execution workspace is removed; a local absolute path alone is insufficient for a remote consumer |
| Retry and disconnect | Requests are idempotent; attempts/events can be reconciled after response loss | Resubmit after an acceptance response is lost; no duplicate durable completion; stale attempts cannot overwrite newer authority |
| Cancellation | Cancellation is a request with an observed outcome, not proof that the worker stopped | Disconnect/reconnect and late completion cases preserve honest status; uncertain cleanup remains incomplete |
| Credentials and identity | A headless worker gets scoped credentials at runtime and a verifiable actor identity | No interactive browser login or secret embedded in a packet is required for the supported cloud worker journey |
| Project isolation | Authority and retrieval enforce scope across projects; a hosted service additionally needs tenant isolation | Cross-project requests and retrieval are denied; shared hosted deployment requires tenant-specific isolation tests before release |
| Portability | Public package APIs do not require the Forge checkout, a desktop session or a machine-specific installation | Independent packed-install journeys run in a clean headless Linux environment as well as supported local environments |
| Resource control | Long-running execution has bounded time, output, subprocesses and concurrency | Timeout, output flood and worker crash produce bounded results and recoverable state |

These are design and test requirements, not claims that the current code passes them. Prefer an existing broker/authority transport seam if it fits. Do not add a second remote protocol or choose a distributed database merely because cloud is an eventual target.

The focused cloud source audit found an existing design to build on, and specific implementation gaps:

- `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md:12` already describes local SQLite authority, a team Durable Object authority, and D1 as a read model. This is an existing design choice, not a newly selected hosting stack or an implemented cloud service.
- `lib/sync-backend.js:170` exposes only the implemented local no-op path; server and git-JSONL paths explicitly report that they are not implemented. Remote/team acceptance therefore still needs implementation evidence.
- `lib/kernel/broker.js:70` derives local identity from repository paths, and `lib/kernel/schema.js:149` stores worktree paths. The storage design already calls for normalized/redacted server records. Reuse that distinction rather than promoting absolute local paths into portable identity.
- `lib/kernel/broker.js:35` uses a process-local queue for PR linkage, while claim/replay behavior at lines 680 and 828 uses database transactions. These mechanisms are useful local foundations; they are not proof of cross-worker server fencing.
- `docs/work/2026-08-09-forge-product-restructure/external-market-architecture-research.md:58` already calls for run/attempt identity, sequence, idempotency and fencing on remote operations. Carry those requirements into consumer fixtures rather than designing them again.
- `lib/kernel/broker.js:425` assembles local research artifacts; the storage design at line 104 describes portable hashes/pointers and optional object storage. Artifact transport is a concrete bridge to finish, not a reason to replace the authority store.
- `lib/commands/team.js:43` filters credential-like environment variables, and `lib/mcp-config-renderer.js:11` uses variable references rather than literal secrets. Cloud credential delivery should preserve these boundaries.

The storage-model document also retains older Beads export/projection language. That is documentation drift to reconcile with the user's importer-only correction, not permission to restore Beads operations in cloud mode. No exact standalone cloud-transport issue was identified by the bounded audit; broader existing issue/research mapping remains necessary before filing duplicates.

Recommended milestone distinction: prove at least one headless remote-worker journey before making a cloud-compatible claim. A managed multi-tenant service, billing, fleet scheduling, regional availability and a cloud dashboard require their own scoped plan. Their exclusion from 0.1.0 is not finalized by this draft.

## Backlog reconciliation and open-issue meaning

The live scan in this planning session found 1,495 issue records, including 748 unfinished records: 727 open, 19 in progress and 2 in review. A focused release/architecture selection contained 73 unfinished records. This was not a complete classification of all 748, and issue count is not a feature count.

Issue status proves tracking state only. A completed issue or merged PR does not prove a fresh package installation or cloud journey works.

| Existing lane | How it contributes | What must be resolved before scheduling |
| --- | --- | --- |
| Memory standalone (`12d92893…`) | Public durable assembly and useful isolated package | Locate extraction ownership and restart/receipt tests; avoid duplicating completed backend-registry work |
| Flow standalone (`1ff3d2f9…`) | Supported runner, failure and cancellation journey | Freeze provider input/output before implementation; keep standalone and connected authority claims distinct |
| Facade/PR5 (`5f4da13f…`) | Thin product composition and capability/Doctor UX | PR5 alone does not close all adapter, package or release-candidate proof gaps |
| Claims projection repair (`9e31a2f0…`) | Consistent claims, lease and projection reporting | Serialize against changes to the same authority/storage files; previously completed preparatory work should be reused |
| Authority contracts (`85be2945…`) and actor identity (`7b60525b…`) | Fresh ownership and evidence bindings | Reconcile against existing Contracts rather than building parallel schema families |
| Harness registry (`6f2dbe75…`) | Shared adapter discovery and capability selection | Establish the provider contract before Companion bridge and certification work |
| Permission and lifecycle semantics (`84c942f3…`) | Retry, resume, cancellation and enforceable permissions | Freeze the control semantics before adapters independently invent different outcomes |
| Harness certification (`8d3786a0…`) | Evidence that supported adapters meet their declared capability tiers | Saved dependency map includes Companion bridge and skill registry; do not schedule it as an independent completed seam |
| Architecture epic (`44ed41f0…`) | Groups the earlier redesign work | Reconcile children by user outcome; the whole epic is not automatically a 0.1.0 blocker |
| Skill collision registry (`da760874…`) | Deterministic identity, provenance and projections | Existing dependency chain includes broader work; inspect whether the minimum collision guarantee needs a narrower child scope |
| Skill orchestration epic (`183dc7ca…`) | Triggers, subskills, chains and evaluation | Separate minimum configurable composition from advanced workflow features; no blanket deferral |
| Behavioral evaluation (`d362bd71…`) | Evidence that the default workflow performs acceptably | Reuse the completed corpus; distinguish deterministic safety gates from model-quality experiments without silently dropping dependencies |
| Companion integration (`8d14651d…`) | Packet/job/receipt and cancellation/recovery mapping | Reconcile the actual external implementation; decide distribution/inclusion separately from generic provider contract support |
| Hooks (`7268bc9b…`) and MCP projection (`9658c21a…`) | Truthful enforcement, configuration and drift | Preserve platform-specific capability distinctions; observation is not permission enforcement |
| Backend registry (`5037a7da…`, recorded done) | Local floor and optional adapters | Reuse implementation and verify the package journey; do not rebuild based on stale plans |
| Kernel memory projection (`forge-2agy.5`, recorded done) | Provenance, proposals and derived knowledge | Audit lifecycle/deletion gaps against the implementation rather than treating all provenance as missing |
| Provider extensions (`forge-2agy.6`, recorded done) and on-demand skills (`forge-2agy.6.4`, recorded done) | Existing capability registration and lazy disclosure | Inspect public wiring and conformance; completed issue status is not proof of every desired plugin lifecycle feature |
| Contracts rename (`4d41ffb7…`, recorded done) | Physical package boundary already selected | Preserve the boundary rather than reopening the package ownership decision |
| Global plugin distribution (`f5f82593…`) | Installation convenience for a particular harness | Evaluate release relevance separately from core package independence |

The generic non-Flow receipt bridge and cloud acceptance boundaries need exact issue mapping before implementation. This discussion did not create new issues or alter existing dependencies. Stale issue text about removing the Beads importer must be explicitly superseded when the plan is approved.

For each remaining candidate, use one disposition: necessary for an agreed 0.1.0 journey; prerequisite; later with named user value; already satisfied with evidence; duplicate/superseded; or unresolved. Priority labels alone cannot decide that disposition. Preserve links and rationale when consolidating; do not silently close old ideas.

## Parallel delivery without redesigning each other's code

First agree the user journeys and contract changes. Then use one contract owner and one owner per implementation surface. Different worktrees prevent checkout interference, but do not prevent semantic conflicts.

| Lane | Owned work | Starts when |
| --- | --- | --- |
| Contract baseline | Public packet/provider/receipt semantics and conformance fixtures; versioning rules | Requirements for local, standalone, connected and remote cases are agreed |
| Memory | Default authority/storage assembly, generic acceptance, retrieval lifecycle | Contract fixtures freeze; authority and claims repair file ownership is reconciled |
| Flow | Default runner, configurable steps/provider, cancellation and bounded receipts | Same contract fixtures freeze; no private Memory imports |
| Companion bridge | External-code integration and schema/control mapping | Contract freezes and external integration baseline is known; avoid rewriting completed Companion internals |
| Setup and skill configuration | Extract optional presets/generation; preserve runtime configuration APIs, collision/provenance and supported projections | Setup/runtime ownership and metadata agreed; shared facade/config files have one owner |
| Installation and cloud proof | Packed consumer fixtures, headless environment, disconnect/retry cases and measurements | Prepare independent harnesses early; execute as each product assembly lands |
| Facade and release integration | Command routing, aggregate diagnostics, manifests/lockfile and final combination tests | Stable public package surfaces are available |

The contract owner integrates shared-schema changes. The release integrator owns shared manifests, lockfiles, facade routing and cross-product docs. Leaf PRs should not each independently edit these shared surfaces. Merge against the current common contract baseline, then run the combined consumer checks. New contract discoveries are reconciled once before dependent lanes continue.

The existing architecture dependency map at `research.md:504` must be reconciled before dispatch: the Companion bridge depends on authority, adapter registry, permission/lifecycle semantics, routing/privacy (`ce785690…`) and Windows backpressure (`1fc448fa…`). Certification also depends on the bridge and skill registry. Contract-first parallelism is a proposal for reducing conflict, not permission to bypass these recorded dependencies. Determine which prerequisites are already implemented and which need an explicit scope split.

## Requirements recovered by Sol's research cross-check

These additions correct omissions in the initial local draft. They preserve saved requirements rather than introducing new product commitments.

| Recovered requirement | Source | Consequence for this plan |
| --- | --- | --- |
| Adoption and freedom envelope: explicit project/user enablement, strictness, disabled-by-policy, transactional apply/rollback | `docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md:355`; product restructure `plan.md:174` | Installing packages together must not silently activate behavior. Show winning configuration source and prove enable, disable and rollback |
| Memory-only use without the full issue workflow or a harness | Architecture `2026-09-12-forge-future-synthesis.md:13` and `:45` | A normal remember/recall consumer should not have to participate in Flow's development workflow |
| Independent release evolution, not just importable packages | Product restructure `plan.md:343` | Prove independent CI/version/publish, upgrade/uninstall, N/N-1 compatibility and seam failure injection. Preserve the two accepted release-cycle criterion before physical repository extraction |
| Provider replacement under failure | Architecture `research.md:181` and `:474` | Where replacement is supported, test dependency drain, activation failure, recovery, cycle diagnostics and cleanup failure. Compensation or irreversibility must be reflected truthfully in evidence |
| Named supported harness matrix plus later capability-tiered additions | Product restructure `plan.md:767`, `validation-matrix.md:43`; architecture `research.md:552` | Preserve Claude, Codex, Cursor and Hermes 0.1 commitments; explicitly disposition OpenCode, Pi and DSH rather than losing them or quietly changing the release set |
| Existing normative release evidence | Product restructure `validation-matrix.md:60` and `plan.md:789` | The new standalone/customization/cloud journeys extend the matrix; they do not replace it with a lighter smoke test |

The existing normative release matrix requires Ubuntu/macOS/Windows, Node 22/24, Memory-only/Flow-stateless/Flow-connected/facade modes, the four named harness projections, beta.5 migration and recovery, contract compatibility, authority/security, monitor delivery and cleanup, continuation after session loss, installed-harness capability probes, bounded event reduction, consent/privacy, artifact integrity/provenance/OIDC/dist-tags, and an exact-head merge-train simulation. It consumes one signed release BOM and tri-state evidence. This draft does not change those requirements.

The saved thresholds are specific: beta.6 requires at least 10 distinct clean synthetic journey IDs; beta.7 at least 25 clean canary journey/environment pairs across required strata and 72 continuous hours without a new S0/S1 event; RC at least 50 pairs, every G0–G8 lane and seven cumulative automated observation days. Repeated identical journeys do not inflate coverage. These are source requirements, not claims that the current release has met them. Any proposed simplification must be discussed explicitly rather than silently editing the acceptance bar.

## Stability, performance and low-value complexity

Measure the actual public journeys before setting thresholds: cold/warm startup, Memory write/recall and restart, packet dispatch, cancellation, receipt acceptance, idle CPU/process count, output volume and end-to-end validation time. Record the package versions, dataset size and environment with each result.

- Reuse one config resolver and one authority mutation path. Remove duplicate routing and misleading no-op options after usage and compatibility checks.
- Load skill bodies and optional providers only when selected. Verify that a small command does not initialize unrelated execution/storage subsystems.
- Bound process output and progress events; avoid repeated polling or model calls while waiting for an external event.
- Preserve validation strength while eliminating identical repeated work through valid exact-input receipts; invalidate on changed head, policy, environment or required check inputs.
- Make external index/provider failure leave the canonical local path available. Test restart, deletion and stale-result rejection before optimizing retrieval recall.
- Keep supported aliases during the documented compatibility period; remove confusing internals, not user workflows without a migration path.
- The marketplace of setups is an explicit product direction. Decide its first distribution surface separately from the API foundation; do not make local/runtime use depend on a hosted catalog. A second scheduler, general event bus, vector database or dynamic dependency framework still needs a demonstrated consumer requirement.

## Proposed acceptance journeys for discussion

1. Contracts alone: install packed artifact in an empty project and validate canonical fixtures.
2. Memory alone: use a shipped default, remember, recall, restart and recall again; enforce scope, forget and recovery semantics without Flow, Companion, a harness or a mandatory development-issue workflow.
3. External receipt: Memory accepts an authorized conforming non-Flow executor; rejects stale bindings, tampering and unauthorized identity; handles duplicate delivery once.
4. Flow alone: use a supported runner, obtain truthful success/failure/cancel evidence, and exit with bounded cleanup without claiming online authority it did not acquire.
5. Customization: install without implicit activation; explicitly enable or disable behavior; replace a supported workflow step and provider through public configuration/API; diagnostics explain selection and incompatibility. Prove drain, failed activation/upgrade rollback, removal and cleanup failure, including truthful handling of an external effect.
6. Composition: connect Memory, Flow and an execution provider using public contracts; preserve run/attempt identity, artifacts, idempotency and cancellation outcomes.
7. Companion: if included, independently install/use it and pass the same bridge fixtures against its actual integration head.
8. Cloud/hybrid: dispatch to a headless worker with a different filesystem, retain evidence after workspace removal, recover from a lost connection, and reject stale lease completion.
9. Distribution: preserve the normative matrix above; prove independent packed install, upgrade/uninstall and N/N-1 compatibility, migration/recovery, exact BOM and observation thresholds. Monorepo imports alone do not establish independently releasable products.
10. GitHub adapter: use the extracted account-context capability from an independent consumer and a harness consumer; distinguish API identity/authorship/transport, maintain concurrent account isolation and keep secrets out of contracts and receipts.
11. Public extension: an outside consumer builds a useful plugin using only documented public APIs and contracts; replaces a provider without modifying the consuming component; passes conformance and compatibility fixtures. Identify the value the Forge integration adds beyond native harness plugin installation.
12. Setup portability: two meaningfully different optional setups configure the same unmodified bare products; equivalent manual configuration works; a second supported harness receives truthful translated behavior. Setup replacement/update preserves user edits and data, and installed operation works without access to a marketplace.
13. Independent updates: compatible component and runtime-plugin upgrades preserve custom workflows; a first-party setup update affects only its selected configuration, preserves local edits or exposes conflicts, and offers a verified recovery path appropriate to the change.

These journeys are the proposed way to decide which old issues belong in 0.1.0. They are not a declaration that the implementation or release plan is complete.

## Preserved research and evidence pointers

- `docs/work/2026-08-09-forge-product-restructure/decision-register.md`: existing product boundaries, extraction strategy, compatibility, probes and Doctor ownership.
- `docs/work/2026-08-09-forge-product-restructure/facade-routing.md`: command ownership and integration seams.
- `docs/work/2026-08-09-forge-product-restructure/validation-matrix.md`: normative G0–G8 matrix, RC platforms/modes/harnesses, exact artifacts and release observation thresholds.
- `docs/work/2026-09-08-github-account-context/plan.md`: existing multi-account identity/credential-context design and extraction constraints.
- `docs/work/2026-08-24-agent-harness-architecture/research.md`: DSH/Cordis at lines 168–194; memory-provider discussion at 196–229; skill/plugin mechanisms later in the document.
- The same architecture research directory: `2026-09-12-user-supplied-architecture-audit.md`, `2026-09-12-user-supplied-memory-provider-audit.md`, `2026-09-12-forge-future-synthesis.md`, and `2026-09-12-independent-agent-findings.md` preserve the previous synthesis and user-supplied inspirations. Consult tracked file locations when promoting this draft; do not treat historical recommendations as current user decisions.
- `docs/work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md` and `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md`: existing local/broker/team authority design to reconcile before adding a cloud transport.
- Existing release discussion issue: `ac44f34a-8f67-45c1-a589-6a4cc0730ef0`. Its historical comments include superseded scope and must not override the latest user corrections above.

Evidence limits: source findings are rung 2; live issue reads establish issue status only. No runtime acceptance suite, new provider benchmark or hosted deployment was performed for this draft. The backlog selection is partial. External Companion findings refer to the inspected tracked baseline, not uncommitted work or a newly verified merge. Luna supplied package, backlog, inspiration and cloud evidence; Sol cross-checked normative product/release research, the architecture index and relevant lifecycle/adapter mapping, plus the GitHub account-context design. Sol did not reread every skeleton-pivot appendix or classify all 748 unfinished issues. Main analysis reconciled these findings with the latest user corrections; stale agent recommendations removing the importer or inventing a Companion package name were rejected. The next planning step is to agree the minimum journeys and reconcile the remaining issue dispositions against them before authorizing code lanes.
