# Forge 0.1.0 Product Restructuring

**Status:** Approved development plan; implementation is gated by §9 admission evidence
**Date:** 2026-08-09
**Epic:** `d6a74dc8-10f7-4be9-9761-2467c3df4798`
**Classification:** Critical architecture and migration
**Target release:** `0.1.0`
**Rollback baseline:** `v0.1.0-beta.5` at `ebeb4e5b31fc2dacdf23c5936c02fb2656990f49`

**Normative companions:**

- [decision-register.md](./decision-register.md)
- [facade-routing.md](./facade-routing.md)
- [validation-matrix.md](./validation-matrix.md)
- [issue-disposition.md](./issue-disposition.md)
- [acceptance-contracts.md](./acceptance-contracts.md)

**Advisory research evidence:**

- [external-market-architecture-research.md](./external-market-architecture-research.md) — Parallel `pro-fast` multi-source report
- [external-execution-convergence.md](./external-execution-convergence.md) — chained repository/PR decision memo

Research provenance: Parallel runs `trun_11201b6ad6384421837b2856e54a3dfc` and `trun_e8b40fe698564653848a39c49e5d11db`; Context7 lookups for the Temporal TypeScript SDK, LangGraph JavaScript persistence, and Sigstore verification; official product documentation and version-bound local CLI probes. The external reports are advisory inputs, not release authority.

## 1. Executive decision

Forge 0.1.0 will stop being one undifferentiated workflow package and become three independently evolvable product surfaces:

1. **Forge Memory** — the durable foundation. It owns the Forge Kernel, issue/workflow/run authority, memory, context assembly, claims and leases, evidence, migrations, and the canonical packet/receipt contracts.
2. **Forge Flow** — an optional executor. It owns execution planning, harness routing, runtime monitoring, Git/CI integration, review and merge orchestration, and process lifecycle.
3. **Forge** — a thin compatibility and integration facade. It preserves the existing `forge` experience while routing commands to Memory or Flow. It owns no durable product state.

The architecture is intentionally asymmetric. Memory defines durable intent and evidence; Flow consumes that intent and returns evidence. There is no neutral third protocol product and no direct Flow dependency on Memory storage or server implementation.

This decision is the recommended default and remains the first user-approval checkpoint before implementation.

## 2. Decisions already locked

- `0.1.0` is the restructuring release, not a quick stable promotion of the beta.5 monolith.
- Beta.5 remains immutable and is the rollback baseline.
- Delivery uses several large cohesive PRs, not one mega-PR and not dozens of tiny PRs.
- Independent branches may be prepared in parallel only when file and product ownership do not overlap.
- The merge train is sequential and exact-head guarded.
- Per-PR validation is targeted and risk-owned. The full compatibility matrix runs once on the settled release SHA.
- Unrelated defects remain separate issues and PRs, even when discovered during restructuring.
- Test quality is measured by distinct risks covered, not raw test count.

## 3. Evidence baseline

### 3.1 Current product coupling

- The root package is `forge-workflow@0.1.0-beta.5` and exposes `forge`, `forge-workflow`, and `forge-preflight` binaries.
- The only separately packaged workspace is `@forge/skills@1.0.0`.
- No existing `WorkPacket`, `ContextPacket`, or `RunReceipt` implementation exists. These are new contracts.
- Memory currently reaches directly into Kernel broker, database, schema, and FTS5 implementation.
- The SQLite driver mixes issue/run authority and memory projection concerns.
- Shepherd, PR monitoring, review, merge rules, GitHub adapters, and process watching form a natural Flow extraction seam.
- `bin/forge.js` and `bin/forge-cmd.js` currently act as monolithic composition roots rather than thin routers.

### 3.2 Validation burden

The current tree has approximately:

- 558 test files;
- 6,091 `test`/`it` cases;
- 1,265 `describe` blocks;
- six full-matrix copies of `test/` across three operating systems and two Node versions;
- a separate four-shard unit lane, coverage lane, and additional integration workflows.

Five retained JUnit files contained 3,953 suite entries and 2,736 cumulative suite-seconds. This is enough duplication and host-contention exposure to make validation architecture a release workstream.

### 3.3 Backlog and control-plane state

Latest audited snapshot:

- 1,168 total issues;
- 522 open or in progress;
- 427 open/in-progress issues without acceptance criteria;
- 382 stale open issues at the 14-day threshold;
- zero missing dependency targets and zero dependency cycles;
- contradictory claim projections: 121 `claimed_by` fields, 53 live claim rows, 47 rows attached to done/cancelled work, and 16 open issues with `claimed_by` but no live row.

The backlog cannot be migrated or released by current labels alone.

### 3.4 External architecture and market evidence

External evidence supports the asymmetric Memory/Flow boundary but changes two delivery assumptions. Durable agent/workflow systems separate accepted long-term facts from execution checkpoints and non-deterministic activities. LangGraph distinguishes thread-scoped checkpoints from cross-thread stores; Temporal keeps filesystem/network work outside deterministic workflow code. Memory therefore owns accepted durable facts, while Flow owns ephemeral execution/checkpoints until Memory accepts a receipt. Sources: [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) and [Temporal TypeScript determinism](https://docs.temporal.io/develop/typescript/core-application#develop-workflows).

MCP, A2A, and AG-UI are interoperability edges, not substitutes for Forge's domain model. Their adapters may translate tools, agent messages, and UI events, but canonical intent, authority, idempotency, and evidence remain the Memory-owned packet and receipt contracts. This keeps standards adoption replaceable and prevents an external transport from becoming a second source of truth.

The strongest red-team finding is premature physical repository separation. Independent packages, APIs, CI lanes, versions, and release permissions can be proven in one repository. Splitting before compatibility and failure-injection evidence creates a distributed monolith and coordinated release burden. The 0.1.0 target is therefore an extraction-ready modular monolith; physical repository separation is a later evidence-gated option, not an RC requirement.

PR size is governed by **conceptual surface and rollback difficulty**, not line count. Small seam changes and medium vertical slices are easier to review; a large PR is accepted only for behavior-neutral mechanical movement, generated artifacts, or an atomic cutover that cannot safely land partially. The train keeps seven milestones but uses eight PRs by splitting Flow core from Shepherd/review/merge semantics.

Current harness evidence (observed 2026-08-09) is deliberately surface-specific:

| Harness/product | Live local evidence | Official native capability evidence | Forge planning conclusion |
| --- | --- | --- | --- |
| Claude Code | v2.1.226; CLI exposes background/cloud sessions, resume, and stream JSON | `/loop`, session tasks, agent view, and Monitor streaming are documented; cloud/desktop scheduling have different persistence | Prefer native Monitor/background adapter when the version-bound probe passes; preserve session expiry/cancel semantics |
| Codex | CLI 0.147.0 exposes resume, fork, and cloud task browsing | Codex app Automations run scheduled background workflows into a review queue; current product material describes wake/continuation | Do not equate app Automation with CLI capability; advertise each installed surface separately |
| Cursor | Editor CLI v3.7.42 found; `cursor-agent` not found | Background Agents are remote isolated agents with status, follow-up, takeover, and API management | Treat schedule, initiating-agent stream, cancel acknowledgement, and cleanup as unknown until probed |
| Hermes | Agent v0.19.1 installed; CLI exposes cron, gateway, resume, sessions, and monitoring | Cron supports create/pause/resume/edit/trigger/remove, fresh sessions, origin delivery, and no-agent zero-token watchdogs | Use cron/no-agent adapters where configured; verify gateway ownership, delivery target, timeout, and cleanup per manifest |

Primary sources: [Claude scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [Claude agent view](https://code.claude.com/docs/en/agent-view), [Codex app Automations](https://openai.com/index/introducing-the-codex-app/), [Cursor Background Agents](https://docs.cursor.com/background-agent), and [Hermes scheduled tasks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md). Undocumented behavior remains `UNKNOWN`; product marketing is not a capability receipt.

### 3.5 Security, duplication, blast-radius, and TDD research closure

The [OWASP Top 10:2025](https://owasp.org/Top10/2025/) risk pass is mapped to executable gates rather than a prose checklist:

| OWASP risk | Forge exposure | Planned proof |
| --- | --- | --- |
| A01 access control and A07 authentication | claims, leases, approvals, merge/release authority, team provider | G4 adversarial ownership, expiry, actor, stale-head, and unauthorized-action fixtures |
| A02 misconfiguration | optional products, harness capabilities, hooks, native monitor claims | version-bound capability receipts, honest downgrade, absent-product and unsupported-feature fixtures |
| A03 supply chain, A04 cryptography, A08 integrity | packages, generated workflows, BOM, OIDC, receipts | exact-artifact integrity, RFC 8785 canonicalization, DSSE/Sigstore verification, negative identity/digest fixtures |
| A05 injection | untrusted ContextPacket, feedback, provider output, review text | schema allow-lists, fenced untrusted content, redaction, no raw prompt persistence, malicious fixture corpus |
| A06 insecure design | dual authority, hidden coupling, external protocol capture | sole-writer invariant, forbidden private imports, facade routing ledger, failure injection and rollback |
| A09 logging/alerting and A10 exceptional conditions | monitor loss, partial evidence, timeouts, cleanup | redacted structured events, acknowledged cancellation, orphan reaping, and `INCOMPLETE` instead of guessed `PASS` |

DRY and blast-radius closure uses the import and ownership audit: Kernel/schema/storage and packet validation each receive one Memory owner; execution/checkpoint/process lifecycle receives one Flow-core owner; PR review/merge semantics receive one Shepherd owner; routing remains facade-only. Higher layers reuse canonical fixtures and prove wiring rather than copy edge-case matrices. Private cross-package imports, duplicate contract validators, and duplicated owner tests fail G1/G3.

The implementation train begins from these TDD acceptance journeys:

1. A valid stateless `WorkPacket` executes through Flow and Memory accepts exactly one `RunReceipt`.
2. Duplicate identical receipts deduplicate; same identity with different content conflicts; stale lease/head is rejected.
3. A monitor streams bounded events, acknowledges cancel, reaps its process/lease, and emits no event after terminal closure.
4. Missing or unsupported native harness capability downgrades honestly without inventing monitor, resume, or cleanup support.
5. An interrupted beta.5 migration restores from backup and leaves one authority; retry is idempotent.
6. Efficiency supervision replans at 20% and 30%, chooses terminal/handoff at 35%, stops before 40%, and fails closed on missing telemetry.
7. Feedback remains local until per-report preview/consent, contains no stable user/device identity or raw private payload, and deduplicates by issue signature.

## 4. Product independence contract

### 4.1 Forge Memory owns

- Forge Kernel API and authority rules;
- issue, workflow, stage, claim, lease, session, worktree, run, evidence, projection, and migration state;
- local SQLite WAL and future team authority implementations;
- memory storage, search, ranking, supersession, context assembly, privacy, retention, and feedback ingestion;
- canonical `WorkPacket`, `ContextPacket`, `ClaimRequest`, `LeaseReceipt`, `RunReceipt`, `CapabilityManifest`, `FeedbackReport`, and `StructuredError` schemas;
- schema versions, validators, compatibility policy, provenance, idempotency, and conflict detection;
- portable packet and receipt files;
- inbound Beads migration and GitHub/Linear issue projections.

Memory/Kernel alone resolves workflow bindings, required capabilities, policy strictness, stage transitions, evaluator bindings, gate outcomes, merge eligibility, and the durable result of every transition. It issues an authorized invocation to Flow and decides whether the returned receipt permits a state transition. Flow cannot advance a stage, authorize a merge, or record a gate as passed.

Memory owns GitHub/Linear issue-projection configuration, external-field mappings, delivery state, outbox/dead letters, conflict policy, and projection revisions. Projection failure never changes accepted Kernel authority.

Memory remains fully usable without Flow. Humans, agents, or other runtimes may consume a work packet and submit a run receipt.

### 4.2 Forge Flow owns

- execution plans and invocation lifecycle;
- agent and harness selection;
- stage and sub-skill execution;
- runtime monitors and event streaming;
- process handles, cancellation, timeout, and cleanup;
- Git, CI, review, PR, merge-train, and deployment adapters;
- Shepherd and PR-monitor behavior;
- Flow-specific transient types such as `ExecutionPlan`, `InvocationRequest`, `ProcessHandle`, and `MonitorState`.

Flow executes only an invocation already authorized by Memory/Kernel. Its GitHub adapter is run-scoped: it gathers PR/check/review evidence and performs an explicitly authorized external action. It never writes the issue graph, projection state, workflow transition, gate result, or merge authorization. Models and Flow may report evidence; Memory policy owns the decision.

Flow never imports Memory database, broker, schema, migration, or storage modules. It communicates through `@forge/memory-contracts`, an injected `MemoryProvider`, or portable files.

### 4.3 Forge facade owns

- command discovery and routing;
- compatibility aliases for `forge-workflow` and `forge-preflight`;
- installation and capability discovery;
- integration tests proving compatible Memory and Flow combinations.

The facade contains no authoritative tables, claim logic, workflow implementation, or hidden coupling.

### 4.4 Independent evolution rules

- A Memory-only internal change runs Memory tests and does not require a Flow release.
- A Flow-only internal change runs Flow tests and does not require a Memory release.
- A contract change requires Memory contract compatibility review and Flow conformance tests.
- An adapter change runs only its owner product plus contract fixtures.
- No shared database tables or private source imports.
- No behavior activates merely because both products are installed.
- Capabilities are negotiated at runtime; versions are not used as capability proxies.

## 5. Public contracts

All durable cross-product objects use an envelope:

```text
schema_id
schema_version
object_id
created_at
producer
capabilities_used
provenance
content_hash
payload
extensions
```

### 5.1 WorkPacket

Carries immutable execution intent:

- issue and exact revision;
- objective and acceptance criteria;
- authority, allowed mutations, and prohibited actions;
- dependencies, constraints, risk, and platform;
- context references and expected outputs;
- target repository, branch, base, and exact head when applicable;
- receipt requirements and idempotency key.

Changing consequential intent creates a new packet revision and content hash.

### 5.2 ContextPacket

Carries privacy-scoped, provenance-backed context selected by Memory. It includes references or allow-listed summaries, never an implicit transcript dump. Flow cannot widen its scope.

### 5.3 ClaimRequest and LeaseReceipt

Claims are requests; leases are authoritative receipts. A Flow run requiring ownership must prove a current lease. Standalone file mode may use an explicitly ephemeral provider, but its receipts are marked non-durable and cannot authorize shared mutations.

### 5.4 CapabilityManifest

Flow and harness adapters declare supported packet versions, receipt versions, monitoring, cancellation, tools, isolation, and platform capabilities. Memory uses capability negotiation before issuing work.

Capability truth is executable, not documentation-only. Each adapter probes the installed harness version and records whether it supports native streaming monitors, bounded background tasks, wake/resume, cancellation, session-scoped cleanup, and event delivery to the initiating agent. The manifest binds the harness executable identity, version, probe revision, and result hash. Unknown, unprobed, stale, or usage-limited capabilities are reported unavailable; Forge never assumes that Claude, Codex, Cursor, Hermes, or another harness lacks or possesses a monitor feature.

### 5.5 RunReceipt

Carries the terminal evidence Memory can ingest:

- packet id/revision/hash;
- exact repository head;
- executor, model, role, effort, and tool/config hashes;
- start/end, active/passive time, tokens, retries, and corrections;
- mutations attempted and authorized;
- validation and gate results;
- output/evidence references;
- terminal `PASS`, `FAIL`, or `INCOMPLETE` status;
- structured error and cleanup/monitor closure status.

Missing, truncated, stale-head, conflicting, or non-reconstructable evidence is `INCOMPLETE`, never `PASS`.

### 5.6 Compatibility rules

- Additive advisory fields are preserved and may be ignored.
- Unknown consequential fields fail closed.
- Breaking required-field changes create a new schema version.
- Readers declare exact supported versions.
- Memory migrates durable history; Flow never rewrites it.
- Semantic identity plus content hash provides retry deduplication and conflict detection.

### 5.7 Normative encoding and identity

All contract objects use UTF-8 JSON Canonicalization Scheme encoding (RFC 8785) and lowercase SHA-256 content hashes. `content_hash` itself is excluded from the hash input; every other envelope field, including `extensions`, participates. Floating-point values that cannot be represented canonically are rejected.

The common envelope is field-level normative:

| Field | Type and constraint |
| --- | --- |
| `schema_id` | non-empty namespaced string fixed by the contract schema |
| `schema_version` | positive integer; v1 is `1` |
| `object_id` | UUID string generated once per semantic object |
| `created_at` | canonical UTC RFC 3339 timestamp |
| `producer` | object containing stable product id, product version, and instance/run id |
| `capabilities_used` | sorted array of `{ capability_id, manifest_digest }` objects |
| `provenance` | object containing source kind, actor class/id, repository identity when applicable, and exact head when applicable |
| `content_hash` | 64-character lowercase SHA-256 hex over the canonical object with this field omitted |
| `payload` | contract-specific object; unknown top-level payload fields are rejected unless registered by that schema version |
| `extensions` | object keyed by namespaced extension id; each value is `{ impact: advisory|consequential, schema_version, value }` |

Unknown advisory extensions are preserved byte-for-byte through read/write cycles and may be ignored. Unknown consequential extensions reject the object before execution or transition.

| Contract | `schema_id` | Semantic identity | Required authority binding |
| --- | --- | --- | --- |
| Work packet | `forge.memory.work-packet.v1` | issue id + expected issue revision + packet id/revision + repository identity + target head | expected revision, allowed mutations, workflow-config revision |
| Context packet | `forge.memory.context-packet.v1` | work-packet hash + context-selection revision + privacy-scope hash | work-packet hash, retention and disclosure class |
| Claim request | `forge.memory.claim-request.v1` | issue id + expected revision + actor + request id | actor, requested lease scope, idempotency key |
| Lease receipt | `forge.memory.lease-receipt.v1` | claim request id + lease id/epoch | issue revision, actor, scope, expiry, authority signature/provenance |
| Capability manifest | `forge.memory.capability-manifest.v1` | provider id + manifest revision + config revision | provider provenance and evaluator status |
| Run receipt | `forge.memory.run-receipt.v1` | packet hash + run id + attempt id + exact head | lease epoch when required, manifest digest, workflow-config revision |
| Feedback report | `forge.memory.feedback-report.v1` | report id + product version + content fingerprint | explicit consent event, redaction-policy revision, intake provenance |
| Structured error | `forge.memory.structured-error.v1` | parent object hash + error occurrence id | stable code, terminal classification, safe details |

PR 2 materializes these contracts at `packages/memory-contracts/schemas/v1/<schema-id>.schema.json`, with deterministic generated validators and fixtures under `packages/memory-contracts/fixtures/v1/`. Required fixture ids are `valid-minimal`, `valid-full`, `canonical-hash`, `retry-identical`, `identity-conflict`, `unknown-advisory-roundtrip`, `unknown-consequential-reject`, `stale-authority-reject`, `wrong-capability-digest`, `privacy-redaction`, and one malformed/missing-required fixture per field. `packages/memory-contracts/contract-baseline.v1.json` records every schema/fixture digest and generator version. G3 cannot pass from prose or unit tests alone; it verifies this baseline and a forward/backward reader matrix.

Exact retries with the same semantic identity and content hash return the prior result. Reuse of a semantic identity with different content is a conflict and is never overwritten.

Receipt ingestion order is fixed:

1. parse canonical envelope and verify hash;
2. validate schema and consequential extensions;
3. verify packet, workflow-config revision, capability digest, exact head, and lease epoch;
4. apply semantic idempotency/conflict checks;
5. validate evidence references and terminal classification;
6. append the accepted or rejected authority event;
7. evaluate gates and, only when authorized, commit the workflow transition.

Malformed, unauthorized, unsupported, stale, or conflicting objects are rejected and receive a structured rejection event. `INCOMPLETE` applies only when an authorized execution began but terminal evidence is missing, truncated, timed out, or non-reconstructable. `FAIL` is a valid terminal receipt showing unmet acceptance or gates. `PASS` requires valid evidence and every required gate.

### 5.8 Capability trust

The negotiated capability-manifest digest and workflow-config revision are embedded in the WorkPacket and echoed in the RunReceipt. Unknown providers begin quarantined. A capability may become required only after its manifest, contract mapping, evidence schema, and evaluator are approved. Unsupported or changed required capabilities fail before packet issuance; a changed digest during execution makes the receipt stale and requires a new packet.

### 5.9 Evidence privacy classes

Receipt metadata and artifacts are classified as:

- `public_metadata`: hashes, counts, timing, status, and non-sensitive identifiers permitted by policy;
- `local_sensitive`: raw test output, prompts, tool logs, stack traces, source excerpts, and local paths; local-only by default;
- `remote_redacted`: explicitly allow-listed summaries redacted before upload;
- `restricted`: secrets, credentials, personal data, or disallowed content; never uploaded or given to the supervisor model.

Receipts contain references and hashes, not embedded raw logs. Remote upload requires an explicit project or per-artifact policy, redaction, encryption in transit, retention/expiry, deletion behavior, and destination provenance. Model context receives bounded redacted summaries only.

### 5.10 Product feedback contract

`FeedbackReport` is a Memory-owned, privacy-safe intake contract derived from a `StructuredError` or bounded `RunReceipt` evidence. It contains a per-report random id, product/contract version, stable error code, affected capability, redacted reproduction steps, expected/actual classification, occurrence count, content fingerprint, and optional proposed fix. Its provenance actor is the fixed class `anonymous-user` plus the per-report nonce; it has no stable cross-report identity. It excludes user identity, device identifiers, raw prompts, transcripts, source code, secrets, personal data, absolute paths, and unrestricted logs.

Consent is two-stage and never implied. Interactive setup may enable **ask on error**; it does not enable automatic upload. Every report is previewed and requires explicit per-report approval. In a non-interactive run, Forge emits a pending consent request for the agent to present to the user and performs no network action until approval is recorded. Declining has no product penalty.

Report construction, redaction, hashing, deduplication, and upload use deterministic client code and consume no user model tokens. Optional AI clustering or fix synthesis runs only on Forge-operated infrastructure under Forge's budget. Similar reports are grouped by content fingerprint and error semantics, never by user or device. A return channel is absent by default and is included only when the user explicitly supplies one.

## 6. Package, repository, and CLI topology

### 6.1 Initial package extraction

The current monorepo first creates enforceable package boundaries:

```text
@forge/memory-contracts  # owned and released by Memory
@forge/memory            # Kernel + durable memory product
@forge/flow              # optional executor product
@forge/skills            # existing independent provider package
forge-workflow           # compatibility/integration facade
```

All new packages begin at `0.1.0` prerelease versions. `@forge/skills@1.0.0` remains independently versioned and is not silently reset or synchronized.

`@forge/memory-contracts` also defines the transport-neutral `MemoryProvider` and `CoordinationProvider` interfaces. Flow may depend on this package only. The facade or operator injects a local, server, or explicitly ephemeral provider; Flow does not construct a Memory database or network client implicitly.

### 6.2 Extraction-ready modular monolith

All 0.1.0 prereleases and stable ship from the current repository. Independence is enforced inside the monorepo through package APIs, forbidden-import rules, product-owned CI lanes, independent package versions/changelogs/publish permissions, compatibility ranges, and standalone-pack/install fixtures. A Memory-only change must build, test, and publish without Flow source changes; a Flow-only change must do the same without Memory implementation imports.

Physical `forge-memory` and `forge-flow` repositories are postponed until after stable and require an explicit extraction decision. Repository crowding or package names are not justification. Extraction is permitted only when all of the following are proven over at least two accepted prerelease/stable package cycles:

- zero forbidden private imports and zero facade-owned authority writes;
- Memory-only, Flow-stateless, Flow-connected, and facade packages build/test from isolated sparse exports using only declared dependencies;
- N and N-1 package compatibility works without coordinated source commits;
- failure-injection proves provider loss, duplicate/stale receipt, cancellation race, partial publication, and rollback across the package seam;
- independent ownership, release cadence, security isolation, scaling, or technology-stack need is measured—not predicted;
- the signed BOM/verifier supports both the current single-repository case and a multi-repository candidate without changing contract identity.

If approved later, history is preserved where practical, each repository receives independent CI/release authority, and the facade consumes published immutable packages. The split itself is behavior-neutral and must retain a one-command rollback to the last monorepo BOM. Separate services remain an even later decision requiring an operational need; repository separation does not imply network services.

### 6.3 CLI surfaces

```text
forge memory ...       # Memory product through facade
forge flow ...         # Flow product through facade
forge capabilities --json

forge-memory ...       # standalone Memory binary
forge-flow ...         # standalone Flow binary

forge flow run --packet work-packet.json --receipt run-receipt.json
forge feedback report ... # preview and consent-gated Memory intake
forge triage ...          # explicit local triage; cloud cadence is event-driven
```

Existing `forge`, `forge-workflow`, and `forge-preflight` entry points remain compatible through 0.1.x. Existing JSON keys, exit-code meanings, config paths, and supported command aliases either remain compatible or receive an explicit migration diagnostic.

### 6.4 Flow operating modes

| Mode | Input/output | Authority | Allowed mutations |
| --- | --- | --- | --- |
| Stateless | portable WorkPacket file → local RunReceipt file | none beyond packet signature/provenance | only packet-authorized local mutations; no shared claim, stage, issue, projection, or merge mutation |
| Connected local | injected local MemoryProvider | local Kernel broker | operations authorized by current lease and packet |
| Connected team | injected authenticated team MemoryProvider | team authority | operations authorized by membership, lease, packet, and server policy |

Stateless mode cannot claim shared work, validate a live team lease, authorize a merge, or submit an authoritative transition. It produces a receipt that Memory may later accept or reject.

### 6.5 Facade routing and absence behavior

| Existing surface | Owner | Missing-product behavior |
| --- | --- | --- |
| `forge issue`, `create`, `update`, `claim`, `close`, `show`, `ready`, `stats`, `events` | Memory | stable `FORGE_MEMORY_UNAVAILABLE`; no fallback tracker |
| `forge memory`, `remember`, `recall`, `forget`, `compact`, `insights` | Memory | stable `FORGE_MEMORY_UNAVAILABLE`; no local ad-hoc store |
| `forge migrate`, Kernel export/import, issue projections | Memory | stable capability/migration diagnostic; never delegated to Flow |
| `forge plan`, `dev`, `validate`, `ship`, `review`, `verify` | Flow execution + Memory authorization | `FORGE_FLOW_UNAVAILABLE` before execution; packet/issue state unchanged |
| `forge shepherd`, PR monitor, test, push, merge, rollback | Flow | stable `FORGE_FLOW_UNAVAILABLE`; no hidden shell fallback |
| `forge setup`, `doctor`, `upgrade`, `status`, `recap` | Facade composition | report each installed capability independently; partial mode is explicit |
| `forge capabilities --json` | Facade | always available; reports absence without activating products |
| `forge-preflight` | Flow compatibility binary | `FORGE_FLOW_UNAVAILABLE` when Flow is absent |
| `forge-workflow` | Facade compatibility alias | byte-equivalent routing to `forge`; emits deprecation only when a future approved lane exists |

The generated command manifest becomes the exhaustive routing ledger in PR 2. Any command not assigned to exactly one owner fails the boundary gate. Installing both products does not change defaults; activation requires explicit config or command selection.

### 6.6 Release BOM

Every integrated candidate has a signed, canonical release bill of materials containing:

- Memory, Memory Contracts, Flow, Skills, and facade source commit ids plus repository identity; the 0.1.0 BOM may reference one repository and later BOMs may reference several;
- package names and exact versions;
- packed tarball SHA-512 integrity and registry provenance;
- source tag and dist-tag;
- contract schema versions and capability-manifest digests;
- facade lockfile digest and supported compatibility ranges;
- migration schema/version and beta.5 fixture-corpus revision.

The BOM artifact is RFC 8785 canonical JSON using schema id `forge.release-bom.v1`. Its SHA-256 digest is signed as a DSSE envelope by the protected GitHub Actions release workflow using keyless Sigstore OIDC. The verification policy pins the GitHub OIDC issuer, repository owner/name, workflow path and immutable workflow revision, protected tag/ref, source commit, and a versioned Sigstore trust-root bundle. A long-lived repository signing key is not accepted. Trust-root or workflow-identity changes require a reviewed policy revision and a new candidate; old candidates retain the verifier bundle and policy digest used when accepted.

PR 6 delivers a pinned offline-capable `forge release verify-bom` verifier and negative fixtures for altered package digest, wrong repository/workflow identity, wrong tag/SHA, missing transparency proof, a certificate invalid at its recorded signing time, unknown policy revision, and partial publication. The accepted evidence artifact contains the canonical BOM, DSSE envelope, Sigstore verification bundle, verifier/policy/tool versions, per-package registry integrity, and aggregate `PASS|FAIL|INCOMPLETE`. Missing required transparency evidence is `INCOMPLETE`, never unsigned success.

Publish order is contracts → Memory → Flow → facade. The facade candidate is built only from already published immutable prerelease artifacts and pins their integrity in its lockfile. Every package build must reproduce the exact-tag/artifact/OIDC gate even while all packages share the monorepo. A failed later publish does not retag earlier artifacts; the candidate BOM is rejected. Rollback selects the last known-good facade BOM and restores the compatible Memory backup where required.

## 7. Monitor lifecycle

Monitoring is one Flow capability, not one implementation per harness and not model polling. Forge owns the portable control path; a harness-native monitor is an optional delivery accelerator discovered through an executable capability probe.

Claude's current monitor validates the useful core pattern: a background command or WebSocket can deliver events into an active conversation without pausing it. It also exposes the portability gaps Forge must close: monitor processes are session-bound, are not restored on resume, plugin monitors are unsandboxed, and raw stdout lines become model events. Forge adopts the event-driven behavior without adopting those limitations. Sources: [Claude tools reference](https://code.claude.com/docs/en/tools-reference), [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks), [plugin monitors](https://code.claude.com/docs/en/plugins-reference), and [channels](https://code.claude.com/docs/en/channels).

The portable path is:

```text
source adapters -> Flow Monitor Engine -> deterministic reducer -> Memory durable outbox
                                                            -> harness delivery adapter
```

There is one Monitor Engine shared by Claude, Codex, Cursor, Hermes, local CLI, and future harnesses. Shepherd is its first PR-specific consumer, not a second monitor implementation.

The contract boundary is explicit:

- Flow owns `MonitorSpec`: monitor id, owner run, packet id, subject, source adapters, deterministic filter/reducer, terminal predicate, deadline, lifetime, delivery targets, and security policy;
- Memory owns durable `MonitorEvent` storage as part of run evidence: event id, monotonic sequence, subject revision or head SHA, type, actionability, bounded payload or artifact digest, and observation time;
- the facade/harness adapter emits `DeliveryReceipt`: event id, target, transport tier, attempt, delivery time, acknowledgement, and outcome;
- terminal cleanup emits `MonitorReceipt`: terminal state and reason, last sequence, evidence digest, cancellation acknowledgement, process/lease cleanup proof, and any undelivered cursor.

Transport is at-least-once. Idempotent event ids, monotonic cursors, and acknowledgement make agent-context delivery effectively once without pretending the transport itself is exactly once. Events are persisted before delivery; a crashed adapter cannot erase them.

Delivery is capability-negotiated:

```text
T0  durable journal and explicit pull
T1  bounded injection on the agent's next turn
T2  live event/message to an active session
T3  resume or wake a durable task
T4  user notification for required human action
```

Every target must support T0. Higher tiers are used only when their live executable probe passes. Forge promises that every actionable transition is durably recorded and delivered as soon as the target harness can accept it; it does not promise impossible universal mid-response injection.

Monitor lifetime is declared rather than inferred:

- `session` closes on parent-session termination;
- `run` survives session loss until the owning run reaches a terminal state or deadline;
- `subject` survives session and run loss until the PR, deployment, issue, or other subject reaches its terminal state or deadline.

Run- and subject-scoped monitors transfer to durable orphan-safe ownership when an initiating session disappears. Success, failure, acknowledged cancellation, lease loss, timeout, or the declared terminal predicate closes them. Reaping, lease fencing, crash recovery, child-process termination, and cleanup receipts are deterministic and require no model turn.

Event production is push-first: authenticated provider webhooks or native feeds, then bounded command/WebSocket adapters, with jittered/backoff polling only as a fallback. Commands and network destinations are allow-listed and sandboxed where the host permits; credentials are referenced rather than embedded; payloads are capped, redacted, source-authenticated, and fenced as untrusted input. A monitor event never grants approval or merge authority.

The reducer emits only actionable state transitions. It suppresses unchanged state, coalesces duplicates and rapid oscillations, applies bounded priority/backpressure, stores full diagnostics in local artifacts, and delivers a compact summary plus evidence pointer. Unavailable or usage-limited reviewers become explicit unavailable observations rather than infinite waits. The ten-minute review window remains a maximum discovery window after the final correction SHA, not a recurring comment or polling loop.

### 7.1 Efficiency supervisor

Flow provides one scoped `EfficiencySupervisor` per run. Observation is deterministic and event-driven; it does not spend model tokens merely to poll.

The supervisor receives structured events for:

- active and passive time;
- input/output/cached tokens and cost when available;
- focused, package, matrix, and repeated test runs;
- repository head and whether a broad suite already ran on that SHA;
- attempts, identical failures, correction batches, and review rotations;
- packet scope, changed files, newly discovered defects, and authority decisions;
- queue, CI, review, and merge wait time.

Deterministic policy emits one of:

```text
CONTINUE  NARROW  BATCH  REPLAN  DEFER  ESCALATE  STOP
```

Before admission, each WorkPacket declares `token_budget`, `budget_metric`, the strict 39% run cap, and reserved capacity for terminal evidence. For 0.1.0, `budget_metric` is fixed to `provider_reported_total_tokens`: uncached input, cached input, cache-write, output, reasoning, and supervisor-model tokens are all counted without discount whenever the provider exposes them; an authoritative provider aggregate is used when only that aggregate exists. Wall time, test duration, and money are recorded as separate guardrails and are never converted into tokens.

The 20%, 30%, 35%, and 39% thresholds are computed from cumulative counted tokens divided by the declared integer `token_budget`. Missing, reset, contradictory, or non-monotonic usage telemetry prevents a compliant `PASS`: model-assisted supervision stops, the run produces `INCOMPLETE`, and the receipt preserves the last trustworthy count. Deterministic commands may continue only long enough to close processes and write the bounded handoff. Work that cannot plausibly finish its implementation and required terminal gate within the cap is split into independently valuable packets before execution.

The run must finish after consuming strictly less than 40% of its declared parent budget, leaving more than 60% unused. Remaining budget is reserve capacity, not permission to expand scope. Initial triggers are explicit:

- run a mandatory deterministic replan at both 20% and 30% of the parent budget; if scope, evidence, and terminal path are unchanged, the checkpoint records that fact without a model call or new plan prose;
- at 35%, stop exploration and commit to either bounded terminal completion or a resumable handoff; reserve 35–39% for required evidence, cleanup, and handoff; stop all new work at 39%;
- if the authorized outcome is incomplete at the 39% stop, emit `INCOMPLETE` with a compact resumable handoff and require a new explicit budget decision rather than overrunning;
- reject a repeated broad suite on an unchanged SHA unless the prior receipt was incomplete;
- after two materially identical failed attempts, require a changed hypothesis or narrower reproduction;
- after three failed approaches, escalate or defer instead of repeating the same configuration;
- after two correction batches, batch remaining feedback and reassess the contract before another push;
- when changed files escape the packet scope, stop and create or link a separate issue;
- when wait time dominates active time, yield to an event-driven monitor instead of consuming an agent turn;
- when a test lane exceeds its budget, report the slow owner tests and use the smallest valid lane rather than rerunning everything;
- store raw test output in receipts/artifacts and stream only bounded failure summaries back into model context.

A configured small model may be invoked only for a threshold event that deterministic rules cannot classify. It receives a privacy-safe structured summary, not source code, prompts, transcripts, secrets, or personal data. Its counted usage is included in the parent total and also capped independently at the smaller of 1,000 tokens or 1% of the parent `token_budget`, with at most two invocations per run. If the parent run has no declared token budget, model-assisted supervision is disabled.

Required release-candidate validation is a separate authorized WorkPacket with its own declared budget and receipt. It never competes with incidental exploration inside an implementation packet.

The supervisor may recommend deferral, but it never silently abandons work. Deferred work must be linked to an existing Kernel issue or filed as a scoped follow-up with evidence. It cannot waive security, authority, migration, data-integrity, required-check, exact-head, or lease gates; merge PRs; resolve review threads; or close issues. It streams recommendations to the initiating agent and closes automatically with the parent run.

### 7.2 Feedback and backlog-triage lifecycle

Flow emits bounded structured errors and terminal receipts; Memory owns feedback intake, similarity grouping, issue supersession, priority policy, and durable triage history. Neither product imports the other's implementation.

- local/CLI triage is manual and deterministic by default;
- optional Forge Cloud triage is event-driven after five completed PR receipts or 20 new untriaged reports/issues, whichever occurs first; projects may configure stricter thresholds;
- unchanged state never wakes a model or consumes a client token;
- cloud AI, when enabled, is Forge-funded and sees only redacted structured fields;
- exact duplicates and supersession links may be applied idempotently under project policy; closure, security downgrade, destructive priority change, or scope expansion requires an auditable approval;
- every triage pass returns a `RunReceipt` with inputs, grouping decisions, priority changes, deferred items, and next evaluation threshold;
- post-merge Flow handoff asks Memory for the current prioritized next packet; it does not independently invent backlog state.

## 8. Migration, cutover, and rollback

### 8.1 Authority invariant

Kernel/Memory is the only authority writer throughout migration. Shadow comparison and dual-read are allowed; dual-write authority is forbidden.

### 8.2 Migration phases

1. **Inventory and backup** — identify database version, config, generated projections, packages, and installed harnesses; create and verify restorable backup.
2. **Dry run** — report preserved, transformed, dropped, unresolved, and incompatible fields without mutating authority.
3. **Additive migration** — add new schema/contracts and adapters while beta.5-compatible data remains readable.
4. **Shadow comparison** — execute old and new read/execution paths against identical packets; compare normalized receipts.
5. **Cutover** — route commands through package APIs; Kernel remains sole writer.
6. **Rollback exercise** — restore backup and reinstall beta.5 in a clean fixture; prove the previous user workflow remains usable.
7. **Finalization** — remove shadow code only after RC evidence, not in the same PR that introduces it.

### 8.3 Executable beta.5 compatibility corpus

A versioned, immutable beta.5 fixture corpus is captured before behavior moves. It contains only synthetic/redacted data and covers:

- all three installed binaries and their supported command/alias manifest;
- success, failure, and unavailable JSON envelopes and exit codes;
- `.forge/config.yaml`, workflow stage matrix, gate/rail settings, generated skills/rules, and harness projections;
- representative Kernel issue, dependency, comment, claim, run, event, projection, and memory data;
- empty, large, stale-claim, conflicted-revision, and interrupted-migration database states;
- pre-cutover, mid-cutover, and post-cutover-write rollback cases;
- package install, upgrade, uninstall, and restored beta.5 operation.

The corpus is content-hashed and versioned in the release BOM. Compatibility claims are accepted only from this corpus plus declared public-contract snapshots.

### 8.4 Migration guarantees

- issue ids, revisions, dependencies, comments, claim history, run ids, event ordering, provenance, and idempotency survive;
- migration is restartable and idempotent;
- stale writes and conflicting receipts remain rejected;
- Beads remains one-way inbound migration only;
- projection failures never roll back accepted Kernel events;
- raw prompts and tool logs remain local by default;
- generated harness files remain projections, never authority;
- rollback never silently discards post-migration writes: the tool reports them and requires explicit resolution.

## 9. Backlog disposition

The latest 522 open/in-progress issues are partitioned conservatively. The count is one higher than the initial audit because the requested Flow efficiency supervisor is now tracked explicitly:

| Bucket | Count | 0.1.0 treatment |
| --- | ---: | --- |
| Memory/Flow/contracts migration candidates | 52 | Consolidate into product PRs after acceptance review |
| Control-plane debt | 20 | Resolve in Wave 1 or relevant product wave |
| Separate release/quality gates | 3 actionable + 1 release root | Resolve before stable; do not mix into architecture diffs |
| Close/supersede audit | 3 | Close only after implementation/release evidence is verified |
| Unrelated/defer | 443 | Keep out of 0.1.0 restructuring train |

The 72 architecture/control candidates include five deliberately deferred items whose value is real but not required for 0.1.0. Therefore 67 issues enter the architecture train. Three separate release-gate issues require work, while the stable root is tracking only. The final actionable total is 70 issues, not 70 PRs.

### 9.1 Inclusion rule

An issue enters the 0.1.0 train only if it is required to:

- establish or enforce the Memory/Flow boundary;
- preserve or migrate public behavior or durable data;
- make authority, claims, release evidence, or rollback trustworthy;
- replace validation duplication needed to deliver these waves safely;
- close a security issue that blocks the release.

Every included issue must have acceptance criteria, owner wave, product owner, affected contract, and validation owner. Current labels alone are insufficient.

The snapshot maps 70 candidate work outcomes, but 47 implementation/migration candidates and the stable-release tracking root currently lack explicit Kernel acceptance criteria. They are not admitted merely because they appear in the ledger. The approved contracts in [acceptance-contracts.md](./acceptance-contracts.md) must be revision-checked, written to Kernel authority, read back, and aggregated into a passing `admission-evidence.v1.json` before PR 1 implementation begins. This is a pre-implementation admission checkpoint, not an eighth code PR.

### 9.2 Existing release issues

- The old stable root `8e634347-4562-4570-bc81-c22b210507d9` is superseded or relinked to this release plan.
- `af79e102` and its writer dependency are closed only after PR #496 exact-SHA evidence is verified.
- `d362bd71` remains an evaluation gate only for behavior or routing changed by 0.1.0; infrastructure alone is not completion.
- Security recurrence `4265026c` remains a separate PR and must be green before RC.
- Beta.5 release issue `16b75ba8` is closed after the published artifact/tag is verified.

### 9.3 Control-plane prerequisites

- `9e31a2f0-49c2-4d83-a936-1674871679a2`: reconcile claim projections before migration.
- `7a6a3fb3-c82c-48e7-86ee-630c171b924c`: redesign risk-owned validation.
- `f21279f4-473a-4d20-95d4-533ddbb1d102`: add an event-driven efficiency supervisor for Flow runs.
- `18bee669-dd71-46c8-ac24-b36cf1a613b2`: make context/recap consume Kernel authority instead of a stale Beads projection.

No issue is automatically closed from title matching or staleness.

## 10. Implementation and PR train

The proposal itself is a documentation PR. Implementation begins only after it is approved and merged.

### PR 1 — Control-plane trust and fast validation

**Outcome:** claim state, issue readiness, release evidence selection, and affected-test selection become trustworthy enough to support the train.

- reconcile claim projections;
- require contract-valid acceptance criteria for train inclusion;
- implement risk-to-test ownership manifest and changed-surface selection;
- separate PR, scheduled, and release validation lanes;
- add prerelease/RC npm dist-tag behavior and exact-SHA receipts;
- capture the immutable beta.5 compatibility corpus;
- implement state inventory, verified backup, and non-mutating migration dry-run scaffolding required by beta.6.

### PR 2 — Memory contracts and package boundaries

**Outcome:** versioned packet/receipt contracts and enforceable import boundaries exist without behavior change.

- create `@forge/memory-contracts`;
- define schemas, validators, semantic identity, and compatibility fixtures;
- create `@forge/memory` and `@forge/flow` package skeletons;
- add forbidden-private-import checks;
- keep the legacy CLI facade behavior identical.

### PR 3 — Forge Memory foundation

**Outcome:** Kernel authority and durable memory are reachable only through Memory public APIs.

- move/wrap Kernel, broker, schema, migration, issue, run, evidence, memory, and projection ownership;
- split memory storage concerns from the monolithic SQLite driver behind internal Memory interfaces;
- expose client and portable file APIs;
- implement consent-gated structured feedback intake and event-driven cloud/manual triage boundaries;
- preserve exact authority and data semantics.

### PR 4A — Forge Flow core, skills, and observers

**Outcome:** packet execution, skill composition, process lifecycle, monitors, and efficiency supervision form a standalone Flow core without PR-review semantics.

- extract Flow execution and bounded-loop APIs;
- move generic process/monitor lifecycle and Smith/skill runtime composition;
- implement the single Flow Monitor Engine, `MonitorSpec`, deterministic reducer, delivery cursor, acknowledgement, and session/run/subject lifecycle;
- integrate Memory-owned durable events and terminal monitor receipts without importing Memory internals;
- probe and publish installed-harness monitor/cancellation/cleanup capabilities instead of relying on name-based assumptions;
- implement the event-driven efficiency supervisor and its hard sub-budget;
- consume only Memory contracts/client and prove standalone packet-to-receipt execution;
- add failure injection for timeout, cancel acknowledgement, duplicate/conflicting receipt, stale lease, provider loss, and orphan cleanup.

PR 3 and PR 4A may be prepared in parallel after PR 2. They merge Memory first, Flow core second.

### PR 4B — Shepherd, review, merge, and post-merge handoff

**Outcome:** GitHub/PR orchestration becomes one understandable vertical Flow slice over the proven Memory and Flow-core seams.

- move Shepherd, PR monitor specialization, review, merge, ancestry, thread, and PR-state adapters onto the shared Monitor Engine;
- preserve one current-head fail-closed verdict and Memory-issued merge authority;
- adapt native harness delivery where probed and fall back to Forge-owned events/lifecycle without model polling;
- emit bounded post-merge receipts and request the next prioritized packet from Memory;
- replay restart, watcher adoption/reaping, stale head, zero/open threads, optional neutral checks, and external/fork PR heads.

### PR 5 — Facade, harness, and capability negotiation

**Outcome:** existing commands route through product APIs and all harnesses negotiate capabilities without owning state.

- thin `forge` command routing;
- preserve legacy bins and supported JSON/exit behavior;
- move harness and GitHub edges to their owning product;
- keep `@forge/skills` independent;
- implement `forge capabilities --json`;
- implement T0-T4 delivery adapters for Claude, Codex, Cursor, and Hermes with truthful per-installed-version degradation;
- regenerate projections from canonical sources.

### PR 6 — Migration, shadow comparison, and extraction readiness

**Outcome:** beta.5 users can upgrade, compare, cut over, restore, and use independently released packages without a physical repository split.

- dry-run, backup, additive migration, replay, shadow comparison, cutover, and rollback;
- clean-install and upgrade fixtures;
- prove isolated sparse-export builds/tests and independent package publish lanes;
- make facade depend on published packages rather than source paths;
- generate and verify the signed release BOM in its single-repository/multi-package form;
- exercise the future multi-repository BOM verifier and extraction failure fixtures without moving repositories.

### PR 7 — Release convergence and backlog disposition

**Outcome:** contracts freeze, superseded work is closed with evidence, documentation is current, and the tree is ready to tag one exact RC candidate. Promotion happens after the tagged candidate matrix, not inside this PR.

- finish issue disposition and supersession links;
- resolve separate security/evaluation/release gates;
- remove obsolete shadow paths only after evidence;
- publish migration and rollback guides;
- freeze the release BOM and candidate-generation workflow;
- make the post-tag exact-SHA matrix and later metadata-only promotion executable.

### 10.1 Path and API ownership

| PR | Exclusive production ownership | Exclusive test/evidence ownership | Shared surfaces |
| --- | --- | --- | --- |
| 1 | claim/readiness truth, test selection, release/preflight utilities | claim conformance, risk manifest, beta.5 corpus capture | CI workflows only through PR 1 owner |
| 2 | contract schemas/validators, package skeletons, public interfaces | contract fixtures, command routing snapshot, boundary checks | root workspace manifests and command manifest freeze here |
| 3 | `@forge/memory`, Kernel/Memory internals and compatibility shims | Memory, Kernel, storage, migration-unit tests | consumes frozen PR 2 contracts; no Flow files |
| 4A | `@forge/flow` execution, skills, generic monitors/processes, EfficiencySupervisor | Flow core, capability probe, cancellation, budget, lifecycle tests | consumes frozen PR 2 contracts; no Memory internals or PR semantics |
| 4B | Shepherd, PR-specific monitor, review/merge/ancestry/thread adapters | current-head verdict and PR lifecycle replay | consumes merged PR 3 + PR 4A public APIs |
| 5 | facade routing, harness adapters, capability discovery | CLI/JSON/exit snapshots, harness parity | only facade owner changes composition roots |
| 6 | migration/cutover/rollback and extraction-readiness tooling | beta.5 replay, clean upgrade, rollback, sparse exports, release BOM | exact package candidates only; no repository move |
| 7 | release metadata/docs/disposition tooling | RC generation and promotion evidence definitions | no product behavior changes |

The main integrator alone owns root `package.json`, `bun.lock`, shared CI matrices, generated command manifests, and cross-product fixtures during parallel work. PR 3 and PR 4A branches start from and rebase onto the exact frozen PR 2 API commit before review. PR 4B starts only after both public seams are merged. Parallel workers do not independently regenerate shared lockfiles or edit one another's compatibility shims.

## 11. Parallelism and merge discipline

- One owner per file/module/workstream.
- PR 1 and PR 2 are sequential foundations.
- After PR 2, Memory and Flow-core worktrees can proceed concurrently with disjoint ownership.
- Shepherd/PR semantics begin only after Memory and Flow-core APIs merge; facade work begins only after those public APIs freeze.
- Migration consumes exact package candidates; it does not chase moving branches.
- Every correction batch produces one new SHA after feedback is batched.
- Full CI is not rerun on an unchanged SHA.
- Merge order is PR 1 → PR 2 → PR 3 → PR 4A → PR 4B → PR 5 → PR 6 → PR 7.
- Required checks, exact ancestry, current head, unresolved actionable threads, and authority are read live before merge.

## 12. Risk-based validation architecture

### 12.1 Canonical ownership rule

Every invariant has one lowest-level canonical owner test. Higher-level journeys prove wiring and do not repeat its entire edge-case matrix.

The risk-to-test ownership manifest is versioned and content-hashed. Its digest is included in the WorkPacket and RunReceipt. A changed surface with no exact or conservative ownership mapping cannot receive a targeted `PASS`: it runs the owning package plus contract and affected-platform baseline; if even the owning package is ambiguous, selection fails closed and routes to the full repository baseline until the mapping is repaired.

### 12.2 Feedback budgets

| Lane | Purpose | Initial wall-time budget |
| --- | --- | ---: |
| RED/GREEN focus | one behavior or contract | 60 seconds typical |
| Changed package | unit + owned contract tests | 5 minutes |
| Cross-product contract | Memory/Flow conformance | 8 minutes |
| Affected platform | only platform-sensitive surfaces | 12 minutes |
| Scheduled compatibility | broad OS/runtime/adapters | non-blocking PR lane |
| Release candidate | complete exact-SHA matrix | 30 minutes target |

A budget breach does not weaken a gate. It creates an owned performance/flakiness issue and moves redundant coverage to the correct lane.

### 12.3 PR selection

- Contract changes: schema fixtures plus Memory and Flow conformance.
- Memory storage changes: Memory package, migration corpus, backup/restore, Windows and Linux SQLite checks.
- Flow changes: Flow package, fake Memory provider, process/monitor cleanup, affected platform only.
- Adapter changes: adapter contract fixtures plus one end-to-end journey.
- CLI/facade changes: command/JSON/exit snapshots and package installation.
- Docs-only changes: links, generated projections, and drift checks.
- Security/authority changes: mandatory focused adversarial cases; never quarantined.

### 12.4 Release matrix

Only the settled candidate runs:

- Ubuntu, macOS, and Windows;
- Node 22 and 24;
- clean install of each product and facade;
- beta.5 upgrade, migration dry-run, cutover, and rollback;
- Kernel conformance and claim/lease truth;
- contract forward/backward fixtures;
- Claude, Codex, Cursor, and Hermes projection parity;
- npm package contents, provenance, OIDC, dist-tags, and exact SHA;
- one real monitor lifecycle and sequential merge-train simulation.

### 12.5 Test reduction safeguards

- A test is removed only when its risk is mapped to an equal or stronger canonical test.
- Deletion evidence identifies old test, risk, replacement, and measured runtime gain.
- Flaky noncritical tests may be quarantined only with owner, issue, expiry, and non-required status.
- Security, authority, migration, stale-head, and data-integrity tests cannot be quarantined.
- Comment count, test count, and merge rate are not quality metrics.

## 13. Release sequence

### 13.1 `0.1.0-beta.6` — contracts and compatibility facade

- PR 1 and PR 2 merged;
- no authority behavior change;
- package boundaries and contract fixtures available;
- migration inventory, backup, and dry-run available;
- publish under `next`, never `latest`;
- exit beta.6 after at least ten clean synthetic corpus journeys; no passive calendar wait substitutes for evidence.

### 13.2 `0.1.0-beta.7` — Memory and Flow operational split

- PR 3 through PR 5 merged;
- Kernel remains sole writer;
- shadow comparison on identical packets;
- clean beta.5 upgrade fixtures;
- internal canary projects complete representative Memory-only, Flow-only, and integrated journeys;
- exit beta.7 after at least 25 clean canary journeys covering Windows and Linux, standalone and connected modes, and a minimum 72-hour automated observation window with no unresolved S0/S1 escape. Monitoring consumes no model turns while state is unchanged.

### 13.3 `0.1.0-rc.1` — migration and contract freeze

- all eight implementation PRs across milestones 1–7 merged;
- contract/config/schema freeze;
- package independence and future extraction readiness proven without a physical repository split;
- rollback exercise passes;
- no unresolved S0/S1 defect;
- the signed release BOM is frozen;
- tag the exact candidate, publish immutable prerelease packages in BOM order under `next`, then run the complete exact-artifact/exact-SHA matrix;
- exit RC after at least 50 clean canary journeys and seven cumulative automated observation days across RCs with no unresolved S0/S1 escape.

Behavioral changes after RC create RC.2 and rerun only the affected evidence and canary lane. Unaffected evidence and cumulative observation remain valid when the BOM proves their inputs did not change.

### 13.4 `0.1.0`

- metadata-only promotion of the exact accepted candidate;
- npm `latest` points to the verified SHA;
- fresh install, beta.5 upgrade, and rollback are reverified;
- all release issues are closed or explicitly deferred with rationale;
- no code change is introduced during promotion.

## 14. Evaluation disposition

The Sol/Luna evaluation is not allowed to become an unrelated architecture blocker:

- 30 cases prove instrumentation and execution viability;
- 100 blind cases gate any new default model-routing decision;
- 300 rolling cases provide operating evidence for later promotion;
- no model winner is claimed from infrastructure, comment counts, or historical routing logs;
- if 0.1.0 does not change default model routing, the architecture release requires the instrumentation smoke but not a model winner.

## 15. Stop conditions

The train stops before merge or release when any of the following occurs:

- two components can write the same authority state;
- Flow imports Memory private storage or schema modules;
- migration cannot enumerate preserved, transformed, dropped, and unresolved fields;
- rollback loses acknowledged post-migration data without explicit user resolution;
- packet or receipt identity is ambiguous;
- exact head, issue, lease, or authority cannot be reconstructed;
- a required security, authority, migration, or data-integrity gate is red or incomplete;
- package or repository split changes runtime behavior;
- public CLI/JSON/config behavior changes without migration diagnostics;
- final candidate evidence is not tied to one exact SHA;
- an unrelated issue expands the active PR rather than receiving its own issue/PR.

## 16. Requirement traceability and completion definition

| Required planning dimension | Authoritative evidence | Remaining decision |
| --- | --- | --- |
| Product boundaries and architecture | §§4–6; `decision-register.md` R6–R10; `facade-routing.md` | Approve R6–R10 |
| Migration, cutover, and rollback | §8; PR 6 in §10; G5 and the RC matrix in `validation-matrix.md` | Approve sole-writer and extraction timing |
| Beta.5 compatibility | §§6.5, 8.3–8.4; facade routing ledger; beta.5 corpus gates | Approve R9–R10 |
| Release sequencing and provenance | §§6.6, 13; G8; signed BOM/verifier rules | Approve R12–R13 |
| Issue disposition and admission | §9; `issue-disposition.md`; `acceptance-contracts.md` | Approve R11, then perform revision-checked Kernel admission before code |
| Implementation waves and merge order | §§10–11; seven milestones/eight PRs; disjoint ownership table | Approve R2/R11 train details |
| Validation and token efficiency | §§7.1, 12; `validation-matrix.md`; risk manifest and 20/30/35/39 policy | Approve targeted-plus-final-matrix strategy |
| Market, standards, harnesses, and security | §§3.4–3.5; advisory Parallel reports; Context7/official-doc evidence; OWASP/TDD mapping | Re-probe capability manifests during PR 5; no assumption becomes a gate |

Every row has normative evidence and an explicit authority. The only unresolved planning state is user disposition of proposed decisions R6–R14; there is no hidden technical prerequisite to that decision.

Planning is complete only when the user approves:

- the asymmetric Memory-foundation/optional-Flow ownership;
- package, repository, and CLI topology;
- beta.5 compatibility and rollback guarantees;
- seven-milestone/eight-PR implementation train and merge order;
- 67-issue architecture/control train, three separate release gates, and disposition rules;
- risk-based validation lanes and budgets;
- beta.6/beta.7/RC/stable sequence;
- evaluation boundary and stop conditions.

Implementation is not authorized by approving this draft. After approval, this document is committed and opened as a strategic proposal PR. Implementation planning and task decomposition begin only after that proposal merges.

## 17. Approval questions

1. Lock Forge Memory as the owner of Kernel, durable contracts, packets, leases, receipts, and history, with Flow as an optional executor?
2. Keep 0.1.0 as an extraction-ready modular monolith with independently releasable Memory and Flow packages, postponing physical repository separation until the measured post-stable triggers pass?
3. Preserve beta.5 CLI/config/data behavior unless an explicit migration diagnostic and rollback path exists?
4. Accept seven milestones delivered through eight cohesive PRs, with Flow core (4A) separated from Shepherd/review/merge semantics (4B), and the stated sequential merge order?
5. Accept 67 architecture/control issues in the eight-PR train, three separate release-gate issues, five explicit candidate deferrals, and all unrelated work outside the train?
6. Accept targeted PR validation plus one full exact-SHA release matrix?
7. Decouple model-winner promotion from 0.1.0 unless default routing changes?
