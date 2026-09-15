# Forge 0.1.0 final parallel-plan proposal

Prepared 2026-09-15. Status: Astra final planning gate PASS at document/source-evidence rung 2 after Companion/Muse red-team corrections; ready for user adoption as the 0.1.0 planning baseline. This document names proposed PR lanes; it does not create branches, worktrees, issues or pull requests. Evidence baseline is `origin/master` at `dbb91e94b5af4f53cd0e2de127753cccd0ef974c`, the live Kernel snapshot recorded at `2026-09-15T02:20:52+05:30`, and the Feedback issue refresh at `2026-09-15T02:33:45+05:30` in `capability-to-issue-plan.md`.

## Release model

Forge 0.1.0 is one supported distribution with eight public capability namespaces:

```text
authority | knowledge | evidence | feedback
execution | monitoring | integration | composition
```

These are API namespaces, not packages, processes, stores, writers or indivisible activation units. The approximately 24 researched capability families become operations and internal modules beneath these namespaces unless an independent consumer later proves the need for another top-level scope.

`@forge/contracts` remains independently publishable. Memory and Flow become optional first-party presets. The reference Forge workflow becomes another optional preset. No preset owns authority, state, grants, providers or processes.

The release distribution includes supported first-party implementations and adapters. They remain inactive until requested. External harness executables, applications and services are explicit prerequisites. Configuration selects behavior; it cannot grant itself authority or invent lifecycle semantics.

## Decisions to freeze

1. Adopt the eight public namespaces as the initial 0.1.0 API organization. Operations may still be independently selected and provided within a namespace. Feedback is separate because builders can use consent-bound product feedback intake without adopting the Forge workflow or either preset.
2. Publish one Forge distribution plus independent Contracts. Stop treating Memory and Flow as permanent packages. Complete the bounded consumer audit before deciding whether identified consumers require temporary forwarding packages for one migration window.
3. Target the Companion adapter for 0.1.0 as optional to activate. If it remains included at feature freeze, its conformance is a required release gate; failure requires an explicit scope decision rather than an unavailable advertised adapter.
4. Keep Claude, Codex, Cursor and Hermes as mandatory certified 0.1.0 harness routes. OpenCode, Pi and DeepSeek Harness remain later unless separately promoted with executable evidence.
5. Keep Beads as one-way import only. Kernel-native backup/restore owns recovery. No live Beads backend, export, synchronization or authority surface ships.
6. Resolve overlapping preset options deterministically: bare defaults are lowest priority; identical values coalesce; differing values require an explicit user choice; a valid user choice wins within the published schema; policy may still reject it. Arrays combine only when the option schema explicitly defines combination. Preview shows provenance, and preset order cannot silently change the result.
7. Treat Feedback redaction as bounded protection under a host-approved policy. The host selects and applies the policy, binds its actual identity and revision to the payload, and rejects forged or unsupported assertions. Feedback acceptance uses caller-stable submission identity, scoped idempotency, bounded waiting, an honest `unknown` result after an uncertain commit, and status reconciliation.
8. Use authority-owned time for consequential acceptance. Producer timestamps are evidence, not proof of present authorization; current grant, lease and revision checks decide authority. Local deadlines use monotonic elapsed time and define clock rollback/skew behavior. Historical evidence may remain retainable without authorizing a current transition.
9. Treat help/version probes as discovery evidence only. Every advertised execution, control, cleanup, continuation and delivery guarantee requires a bounded behavioral fixture.
10. Restore integrity and privacy are separate proofs. Recovery must account for retained post-backup deletions and revocations before restored data is exposed or delivered; if newer lifecycle evidence is unavailable, recovery reports the limitation and requires an explicit decision. Restored Feedback is never automatically resent.

## Included in 0.1.0

- one packed Forge distribution and neutral Contracts library;
- eight documented public namespaces and operation contracts;
- demand-driven activation and bounded disposal;
- deterministic effective configuration revisions, preview and authorized adoption;
- Memory, Flow and reference-workflow presets;
- one authority writer per authority scope with leases, fencing and receipt acceptance;
- knowledge, provenance, evidence and lifecycle APIs;
- local/in-process Feedback preview, consent, redaction, scoped submission, idempotent durable acceptance, status and lifecycle APIs;
- execution, process control, bounded loops and monitoring APIs;
- durable observation with persistence-before-delivery and replay;
- authorized multi-producer receipts, including non-Flow producers;
- typed integration admission for declarative definitions and coded adapters;
- Claude, Codex, Cursor and Hermes capability and delivery evidence;
- Companion adapter conformance if retained in the distribution;
- honest required-capability rejection and visible allowed fallback;
- hook and MCP consent/drift behavior aligned with actual harness enforcement;
- claim reconciliation, additive migration, one-way Beads import and native recovery;
- packed external-consumer, migration, crash/replay, security, stability and performance evidence.

## Deferred beyond 0.1.0

- hosted Forge authority/control plane;
- hosted marketplace, publisher accounts and managed updates;
- broad community executable-integration admission or sandbox claims;
- OpenCode, Pi and DeepSeek Harness certification;
- visual workflow/setup editor;
- general-purpose integration mapping language;
- distributed queue or mandatory remote service;
- automatic provider selection, vector memory and new graph/enrichment providers;
- richer evaluation analytics and marketplace discovery/ranking.
- hosted public Feedback endpoints, tenant service, network ingress controls, abuse moderation, remote attachment scanning and public status delivery.

## Explicitly dropped

- Memory and Flow as permanent product, package, state or authority boundaries;
- a package, process, database, daemon or release train for every inventory family;
- mandatory Forge workflow stages in the bare product;
- preset-owned authority or configuration that self-grants permission;
- Flow-only receipt authority;
- live Beads compatibility;
- silent activation, permission expansion, setup overwrite or fallback;
- a second orchestration engine, policy engine, provider registry or generic event bus.

## Issue reconciliation before code work

No new issue is required for the package decision. Use the existing records:

1. Keep product architecture (`d6a74dc8-10f7-4be9-9761-2467c3df4798`) as the P0 parent.
2. Rewrite distribution/preset decision (`bfb2f529-21c2-42c6-a00e-0cf3bf36eded`) as its single decision child. Preserve its role as a dependency-free decision gate.
3. Reframe Memory assembly (`12d92893-19a9-45b2-9c84-00891a82cff0`) around knowledge/authority/evidence/feedback/monitoring journeys and the Memory preset.
4. Split Feedback contract (`0f6ce951-2493-4c08-ac61-2a158b363a79`) into the 0.1.0 local transport-neutral namespace/envelope and the later hosted HTTPS/public-ingress work retained under cloud parent `518e49a3-d47c-4616-8ab5-f41dd08d060e`.
5. Reframe Flow runner (`1ff3d2f9-22c3-403c-a700-18aa18762093`) around execution/monitoring/composition journeys and the Flow preset.
6. Update distribution completeness (`95372af8-da00-42e0-af64-0111ddab3405`) to consume `@forge/contracts` and own all root packaging surfaces.
7. Keep capability facade (`5f4da13f-a813-4e91-a4f8-806755384f31`) as the host activation/configuration owner.
8. Preserve all four migration dependencies on `f2a96ff1-d238-4341-8d14-ef45d08d4b43` and all three final-release dependencies on `eb2f1753-e84e-40bb-aec8-8233fc348322`.
9. Narrow harness delivery (`a5101337-0afb-4322-b823-8dca531b4f81`) to the durable return floor, four named adapters, capability matrix and fallback semantics. Moving dashboard or historical work does not remove its recorded prerequisite until reconciliation maps that requirement to a verified replacement.
10. Keep actor/run identity (`7b60525b-a1e2-4c94-a6b4-81fa76459a24`) before run/receipt authority (`85be2945-ab34-4e3c-abd3-893ee7ea3b4e`) and preserve the actor/run issue's three upstream dependencies until reconciled.
11. Keep Companion bridge (`8d14651d-03a6-4727-8204-2a05ad7fb280`) downstream of its existing five dependencies. Do not make the external runtime a hidden core dependency.

All recorded prerequisite edges remain in force until issue reconciliation maps their applicable requirements to a verified replacement. Narrowing an issue or moving dashboard/history work does not itself remove a dependency. Before PR-A is dispatched, map every included unresolved prerequisite to an owning lane, an already satisfied prerequisite, or an explicit scope decision. Add the resulting edges to the PR graph.

Create only two missing child records if existing issue bodies cannot own these acceptance criteria cleanly:

- monitoring namespace and durable-observation ownership; and
- admitted integration/setup artifact semantics, including the separation of ordinary setups from effect-bearing declarative definitions.

The compatibility audit, performance baseline and capability-scope inventory are acceptance tasks under the distribution/preset and distribution-completeness issues, not new epics.

## Planned PR train

The labels below are planning labels, not existing pull-request numbers.

| Lane | Scope and issue owners | Depends on | Exclusive file responsibility | Exit proof |
|---|---|---|---|---|
| PR-A Contracts and namespace freeze | current `@forge/contracts` boundary; actor/run, receipt and Feedback envelope owners; supersede the stale decision that assigns Contracts governance to Memory | Decisions and recorded prerequisite map frozen | `packages/contracts/**` and contract fixtures only | eight namespaces, authority-time fields and cross-boundary envelopes validate; no authority/runtime code |
| PR-B Host, activation and initial distribution | distribution completeness + capability facade | PR-A | root manifests, workspace metadata, lockfile, `bin/forge.js`, command/facade registry, activation/config resolution and initial packed-install fixtures | inert install/import/help; deterministic option merge, provenance preview, adoption/revision and reorder-invariance proof; host usable from a packed consumer |
| PR-C Authority and receipts | architecture parent + actor/run + receipt authority; shared migration registry/driver/transaction infrastructure | PR-A plus reconciled actor/run prerequisites | Kernel transactions, authorization, authority-owned time, leases/fencing, receipt acceptance and PR authority | authorized multi-producer receipt journey; wrong-scope/current-grant/stale/evidence/replay and clock-skew rejection |
| PR-D Knowledge and evidence | reframed Memory assembly + existing backend/projection work | PR-A | knowledge, provenance, lifecycle, usage/evaluation domain operations and persistence; excludes Feedback implementation files | knowledge-only journey without execution/harness activation; retention/redaction/provenance proof |
| PR-E Feedback | Feedback contract issue + completed intake implementation evidence | PR-A; consumes PR-C's shared transaction/migration interfaces without editing their owner files | Feedback-specific schema/store semantics and fixtures; report/submission envelopes, host-approved redaction policy, consent, stable idempotency, bounded acceptance, `unknown` reconciliation, status, export/delete and rollback; no hosted transport and no PR-D persistence files | preset-independent builder journey; forged policy assertions fail; uncertain commits reconcile safely; accepted input remains untrusted; delivery failure remains separate |
| PR-F Execution | reframed Flow runner | PR-A | execution provider, bounded loops, all of `packages/flow/src/skill-runtime.js`, handler/skill execution, process lifecycle and supervision | execution-only journey without either preset; truthful cancel/control/result semantics |
| PR-G Monitoring | monitoring owner | PR-A | pure reduction/control plus provider-neutral recovery/drain extracted from the existing event, cursor, outbox and delivery-state mechanisms | append-before-delivery and delivery-before-ack crash/replay; at-least-once external delivery with idempotent state handling; no duplicate engine, writer or watcher |
| PR-H Composition and presets | distribution/preset decision + setup ownership | PR-A; consumes frozen host contract | preset definitions and workflow composition only; no host config-resolution files | Memory, Flow and custom preset overlap without duplicate resources; no mandatory workflow |
| PR-I Assembled connected checkpoint | distribution owner | combined PR-B through PR-H head | package indexes, required shared manifests/registrations, generated projections, a bounded child-process stdio conformance transport unless a suitable existing transport is selected, and acceptance fixtures; implementation defects return to semantic owners | assembled eight-namespace packed artifact passes independent and composed consumer journeys, including framed/bounded output, cancellation and termination across the serialized boundary |
| PR-J Four harness routes | narrowed harness delivery | PR-I plus reconciled harness prerequisite; final certification/merge after any PR-L controls it claims | harness adapters, discovery probes, delivery behavior and behavioral capability fixtures only | Claude/Codex/Cursor/Hermes bounded execution/control evidence; help probes count only as discovery; required route rejects before effects; allowed fallback visible |
| PR-K Companion adapter | Companion bridge | PR-I plus all five recorded Companion dependencies | Forge-side Companion adapter and conformance fixtures only; no Companion source copied into domain modules | optional activation; survives caller/server lifetime boundaries as promised; foreground deadlines exceed worker budgets safely; catalog availability matches execution; read-only provider authorization is truthful; missing credentials/terms fail explicitly; conformance or explicit scope removal decision |
| PR-L Git/CI/PR and setup controls | hook controls + MCP controls + bounded skill collision work | PR-I plus reconciled recorded prerequisites | Git/CI effect integrations, hooks, MCP rendering/consent and skill identity/projection; no harness adapter files and no edits to `packages/flow/src/skill-runtime.js` | narrow effects; projections satisfy the frozen PR-F interface; grants bound to identity/digest/destination; no observational enforcement claim |
| PR-M Migration, package transition and recovery | claim reconciliation -> migration/recovery | PR-I; claim repair first; preserve four recorded migration dependencies | migrations, import, recovery, privacy-lifecycle restoration and forwarding implementation; root package/export removal remains with distribution owner | consumer audit result; tested migration; existing Beads ID/dependency/event mapping reused and collision/re-import proved; one-way import; native restore reapplies available post-backup deletion/revocation evidence before exposure and never auto-resends Feedback; rollback |
| PR-N Final distribution and release evidence | final release convergence | every included boundary lane and preserved final dependencies | final root assembly only by the PR-B/PR-I distribution owner; release docs/evidence matrix | every required acceptance check passes on the exact artifact. Deliberately induced rejection, timeout, cancellation or unknown outcomes pass only when handling matches the asserted contract; no required verification remains pending or uncertified |

PR-B through PR-H may develop in parallel after PR-A and prerequisite reconciliation because semantic file ownership is separate. PR-I is the explicit assembled integration point and waits for all seven lanes. PR-J through PR-M may develop concurrently from PR-I, but proof and merge remain ordered: PR-L lands before final PR-J certification when harness evidence exercises those controls; claim reconciliation lands before PR-M migration/cutover. PR-N waits for every included boundary lane, the distribution assembly and the preserved final-release dependencies. Before worktrees are assigned, each semantic owner records concrete file inclusions and exclusions; this table alone does not prove historical files are disjoint.

If historical file placement creates a collision, semantic ownership wins. A worker must ask the semantic owner to make the change rather than editing across lanes. Package indexes and generated projections are updated once by the distribution/integration owner after domain code lands.

## Branch and merge procedure

1. Merge PR-A before cutting implementation worktrees.
2. Cut PR-B through PR-H from the same exact post-PR-A base after mapping every preserved prerequisite.
3. Give each lane one issue owner, one worktree and the exclusive file list above.
4. Domain PRs expose their behavior behind the frozen contracts without changing root packaging.
5. Merge the parallel lanes sequentially after each rebases onto the current integration head and reruns its focused proof. Root/shared files remain with PR-B.
6. Create PR-I from the combined PR-B-through-PR-H head. The distribution owner lands shared indexes, registrations, generated projections and packed acceptance fixtures there. Do not start boundary lanes from individual domain heads.
7. Cut PR-J through PR-M from the exact merged PR-I head.
8. Develop boundary lanes concurrently where their concrete file maps permit it. Land PR-L controls before final PR-J harness certification when those controls are claimed, and land claim reconciliation before PR-M migration/cutover. Merge each included lane with refreshed exact-head evidence.
9. PR-N builds and validates the exact packed artifact. Deliberately induced rejection, timeout, cancellation or unknown outcomes pass only when their handling matches the asserted contract; no required verification may remain pending or uncertified.

## Required 0.1.0 journeys

These journeys supplement the existing G0-G8 validation matrix; they do not silently replace it. Before implementation, reconcile the matrix's supported OS/Node combinations, migration/recovery, compatibility/security, artifact integrity/provenance and observation requirements against this scope. Any changed count, duration or requirement receives an explicit disposition.

1. Clean installation and root discovery activate no unrelated capability or resource.
2. Knowledge-only consumer runs without execution, workflow, credentials or harness resources.
3. Feedback-only builder previews and submits consent-bound input with explicit project and endpoint scope, host-selected bounded redaction, adversarial secret-pattern fixtures, bounded artifact references and idempotent durable acceptance. Forged policy identity fails; an uncertain commit returns `unknown` and reconciles by stable submission identity. Delivery status is separate, and accepted feedback cannot mutate authority, trusted Knowledge or configuration.
4. Execution-only consumer runs without Memory/Flow presets or mandatory durable authority.
5. Authorized non-Flow producer submits a receipt; unauthorized, wrong-scope, stale, expired/current-grant-invalid and insufficient claims fail under authority-owned time; clock rollback/skew cannot make producer time authoritative; replay is idempotent.
6. Memory, Flow and independently written presets compose without private imports, duplicate stores, writers, watchers or delivery workers. Conflicting options require explicit resolution, previews show provenance, and preset reordering cannot silently change behavior.
7. Configuration preview is inert; adoption binds a resolved revision; updated implementation content cannot inherit inappropriate grants; revocation blocks later consequential actions.
8. If a concrete declarative integration is included, it and a coded integration expose equivalent domain contracts where the shared executor truthfully supports the declarative semantics. Otherwise record explicit deferral and do not build a mapping executor solely to satisfy this journey.
9. Lost response after a possible consequential effect yields unknown and safe provider-aware reconciliation.
10. Durable monitor state commits before delivery; append-before-delivery and delivery-before-ack crashes replay safely and preserve order. External delivery is at-least-once, duplicate effects are reconciled through idempotent identities, and acknowledgment never becomes completion.
11. The same representative operation crosses the selected child-process stdio or equivalent existing serialized boundary with framed and bounded output plus equivalent identity, result, error, deadline, cancellation, termination and artifact-integrity semantics.
12. Claude, Codex, Cursor and Hermes pass bounded behavioral fixtures for every advertised execution, control, cleanup, continuation and delivery capability; help/version output proves discovery only; missing required behavior rejects before effects.
13. Companion passes its advertised optional integration journeys if included: a supported background job survives the documented caller lifetime, foreground request deadlines safely exceed worker budgets, catalog-listed models execute or report an explicit availability reason, read-only execution does not erase required provider authorization, and missing credentials or regional terms fail clearly. Core and four-harness paths work without an undeclared Companion dependency.
14. One-way Beads import reuses and proves the existing issue/dependency/event mapping and leaves no post-import runtime dependency. Native recovery verifies snapshot integrity, reapplies available post-backup deletion/revocation evidence before exposure, reports when that evidence is unavailable, requires the specified explicit decision, never automatically resends restored Feedback, and supports rollback.
15. Packed Forge installs and runs from a clean external directory with no unresolved workspace dependency or private source import.

## Stability and performance plan

Record baseline machine, OS, runtime version, repository fixture and sample size before implementation. Measure the exact same conditions on the final packed artifact.

Required measurements:

- cold `forge --help` and representative command startup;
- root-import module count and filesystem touches;
- peak process memory before and after capability activation;
- activation latency for knowledge, execution and a harness adapter;
- SQLite transaction latency and write amplification for authority/evidence/monitor events;
- watcher, subprocess and database-handle counts for overlapping presets;
- packed artifact size and installed dependency count; and
- crash/replay recovery time for monitoring and unknown-effect reconciliation.

Freeze relative regression thresholds and absolute cold-help/import budgets for each agreed reference environment from the baseline before implementation starts. Do not invent architecture-wide numbers before measuring the reference environments. Optimize only measured regressions. Prefer deleting eager imports, duplicate registries, duplicate writers and no-op configuration before adding caches, worker pools or concurrency.

Stability hard gates:

- no authority transition from format validity alone;
- no required-capability fallback after consequential effects begin;
- no blind retry after an unknown external outcome;
- no preset or integration can self-grant authority;
- no accepted Feedback submission directly creates authority state, trusted Knowledge or configuration;
- no delivery acknowledgment substitutes for approval or completion;
- no legacy removal without verified replacement or approved retirement, tested migration and available recovery; and
- no release completion while any required result is pending, unknown, timed out, unavailable or uncertified.

## Cloud and marketplace continuation

The 0.1.0 APIs carry explicit actor/project scope, operation identity, deadlines, idempotency, authority/configuration revisions and integrity-bound artifact references. Representative operations cross a serialized process boundary. This preserves a later cloud implementation without making a network hop mandatory locally.

The 0.1.0 artifact model supports pinned setups and admitted integrations offline. A later marketplace may distribute both, but setup admission and executable/effect-bearing integration admission remain separate. Hosted discovery, publisher identity, managed updates, revocation distribution and community security review begin only after the local artifact and compatibility model passes.

The 0.1.0 Feedback namespace remains local/in-process and transport-neutral. A later hosted adapter can expose revocable project endpoints and public URLs with server-resolved tenant scope, signed admission, rate and abuse controls, moderation/quarantine, remote artifact scanning, server-side re-redaction, retention enforcement and status reconciliation. Caller-provided tenant identity never selects another project's destination.

## Remaining user decisions

- **A — Adopt eight namespaces and this PR train (recommended).**
- **B — Change the namespace grouping before issue reconciliation.**
- **C — Exclude Companion from the 0.1.0 target now; keep its adapter after the release.**

Default: A. Under A, Companion remains targeted for 0.1.0 and required to pass if it stays in the distribution at feature freeze.
