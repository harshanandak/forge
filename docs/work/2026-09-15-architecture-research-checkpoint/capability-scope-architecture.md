# Forge capability-scope architecture

Prepared 2026-09-15. Status: Astra architecture gate PASS at document/source-evidence rung 2; package compatibility, exact public-scope inventory, Companion/additional-harness disposition, and issue/PR ownership remain unresolved. This is a local planning artifact. It does not change repository files, Kernel issues, PRs, or release scope. See `astra-validation-log.md`.

## Product shape

Forge is one supported distribution built from capability scopes. `Memory` and `Flow` are first-party presets that select and configure those capabilities. They are not permanent product, authority, state, or implementation boundaries.

The current independent-consumer analysis proposes eight public API namespaces:

```text
authority | knowledge | evidence | feedback
execution | monitoring | integration | composition
```

Feedback is independent from generic execution and usage evidence because builders can use it to collect consent-bound product feedback without adopting the Forge workflow or either preset. A later hosted public URL is a transport adapter over the same feedback semantics.

```text
Forge distribution
|- lightweight host and CLI
|- Contracts: independent neutral interoperability library
|- capability scopes: supported operations and semantics
|- shared runtime owners: authority, persistence, activation and disposal
|- integrations: provider and harness translation
`- presets: Memory, Flow, reference workflow and user compositions
```

A capability inventory row becomes a public extension point only when it has:

- a meaningful independent consumer journey;
- coherent supported operations;
- explicit dependencies and lifecycle;
- defined failure and compatibility semantics; and
- a real reason to replace, configure, or call it independently.

Inventory does not determine packaging. Approximately 24 researched capability families may map to fewer public scopes and fewer implementation modules. Receipt construction, persistence bridges, reducers, and similar machinery remain internal when they do not satisfy the public-boundary test.

## Four different boundaries

| Boundary | Meaning |
|---|---|
| Distribution | One supported Forge installation and release unit |
| Capability scope | Stable public operation boundary selected through Forge |
| Implementation module | Internal code implementing one or more capabilities |
| Runtime owner | The small number of components that own durable state, transactions, resources, or effects |

These boundaries must not be collapsed. A capability does not require its own npm package, process, database, daemon, provider interface, permission category, or release train.

## Lightweight behavior

One distribution remains lightweight when:

1. Installation and discovery perform no activation.
2. The root import is a lightweight facade.
3. Implementations use demand-driven imports.
4. Only the resources required by an explicit operation or persistent session start.
5. Related capabilities share runtime owners where correctness requires one transaction or writer.
6. Presets contain declarative selection and supported options, not state or duplicated implementations.
7. Supported first-party implementations remain inactive until selected.

Shipping code in the distribution does not mean initializing it. Download size and runtime size are separate concerns. The Forge distribution includes its supported first-party capability and adapter implementations and their required library dependencies. They remain inactive until requested. External applications, harness executables and services are declared prerequisites; credentials are requested only for selected operations. Any separately installed first-party implementation requires an explicit exception to the one-distribution decision.

## Presets

```text
Memory preset
= authority + knowledge + evidence + feedback + durable observation

Flow preset
= execution + monitoring + supervision + composition
```

The names remain useful as convenient compositions. A consumer can select knowledge without selecting Memory, select execution without selecting Flow, combine both presets, or define another composition. Presets can overlap on shared capabilities without creating duplicate stores, watchers, or authority writers.

The bare configuration provides mechanism defaults and no mandatory Forge workflow. The reference Forge workflow is another optional preset.

## State and authority

State belongs to explicit runtime owners, never to a preset.

- Kernel authority owns authorization, claims, leases, fencing, accepted receipts and consequential work transitions.
- Domain capability implementations own knowledge, feedback, usage and observation semantics while committing through supported durable boundaries.
- The local persistence driver owns private schema, connections and transactions.
- Execution and composition capabilities own bounded orchestration.
- Integrations own provider effects and semantic translation.
- The host owns effective configuration, activation and disposal.
- Delivery integrations perform attempts and report acknowledgments; the durable owner persists events before delivery and owns accepted delivery state. Delivery acknowledgment neither grants approval nor proves authoritative completion.

Users may select implementations, but configuration cannot create competing authority writers or split a transactional invariant across independently committing modules.

Receipt acceptance independently checks producer authorization, claim scope, freshness and evidence sufficient for the requested transition. Format validity or producer identity alone does not establish completion.

## Activation and configuration

The minimum mechanism is:

1. A lightweight manifest declares included scopes, public versions and dependencies.
2. User configuration and optional presets select implementations and supported options.
3. An explicit operation requests a capability.
4. The host validates dependencies, compatibility and permission requirements.
5. The selected implementation activates only the resources required for the operation or session.
6. The host disposes owned resources at the bounded lifecycle end.

Setup artifacts request configuration; they do not grant authority. The effective revision resolves selected preset versions, provider and adapter identities, capability contract versions and relevant configuration. Preview changes nothing; adoption requires an explicit authorized action. Existing runs retain their selected behavior, while revocation is checked before subsequent consequential effects and receipt acceptance. Ambiguous provider or preset collisions are rejected.

## Integration rule

Use the smallest boundary that truthfully represents the integration:

1. Direct public API when the provider already conforms.
2. Constrained declarative mapping when the supported executor fully represents the provider operation.
3. Coded adapter when the supported declarative executor cannot faithfully implement the required authentication, lifecycle, retry, cancellation, reconciliation, effect or translation semantics.

The declarative path is included in 0.1.0 only where a concrete integration justifies a bounded implementation; it does not require a general mapping engine. Do not create a universal configuration language for arbitrary APIs.

A declarative integration definition is effect-bearing integration code expressed as data, not an ordinary setup artifact. Admission and grants bind the definition and executor identities, permitted operations, credential references and destinations. A data-only representation does not reduce its authority requirements. Executable integrations receive host-issued, scope-limited grants bound to executable identity and digest. Setup admission and integration admission remain separate.

## Local and future cloud operation

Public requests use explicit actor and project scope, operation identity, relevant authority and configuration revisions, deadlines, idempotency information and artifact references. Responses use typed results, errors, execution handles, receipts and continuation references.

Contracts must not depend on JavaScript closures, database handles, process globals, a shared checkout, or recipient-interpreted local paths. Local providers may use local paths privately. Portable calls use artifact references and resolvers.

Forge 0.1.0 must prove representative operations across a serialized process boundary. This makes later remote implementations possible without claiming that a cloud service, tenant isolation or distributed transactions already exist.

A lost response after an external effect may produce an unknown outcome. Stable operation identity supports deduplication or reconciliation according to the provider's guarantees; retries must not assume an unobserved effect did not happen. Artifact references are integrity-bound and access-controlled by the selected resolver.

## Package transition

The architecture drops Memory and Flow as permanent package identities now. Publication treatment requires a bounded consumer audit:

1. Inventory documented exports, internal imports, packed consumers, configuration references and support commitments.
2. Map supported behavior to capability APIs.
3. Prove the new distribution without the old entry points.
4. If known consumers need transition support, retain thin forwarding adapters for one defined migration window. They own no implementation or state.
5. If no support commitment exists, stop publishing new versions and provide a tested migration guide. Preserve previously published artifacts.

Contracts remains independently publishable because it is a neutral interoperability boundary. Companion remains an independent downstream execution implementation and integrates through capability contracts.

## Decisive acceptance journeys

- Knowledge-only use performs useful work without activating execution, workflow, credentials or harness resources.
- Execution-only use returns truthful results without requiring the Memory or Flow preset.
- An authorized non-Forge producer submits a receipt without either preset; unauthorized, wrong-scope, stale and insufficiently evidenced claims are rejected, and replay does not duplicate the transition.
- A consequential operation crosses a serialized process boundary, loses its response after it may have executed, reports an honest unknown outcome and reconciles safely. Tested cancellation and control behavior matches what the route advertises.
- Memory, Flow and a custom preset compose overlapping scopes without duplicate resources or competing writers.
- Preset preview has no effect; authorized adoption changes the resolved revision; replacement integration content cannot inherit inappropriate grants; and revocation blocks subsequent consequential actions.
- Legacy consumers work through thin adapters or a tested migration path.
- A packed Forge installation passes real lifecycle, migration and recovery journeys. Claude, Codex, Cursor and Hermes are enumerated with executable evidence for each advertised capability, including persistence-before-delivery crash/replay and missing-required-capability rejection.

## Release boundary

For 0.1.0: one distribution, explicit capability APIs, shared local runtime owners, demand-driven activation, Memory and Flow presets, generic authorized receipts, package/config migration, one-way Beads import and native recovery. Claude, Codex, Cursor and Hermes adapters require executable evidence for their advertised execution, control and delivery capabilities. Missing required behavior rejects the route before effects; optional delivery fallback requires an allowed, implemented fallback and a visible warning. OpenCode, Pi, DeepSeek Harness and Companion retain explicit release dispositions.

The 0.1.0 feedback scope provides local and in-process preview, consent, deterministic redaction, explicit project and endpoint scope, bounded artifact references, idempotent durable acceptance, deletion/export lifecycle and delivery status separated from acceptance. It does not require a hosted public endpoint.

Later: hosted cloud, hosted marketplace operations, managed updates, broad community executable integration admission, richer authoring and additional providers. A hosted feedback adapter may add registered public endpoints, server-resolved tenant isolation, signed ingress, rate and abuse controls, moderation and quarantine, remote artifact scanning, server-side re-redaction, retention enforcement and status reconciliation.

Drop: Memory and Flow as mandatory architecture, 24 autonomous packages or services, configuration as implementation, preset-owned authority, live Beads integration and silent activation or permission changes.

## Remaining decisions

- Final validation of the proposed eight public namespaces after promoting Feedback through the independent-consumer test.
- Whether current Memory and Flow package entry points have consumers requiring temporary forwarding adapters.
- Exact 0.1.0 inclusion and certification timing for Companion and additional harnesses.
- Conflict-free issue and PR ownership after the architecture decisions are recorded in the official release plan.
