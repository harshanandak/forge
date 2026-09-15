# Astra architecture validation log

Prepared 2026-09-15. This log records independent design reviews. A document-level PASS does not certify implementation, approve a release, or authorize repository, issue, or PR changes.

## Gate 1: initial distribution architecture

Verdict: revised after the user clarified the desired end state.

The initial review preserved Memory and Flow as permanent package boundaries. The user corrected that premise: Forge is one distribution organized by capability scopes; Memory and Flow are optional first-party presets. The original guidance is retained in `astra-architecture-guidance.md` and marked superseded.

## Gate 2: capability scopes with n8n and Kestra crosswalk

Verdict: REVISE.

Material findings:

- one-distribution wording was contradicted by a separate-install recommendation for heavy first-party integrations;
- the coded-adapter rule was broader than necessary;
- declarative effect-bearing definitions needed integration-level admission and grants;
- effective configuration revisions needed resolved implementation identities and explicit adoption/revocation behavior;
- receipt acceptance, persistence-before-delivery, unknown external effects and named harness evidence needed stronger invariants; and
- n8n/Kestra evidence needed to be separated from Forge-specific design requirements.

The requested corrections were applied to `capability-scope-architecture.md` and `n8n-kestra-architecture-comparison.md`.

## Gate 3: revised capability-scope baseline

Verdict: PASS.

Astra re-read both complete revised artifacts and found no material blockers for using them as the capability-to-issue planning baseline.

Passed checks:

- one distribution with demand-driven activation;
- bounded declarative executor and coded-adapter boundary;
- integration-level trust for declarative definitions;
- resolved configuration revision, preview, adoption and revocation;
- independent receipt authorization, scope, freshness and evidence checks;
- persistence before harness delivery and acknowledgment separated from completion;
- honest unknown outcomes and provider-aware reconciliation;
- executable evidence commitments for Claude, Codex, Cursor and Hermes;
- qualified n8n/Kestra attribution; and
- strengthened receipt, serialized-process, preset-update and packed-harness journeys.

Evidence level: document and tracked-source inspection, rung 2. No runtime certification was performed.

Remaining inputs for the next gate:

- exact public capability scopes after applying the independent-consumer test;
- temporary Memory/Flow package compatibility disposition;
- Companion and additional-harness release disposition; and
- capability-to-issue dependencies and conflict-free PR ownership.

## Gate 4: first capability-to-issue plan

Verdict: REVISE.

Material findings:

- seven public namespaces needed to be separated from providers, stores, grant categories and activation units;
- the static manifest mixed discovery with resolved configuration and blanket permissions;
- package retirement needed a completed consumer audit rather than an absence-of-evidence assumption;
- host configuration and composition ownership overlapped;
- issue recommendations lacked complete live-read provenance;
- Companion inclusion was ambiguous at the final release gate; and
- install, performance and removal gates needed executable wording.

The requested changes were applied to `capability-to-issue-plan.md`.

## Gate 5: revised capability-to-issue plan

Verdict: PASS.

Astra re-read the complete revised plan and found no material blockers to using it for issue reconciliation and construction of the final parallel PR plan.

Passed checks:

- seven namespaces with narrow domain semantics and independently selected providers;
- static manifest separated from resolved configuration and operation grants;
- audit-supported package retirement with preserved published artifacts;
- explicit DAG and semantic file ownership;
- live issue observation separated from recommended disposition;
- optional-to-activate Companion with mandatory conformance if included; and
- executable activation, performance, migration and removal gates.

Evidence level: document and recorded issue-snapshot inspection, rung 2. Astra did not independently refresh the Kernel and did not certify implementation.

## Gate 6: first final parallel-plan proposal

Verdict: REVISE.

Material findings:

- the packed connected checkpoint needed an explicit integration PR for shared indexes, registrations, projections and fixtures;
- harness implementation overlapped with hook/MCP ownership and needed ordered certification;
- recorded prerequisites had to survive until each requirement was mapped;
- the new architecture journeys had to supplement rather than replace the existing G0-G8 matrix; and
- expected rejection, timeout, cancellation and unknown outcomes had to pass assertions without being converted into successful operation receipts.

During revision, the user established Feedback as an independently usable builder capability. Luna mapped the existing implementation and issue evidence in `feedback-capability-research.md`.

## Gate 7: eight namespaces and corrected final PR train

Verdict: PASS.

Astra read the three complete revised plans and the Feedback source map. It found no material planning blockers.

Passed checks:

- Feedback satisfies the independent-consumer test and becomes `forge.feedback.v1` without another package, process or authority writer;
- 0.1.0 local/in-process Feedback semantics are separated from later hosted public ingress and abuse controls;
- accepted Feedback remains untrusted and cannot directly mutate authority, trusted Knowledge or configuration;
- PR-I provides the assembled packed checkpoint before boundary work;
- harness and control ownership is separate with ordered certification;
- preserved prerequisites are mapped before dispatch;
- fifteen journeys supplement G0-G8 and conditional declarative integration creates no speculative executor; and
- PR-N judges exact acceptance assertions, including deliberate negative and unknown outcomes.

Evidence level: complete document and tracked-source inspection, rung 2. This PASS does not certify implementation, privacy enforcement, adapters, migration or release readiness.

## Gate 8: Companion and Muse red-team adjudication

Verdict: REVISE.

Muse Spark 1.3 completed a Companion-routed xhigh architecture audit. DeepSeek 4.1 at max did not complete: the provider consistently returned HTTP 403 pending explicit regional opt-in, so no DeepSeek findings are represented. Astra independently checked the Muse candidates against tracked `origin/master` and the saved planning set.

Accepted planning corrections:

- Feedback redaction is bounded and host-established; policy identity cannot be supplied and self-confirmed by the caller;
- Feedback needs stable scoped idempotency, bounded acceptance, honest unknown outcomes, status reconciliation and an explicit durable-schema owner;
- restore must define how post-backup deletions and revocations are handled before exposure or delivery;
- consequential acceptance needs authority-owned time and current grant, lease and revision checks;
- overlapping preset options need deterministic explicit resolution and provenance;
- harness help probes are discovery evidence rather than behavioral certification; and
- generic recovery/drain and the complete current skill runtime need exclusive lane owners.

Rejected or bounded findings:

- no Contracts rename lane: tracked source already uses `packages/contracts`; only the stale ownership statement needs supersession;
- no second monitor engine: extract provider-neutral recovery from the existing outbox/cursor/redelivery path;
- no new Beads identity scheme: reuse and prove the existing import mapping;
- no arbitrary performance ceiling before baseline measurement; and
- no speculative network transport: select a bounded child-process stdio fixture under the existing serialized-boundary lane unless a suitable transport already exists.

Companion route behavior also becomes PR-K conformance input: worker lifetime across stdio caller exit, catalog-versus-execution availability, provider credential/terms reporting, read-only authorization behavior and foreground request budgets.

Evidence level: Companion execution receipts plus tracked-source/document inspection, rung 2. The corrected plan requires a final Astra recheck.

## Gate 9: corrected red-team baseline

Verdict: PASS.

Astra read the complete corrected final plan, the Companion red-team record and Gate 8. It found no remaining concrete planning blockers.

Passed checks:

- every material red-team correction is assigned to an existing semantic owner and acceptance journey;
- concrete file exclusions, shared schema/transaction contracts and prerequisite mapping remain mandatory before parallel dispatch;
- no new Contracts rename lane, monitor engine, Beads identity scheme, network service or arbitrary performance ceiling was introduced;
- the performance budgets and serialized transport remain bounded pre-implementation choices; and
- Companion's observed failures are conformance requirements rather than claims of readiness.

Evidence level: complete corrected documents and tracked-source adjudication, rung 2. This PASS approves the planning baseline only; it does not certify implementation or authorize issue, branch or PR changes.
