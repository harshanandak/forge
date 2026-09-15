# Astra architecture guidance and main-agent analysis

Prepared 2026-09-15. Status: superseded by `capability-scope-architecture.md` after the user clarified that Memory and Flow should become presets over capability scopes rather than permanent package or product boundaries. Retained as review history. No repository file, Kernel issue, PR, or release scope was changed.

Evidence baseline: tracked `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`, selective live Kernel issue reads, saved Forge research, and official n8n/Kestra documentation. Repository findings are source-level evidence. No new runtime certification was performed.

## Decision requested

Adopt the architecture below as the baseline for revising the 0.1.0 plan. This authorizes planning reconciliation only, not code or PR changes.

## Conclusion

Forge should be a capability platform for durable work and knowledge, controlled execution, trustworthy evidence, and harness integration. Users install one coherent Forge distribution, select their setup, and activate only the capabilities they need. Developers can also consume Memory, Flow, Contracts, or integration APIs directly.

Keep the existing `@forge/memory`, `@forge/flow`, and `@forge/contracts` package identities for 0.1.0. The root distribution can provide the one-install experience. Ending those identities now creates migration and release work without improving that experience. Treat smaller capability families as public API and logical module boundaries; do not create a package or runtime service for each one.

Contracts are necessary infrastructure, but contracts alone are not the product. They define messages, compatibility and conformance. Product value comes from usable capabilities, working implementations, secure selection, evidence acceptance, composition, and truthful delivery.

Forge's existing development workflow becomes an optional first-party reference setup using the same public APIs available to outside authors. User configuration selects capabilities and behavior. A setup cannot grant itself authority or redefine evidence.

The future marketplace should begin as a versioned artifact and catalog model. Data-only setup artifacts and executable integrations require separate admission and security paths. A hosted marketplace, community code execution, automatic updates, rich workflow authoring, and multi-tenant cloud operation come later.

## Main-agent assessment of Astra's recommendation

I accept the recommendation because it preserves completed package work, supports one-install simplicity, and avoids both extremes: a tightly coupled monolith and dozens of separately released packages.

I add one clarification: the complete distribution contains the first-party capabilities supported by that version. It does not need to bundle every future integration. An integration with a large dependency footprint, separate security boundary, platform limitation, or independent lifecycle can remain an optional package while using the same contracts and setup model.

I also accept Astra's challenge to four literal premises:

1. Independent capabilities may have explicit public dependencies. Independence means no hidden sibling/private dependency, not zero dependencies.
2. The 24-family inventory is an accounting tool. Planned-only families do not automatically become 0.1 features.
3. Including a capability does not prove it is inactive. Inactivity needs observable process, store, credential, network and startup evidence.
4. A contract-valid receipt is structurally admissible, not automatically true or sufficient. Memory applies producer, authority, freshness and evidence policy before accepting a durable claim.

## Terms and boundaries

| Term | Meaning in the recommended architecture |
| --- | --- |
| Logical module | An internal responsibility boundary. Normally private and not independently versioned. |
| Public API | Supported operations, results, errors, lifecycle and compatibility guarantees for a real outside consumer. |
| npm package | An installation and versioning boundary. Preserve Memory, Flow and Contracts for 0.1; add packages only for demonstrated lifecycle/dependency/isolation needs. |
| Runtime service | A running owner of state or execution. It starts only when the selected capability needs it. |
| Setup artifact | Versioned declarative choices for capabilities, bindings, procedures and configurable policy. It proposes configuration and cannot grant authority. |
| Executable integration | Code translating or implementing provider-specific behavior and external effects. It requires stronger trust and permission handling than setup data. |

## Product responsibility map

| Owner | Responsibility | Required boundary |
| --- | --- | --- |
| Contracts | Formats, validators, semantic identity, hashing and conformance fixtures | Determines structural/semantic conformance, not authorization or truth |
| Memory/Kernel authority | Work state, claims, leases, gates, authorization, accepted receipts and durable transitions | One authoritative writer per authority scope; transaction invariants remain together |
| Memory knowledge/evidence | Canonical knowledge, provenance, lifecycle, feedback, usage evidence and durable monitor state | Public semantic operations; private tables/drivers; projections cannot rewrite accepted facts |
| User setup and configuration loader | Selection, validation, resolution, preview and effective configuration | User choices are authoritative for setup; config requests permissions but cannot grant them |
| Flow | Optional orchestration, bounded execution loops, steps, budgets, process/monitor coordination | Direct API calls and other executors do not require Flow; Flow produces receipts only for its own execution |
| Execution provider | Performs work and exposes actual lifecycle/control behavior | Enforces claimed timeout, cancellation, cleanup and isolation where supported |
| Integration/adapter | Provider authentication, semantic translation, effects, retry/reconciliation | Uses public APIs and host grants; cannot authorize or approve its own effects |
| Harness delivery adapter | Pull, injection, live delivery, wake/resume, notification and acknowledgment | Delivery is separate from authority acceptance, evidence sufficiency and human approval |
| Forge facade | Commands, config resolution, lazy activation, routing and diagnostics | Thin composition surface; no second authority or orchestration engine |

## Execution and result flow

```text
User setup
  -> validated effective configuration and capability bindings
  -> authority check for consequential operation
  -> direct integration, external executor, or Flow orchestration
  -> typed result and producer evidence
  -> Memory verifies producer, authority, scope, freshness and evidence
  -> accepted durable event/outbox when applicable
  -> harness delivery adapter
  -> separate delivery acknowledgment
```

A stateless Flow call can return a useful result without Memory. It cannot claim durable acceptance. A human, CI system, Companion, or another runtime may submit evidence to Memory without Flow. Different producer classes can be authorized for different claims and evidence levels.

External effects generally cannot share a database transaction with Memory. Every consequential effect needs a stable operation identity and truthful handling of uncertain outcomes. Idempotency, fencing and provider reconciliation should be used where supported. A timeout after a provider may have acted is `unknown` until reconciled, not an automatic retry or invented success/failure.

## Capability-family disposition

The 24-family inventory is grouped below without creating new package names.

| Group | Covered families | 0.1 direction |
| --- | --- | --- |
| Authority and work | Memory authority provider; work/dependencies/claims/leases/stages/gates; generic authorization/receipt intake | Supported local Memory assembly and package-neutral, policy-aware receipt acceptance; private transaction machinery |
| Knowledge and lifecycle | Recall/capture/search/digest/enrichment; provenance/typed knowledge; retention/supersession/forget/context | Complete implemented local journeys and expose useful semantic APIs; defer planned-only lifecycle/enrichment features without evidence |
| Feedback and evaluation | Feedback intake; triage/insights; usage/evaluation evidence | Preserve implemented public use cases; optional setup owns opinionated triage; later analytics require value proof |
| Monitoring and durable delivery state | Memory monitor state plus Flow monitor reduction/durability bridge | One durable contract and local implementation; no separate monitor product |
| Execution primitives | Flow packet execution, receipts, loops, skill steps, process lifecycle, efficiency controls | Supported standalone runner and truthful lifecycle results; receipt helpers remain implementation details unless independently useful |
| Composition and reference setup | Flow workflow composition and current profiles | Minimal composition interface plus first-party reference setup and one materially different setup; richer authoring later |
| Harness integration | Execution and result/progress/continuation delivery | Real Claude, Codex, Cursor and Hermes evidence; OpenCode/Pi/DSH explicitly experimental or deferred unless added deliberately |
| Domain integrations and identity | Git, CI, deployment, review, merge, Shepherd, credential contexts | Extract only integrations required by supported journeys behind narrow effect APIs; new providers later |
| PR lifecycle and handoff | Memory authorization plus Flow/external effects and typed continuation | Preserve current supported behavior through public boundaries; no standalone PR framework |
| Recovery and projections | Import, native backup/restore, external projections | One-way Beads importer and native recovery; no live Beads backend, export or sync |

## Configuration and setup

Configuration composes implementations; it does not simulate them.

For 0.1, support a small schema, deterministic resolution, validation, effective-change preview, version/digest selection, and explicit application. Avoid arbitrary expressions, scripts, a general REST-mapping language, or a second policy/configuration database.

Bare defaults should provide a useful local Memory assembly, a useful local Flow runner, explicit project scope, and no automatically adopted development workflow. Merely installing Forge, importing an unrelated API, requesting help, or inspecting capabilities must not start brokers, create stores, read credentials, spawn watchers, or contact providers. Explicit first use can initialize the selected local store or runtime.

Users may select providers, routing, steps/skills, budgets, and supported policy options. A setup artifact packages those choices as a reusable starting point. Installing a setup does not silently apply it. Updating it does not silently overwrite user choices.

Non-configurable invariants include authorization checks, project/tenant boundaries, receipt/lease/head validation, secret exclusion, evidence semantics, and enforcement of the selected policy. A setup can choose a supported validation policy; it cannot mark an unperformed check as passed or remove authorization required by an operation.

## Integration authoring

Use three paths:

1. Call a public API directly when it already implements the required contract.
2. Use a constrained declarative mapping only when an existing tested executor fully represents authentication, request/response transformation and failure semantics.
3. Write a coded adapter for stateful protocols, subscriptions, streaming, custom authentication, complex transformations, lifecycle controls, or external-effect recovery.

Do not create a universal mapping language. Integration authors provide implementation and conformance evidence; setup authors select and compose integrations; end users choose or customize their setup.

## Marketplace and security progression

Start with an artifact model:

| Artifact | Initial behavior |
| --- | --- |
| Setup | Local file or pinned package/catalog entry; schema validation, provenance, effective-change preview, explicit adoption; no authority grants embedded |
| Executable integration | First-party integrations plus explicit trusted-local developer installation; manifest declares requirements, while host grants bind actual executable identity/digest and scope |
| Update | Opt-in version change with compatibility validation; changes to code, digest, capabilities or requested permissions require grant review |
| Offline use | Installed setup, schemas, integrations and locks continue without a registry lookup |

Later work includes discovery service, publisher operations, community admission, hosted distribution, managed updates and stronger isolation. Setup admission and executable-code admission remain separate.

Security rules:

- Treat setup configuration as untrusted input even when it contains no executable code.
- Separate author-declared capabilities from host-issued grants.
- Do not call a child process a sandbox unless the platform actually constrains it.
- Bind consequential requests to project/repository, actor, scope, operation, run/attempt, authority revision, expiry and relevant head/lease.
- Carry secret references, never secret values, in portable config/packets.
- Preserve separate Forge authority identity, GitHub API identity, Git transport and commit authorship.
- Provenance proves origin/build linkage, not that code is safe.

## Harness return and compatibility

Maintain an explicit capability matrix. T0 durable pull is the connected baseline. T1 next-turn injection, T2 active-session delivery, T3 wake/resume and T4 human notification are separately demonstrated capabilities, not substitutes for one another.

Reject before effects when a contract is incompatible or required authorization, approval, cancellation, cleanup or delivery behavior is unavailable. Warn and use a fallback only when the missing behavior is optional, the setup permits the fallback, and the alternative is actually implemented. A warning identifies the adapter/version, missing capability, chosen route and user-visible limitation.

Persist connected events before attempting delivery, deduplicate with stable event identity, and record delivery acknowledgment separately. Delivery does not prove a human read or approved the result. Bind certification to executable identity, harness version, probe revision and relevant config; revalidate when those inputs change.

## 0.1, later, and drop

| 0.1 planning baseline | Later | Drop |
| --- | --- | --- |
| One complete Forge install plus independent Memory/Flow/Contracts consumption | Hosted multi-tenant authority and cloud operations | Package/service per capability family |
| Observable lazy activation of included first-party capabilities | Hosted marketplace and managed automatic updates | Universal plugin controller duplicating existing registries and Flow |
| Supported local Memory assembly and Flow runner | Broad community executable admission and sandbox operations | Configuration as arbitrary integration language |
| Policy-aware multi-source receipt acceptance | New enrichment providers and analytics without measured value | Mandatory Forge workflow ladder |
| Durable monitoring and lifecycle/continuation semantics | Companion integration unless a promised 0.1 route needs it | Flow-only receipt authority |
| Real Claude/Codex/Cursor/Hermes adapters | OpenCode/Pi/DSH certification unless pulled into scope | Live Beads backend/export/synchronization |
| Optional reference setup plus one distinct setup | Rich workflow authoring and visual tooling | Removing package identities during 0.1 |
| One-way Beads import, native recovery, claim repair, complete packed artifacts | New domain integrations driven by real consumers | Claims that manifests, skills, notifications or processes provide enforcement |
| Essential platform/runtime/migration/security/recovery evidence | Cloud service operations and distributed placement | Silent activation or setup-owned permissions |

Keep Companion independent and outside the 0.1 dependency graph by default. If a promised adapter requires it, include and certify that exact dependency or supply a different working adapter. Do not hide an unresolved dependency behind `UNAVAILABLE`.

Retain essential parts of the current release matrix: supported OS/Node combinations, independent/connected modes, promised harness journeys, migration/recovery, compatibility/security, cleanup/continuation, package integrity, and exact-head verification. Reopen the numerical 10/25/50 journey thresholds and 72-hour/seven-day durations explicitly; they are release policy, not architecture invariants.

## Dependency-ordered delivery plan

```text
Architecture and release-inventory decision
                 |
Contract and responsibility freeze
                 |
 +---------------+----------------+-------------------+
 |               |                |                   |
Authority and    Memory           Flow runner         Setup activation,
receipt policy   knowledge        and lifecycle       facade and diagnostics
 |               |                |                   |
 +---------------+ narrow connected proof -----------+
                 |
 +---------------+----------------+-------------------+
 |               |                |                   |
Domain effects   Harness adapters Recovery/importer   Packaging/install proof
and PR lifecycle                  and claim repair
 +---------------+----------------+-------------------+
                 |
Exact-artifact release acceptance
```

Planning steps and existing issues:

1. Reconcile product-boundary issue `d6a74dc8…` and package-decision issue `bfb2f529…` around one distribution while preserving three package identities. Record Companion and harness scope. Rewrite the planning baseline before implementation; PR #564 remains historical until that occurs.
2. Reuse completed Contracts issue `4d41ffb7…` and freeze only real cross-boundary contracts: identities, authority request/decision, receipt claims, errors, lifecycle, monitor acknowledgment, capability negotiation, and setup/grant separation.
3. Run parallel foundations with explicit file ownership:
   - actor identity `7b60525b…` then authority/receipt work `85be2945…`;
   - Memory local assembly `12d92893…`;
   - Flow runner `1ff3d2f9…`;
   - facade/activation `5f4da13f…`;
   - Memory knowledge extraction can run separately from authority only after exact shared-file ownership is listed.
4. Stop at a consumer checkpoint: independent Memory, independent Flow, non-Flow receipt acceptance, and connected monitor delivery. Change the boundary here if these journeys fail; do not move many root commands first.
5. Then parallelize domain effects/PR lifecycle, four harness adapters, recovery/claim repair, and distribution/package completeness (`95372af8…`). `9e31a2f0…` remains a migration prerequisite; `f2a96ff1…` owns extraction/migration integration.
6. Keep hook control `7268bc9b…` and MCP control `9658c21a…` where required by supported routes. Scope the minimum setup collision/provenance work from `da760874…`; do not import its entire dependency tree automatically.
7. Release convergence issue `eb2f1753…` owns final exact-artifact evidence.

Shared Contracts, root assembly, package manifests, lockfiles and generated projections each need a single integration owner. Adapter lanes consume frozen interfaces and cannot independently redesign them.

## Decisive acceptance journeys

1. Complete installation stays inert while requesting help and using one pure capability: no unrelated process, file/store creation, credential read, network call, or provider initialization.
2. Memory works outside the repository without Flow/CLI/private broker: work/lease operations plus capture, recall and provenance survive restart.
3. Flow works outside the repository without Memory: bounded step, timeout/budget, cancellation, cleanup and truthful non-authoritative result.
4. Human, CI and custom-runtime receipt submissions are accepted only for authorized claims; forged, expired, wrong-project, stale-authority and duplicate submissions are handled correctly.
5. Knowledge supersession/forget/context works while an enrichment provider is missing or stale; projections cannot restore forbidden data or bypass scope.
6. Feedback intake respects consent and idempotency; derived insights do not become authorized work automatically.
7. An external effect is interrupted after it may have occurred but before acknowledgment; reconciliation prevents blind duplication and false terminal status.
8. Durable monitor crashes after event persistence but before delivery; restart replays without duplicate authoritative transition and preserves terminal state.
9. Every promised harness/version runs result, progress, approval and continuation scenarios; required unavailable controls block before effects.
10. The Forge reference setup and one materially different setup use the same public APIs; replacing a procedure/provider needs no core edit and cannot self-grant permission.
11. A pinned setup/integration runs offline; changed code digest and expanded permissions do not inherit the old grant silently.
12. Beads imports once and repeats safely without source mutation or live sync; native backup restore preserves authority and rejects stale post-restore leases/receipts.

## Main risks

1. Evidence laundering through generic receipts.
2. Duplicate or falsely classified external effects after uncertain outcomes.
3. Hidden activation and credential/network access during imports or discovery.
4. Setup updates expanding authority or overwriting user choices.
5. Release expansion disguised as extraction.
6. Moving code before public consumer journeys validate the boundary.

## Progress and evidence limits

Completed in this review:

- three bounded Luna research lanes: source/capability seams, live targeted issue graph, and value/security simplification;
- main convergence of saved research and corrections into `astra-architecture-review-input.md`;
- independent Astra analysis of product, distribution, capability groups, configuration, marketplace, security, harness delivery, release scope and PR sequencing;
- main review and the clarification on version-bounded first-party inclusion.

Still incomplete:

- user approval of this planning baseline;
- full classification of all relevant unfinished Kernel issues;
- exact file ownership for every proposed PR lane;
- runtime proof of the twelve acceptance journeys;
- revised official 0.1.0 plan/decision register and disposition of PR #564;
- decisions on Companion timing, OpenCode/Pi/DSH release scope, and release soak/count thresholds.

No code, repository docs, issue state, PR state, or release state changed in this review.
