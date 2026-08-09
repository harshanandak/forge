# Forge 0.1.0 Restructuring Validation Matrix

**Status:** Approved normative companion to `plan.md`
**Principle:** one risk, one canonical owner test; higher-level journeys prove wiring, not every lower-level edge case.

## Gate classes

| Gate | Trigger | Required evidence | Failure behavior |
| --- | --- | --- | --- |
| G0 formatting/static | every changed source/doc/config | diff check, targeted lint/type/schema parse | Block PR |
| G1 risk selection | every PR | versioned risk-manifest digest, changed-surface map, selected lanes | Missing/ambiguous owner routes to conservative baseline; never targeted PASS |
| G2 package | product/package source change | canonical unit tests for changed package | Block PR |
| G3 contract | contract, boundary, provider, or cross-product change | canonical fixtures, forward/backward reader matrix, semantic idempotency/conflict cases | Block PR |
| G4 authority/security | issue, claim, lease, stage, gate, merge, protected state, auth | focused adversarial authority suite | Block; never quarantine |
| G5 migration/data | schema, storage, import/export, projection, package extraction/cutover | beta.5 corpus, dry-run, backup/restore, replay, interrupted migration, post-cutover-write resolution | Block; `INCOMPLETE` is not PASS |
| G6 platform | OS/runtime-sensitive path | owning package + affected OS/runtime baseline | Block affected lane; broad unaffected matrix stays scheduled |
| G7 journey | adapter/facade/integration change | one representative end-to-end journey per changed route | Block changed route |
| G8 release | one settled RC BOM | complete exact-artifact/exact-SHA matrix | Block release only; never rerun unchanged candidate |

## Conservative selection default

The selector output and risk-manifest digest are stored in the WorkPacket and RunReceipt.

The canonical source is `validation/risk-manifest.source.yaml`; `scripts/generate-risk-manifest.js` deterministically produces `validation/risk-manifest.v1.json`. The generated manifest has `schema_id`, integer `revision`, `source_hash`, `generator_version`, `risks`, and `owners`. Every risk contains stable id, severity, non-quarantinable flag, and gate ids. Every owner contains non-overlapping path/command/schema selectors, product, package, owned risk ids, canonical test ids, dependent routes, and platform/runtime additions. The manifest declares the unknown-owner fallback as the repository baseline. Generation contains no timestamp or host data; rerunning at the same source SHA must be byte-identical.

G1 verifies that every tracked production path, public command, contract schema, migration, and generated projection resolves to exactly one canonical owner; overlaps and gaps fail. The selected manifest revision, digest, matched selectors, changed surfaces, required gates, and test ids are persisted in both WorkPacket and RunReceipt.

- Exact mapping: run the mapped canonical owner plus required dependent gates.
- Package known, risk ambiguous: run package + contract + affected-platform baseline.
- Package unknown: run repository baseline and block targeted selection until ownership is added.
- Security, authority, migration, data integrity, stale head, and protected state always add their dedicated gate.
- A failed or incomplete broad run may be retried only when the receipt identifies environmental/incomplete evidence; an unchanged complete failure is diagnosed, not blindly rerun.

## PR matrix

| PR | Always required | Conditional | Explicitly deferred |
| --- | --- | --- | --- |
| 1 Control-plane trust/fast validation | G0, G1, G4; selector self-tests; claim projection reconciliation; beta.5 corpus hash | G6 Windows claim/process cases; release workflow fixture | Full product/repository matrix |
| 2 Contracts/package boundaries | G0–G3; forbidden-private-import scan; facade routing ledger completeness | G7 portable packet→receipt smoke | Storage migration and live provider calls |
| 3 Memory foundation | G0–G5 for Memory; Kernel conformance; memory recall; backup/restore unit corpus; feedback consent/redaction/idempotency; triage cadence and authority | G6 Windows/Linux SQLite; inbound Beads fixture | Flow/Shepherd matrix |
| 4A Flow core, skills, and observers | G0–G4 for Flow core; fake MemoryProvider; generic monitor closure; skill/orchestrator fixtures; EfficiencySupervisor 20/30/35/39 budget cases | G6 process/platform; portable packet→receipt journey | Shepherd/review semantics, Memory storage edges, and live model waits |
| 4B Shepherd, review, merge, and handoff | G0–G4 for current-head verdicts, ancestry, threads, watcher lifecycle, and post-merge receipt handoff; fake review providers | G6 process/platform; G7 PR adapter journey | Memory storage edges and live bot wait loops |
| 5 Facade/harness/capabilities | G0–G3, G7; CLI/JSON/exit snapshots; command ownership; manifest-driven Doctor coverage parity; doctor schema/redaction/no-side-effect/deadline fixtures; harness projection parity; version-bound native monitor/cancel/resume/cleanup probes | G6 installed binary smoke for Claude, Codex, Cursor, and Hermes plus cross-platform Doctor fixtures | Full migration replay |
| 6 Migration/extraction readiness | G0–G7; beta.5 clean upgrade, interrupted migration, cutover, rollback, release BOM, sparse standalone package builds, forbidden-private-import scan | package-registry prerelease canary | Physical repository separation and stable promotion |
| 7 Release convergence | G0, docs/drift/disposition verification; candidate-generation reproducibility | affected gate for any correction | Product behavior changes |

## Developer and PR budgets

| Lane | Budget | Output returned to model |
| --- | ---: | --- |
| Focused RED/GREEN | 60 seconds typical | failing assertion and bounded context only |
| Changed package | 5 minutes | counts, slowest owners, failures |
| Cross-product contract | 8 minutes | fixture/gate summary and conflicts |
| Affected platform | 12 minutes | platform delta and receipt link |
| Scheduled compatibility | not PR-blocking unless affected | artifact link and tri-state result |
| RC matrix | 30-minute target | BOM, exact SHA, per-lane receipts, aggregate tri-state |

Raw logs remain local-sensitive artifacts by default. They are never streamed wholesale into model context.

## Exact RC matrix

The matrix consumes one signed release BOM and proves:

- Ubuntu, macOS, Windows;
- Node 22 and 24;
- Memory-only, Flow stateless, Flow connected, and facade installations;
- Claude, Codex, Cursor, and Hermes projections;
- current beta.5 binaries/config/JSON/database upgrade;
- dry-run, backup, cutover, interrupted migration, post-cutover-write handling, and rollback;
- packet/receipt schema forward/backward compatibility;
- claim/lease/workflow/gate/merge authority;
- shared monitor-engine streaming, durable-before-delivery ordering, at-least-once retry with idempotent cursor acknowledgement, cancellation, timeout, crash recovery, reaping, and terminal cleanup receipts;
- session/run/subject lifetime fixtures proving session closure and durable run/subject continuation after initiating-session loss;
- installed-harness capability probes and truthful T0-T4 degradation for native live delivery, next-turn injection, wake/resume, user notification, cancellation, and cleanup;
- reducer fixtures proving unchanged observations and duplicate or oscillating raw events consume no model turn and emit only bounded actionable transitions;
- consent-gated feedback with no identity/device leakage or client model-token use, plus event-driven triage receipts;
- package contents, integrity, provenance, OIDC, dist-tags, and facade lockfile;
- one sequential merge-train simulation on exact heads.

Every lane returns `PASS`, `FAIL`, or `INCOMPLETE`. Missing receipts, wrong BOM artifacts, stale heads, timeout, truncation, or non-reconstructable evidence are `INCOMPLETE`.

## Release evidence semantics

Release journeys are versioned data under `validation/journeys/v1/`; each immutable YAML case declares `journey_id`, risk ids, fixture digest, product mode, platform/runtime requirements, ordered commands/actions, expected contract transitions, cleanup assertions, and severity on violation. The beta.5 compatibility corpus and journey index are content-hashed in the release BOM.

A **clean journey** means one distinct indexed journey executed against one exact BOM/environment where every required step and receipt is `PASS`, no required step is skipped or `INCOMPLETE`, all expected state transitions are accepted at the declared revision, no unauthorized mutation occurs, and every process/monitor/lease closes. Repeating the same journey id on the same BOM/environment does not increase the clean count. A failed attempt remains in evidence; a later correction requires a new BOM or an explicitly environmental `INCOMPLETE` receipt.

`release/severity-policy.v1.json` maps risk ids to severity. S0 is any security compromise, unauthorized authority mutation, acknowledged data loss, irrecoverable rollback, false `PASS`, or untrusted artifact. S1 is a broken supported install/upgrade/runtime path, deterministic crash, contract incompatibility, migration mismatch, or required platform/harness failure without data/authority compromise. Severity is derived from the violated risk id and cannot be downgraded without a signed approval receipt naming the evidence and rationale.

`forge release aggregate-evidence --bom <path>` deterministically writes canonical `release-evidence.v1.json` containing BOM/policy/corpus digests, distinct journey ids and environments, per-gate tri-state receipts, coverage by required risk stratum, open S0/S1 ids, observation-window events, retries, and aggregate status. Beta.6 requires at least 10 distinct clean synthetic journey ids. Beta.7 requires at least 25 clean canary journey/environment pairs covering every required platform/mode stratum and 72 continuous hours without a new S0/S1 event. RC requires at least 50 such pairs, every G0–G8 lane, and seven cumulative automated observation days. Missing strata, unverifiable time/events, stale BOM inputs, or an unresolved S0/S1 produce `INCOMPLETE` or `FAIL`, never release eligibility.

## Test reduction evidence

Removing or consolidating a test requires a ledger row with:

```text
old_test
risk_owned
replacement_test
equivalence_or_stronger_reason
before_runtime
after_runtime
owner
expiry_or_follow_up
```

No test-count target exists. The objective is complete unique-risk coverage inside the feedback budgets.
