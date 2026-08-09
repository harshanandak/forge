# Durable Memory First: A Safe Flow Extraction Plan

## Executive Summary

- **Authority Separation**: Leading products keep instructions, memory, issue context, or session history separate from the process that edits and tests code. Claude Code uses versionable CLAUDE.md plus machine-local auto memory, while Codex layers AGENTS.md and project threads over execution [22] [4]. -> Make Memory the canonical work ledger, not merely a vector store.
- **Workflow Ownership**: GitHub Copilot and Claude Code anchor work in repository issues, branches, pull requests, CI events, or PR review comments, while Cursor and Devin add scheduled and event-triggered automation [23] [21] [29] [14]. -> Give one product ownership of work identity, leases, state transitions, and receipts.
- **Native Capability Gap**: Claude Code, Cursor, Codex, Devin, and Hermes all expose some form of unattended execution, but official documentation is uneven on cancellation, delivery guarantees, cleanup, and event streaming back to an initiating agent [21] [11] [29] [48]. -> Treat undocumented behavior as unknown, never as a contract.
- **Asymmetric Product Fit**: A Memory owner plus optional Flow executors is sound if Flow is a replaceable worker and cannot become a second authority. -> Ship the boundary as interfaces inside one modular monolith before creating a second service or repository.
- **Protocol Positioning**: MCP Tasks, A2A, and AG-UI solve different layers: tool/task interoperability, remote agent task exchange, and frontend event streaming. AG-UI explicitly uses a streaming event architecture [27], but none of these should become the canonical domain model. -> Use them as adapters around an internal Work Packet and Receipt contract.
- **Migration Safety**: The safest path is package extraction, compatibility facades, shadow reads, one canonical writer, event or outbox publication, then optional service extraction. Microservice guidance warns that decomposition is costly and should follow vertical capabilities and operational readiness [41]. -> Postpone multi-repository ownership until the seam survives failure and rollback tests.
- **Test Economics**: Test impact analysis can select affected tests from a call graph [45], while a systematic review covered **27 papers**, **36 empirical studies**, and **28 techniques** [47]. -> Combine exact-candidate matrices with risk-owned fallbacks and a full-suite escape hatch.
- **Privacy Boundary**: Client feedback should be explicit, redacted, content-minimal, and independent of the client model. Private vulnerability reporting demonstrates a separate channel for sensitive submissions [42]. -> Send a bounded envelope to server-side triage; never ask the local agent to summarize telemetry by default.
- **Review Discipline**: Google finds small changes easier to review quickly and thoroughly [40]. -> Use small PRs for seams, medium vertical slices for behavior, and large PRs only for mechanically generated or unavoidable cutovers.

**Executive recommendation.** Build a Memory-first modular monolith with four internal packages: `work-ledger`, `protocol-contracts`, `flow-runtime`, and `observers`. Memory owns issues, workflows, runs, attempts, leases, receipts, privacy policy, history, and authorization. Flow consumes immutable work packets, emits progress and artifacts, and returns a receipt. The first Flow implementation can be an in-process adapter, a local plugin, or a remote worker without changing Memory's authority model.

Do not split repositories yet. First prove that a run can be created, leased, resumed, cancelled, retried, observed, and rolled back with one canonical state machine. Then extract a package, publish a compatibility facade, and only later make Flow independently deployable. This is the durable design because it separates the decision that must survive every executor from the mechanism that will change fastest.

## 1. What Leading Products Actually Separate

The market does not present one universal architecture. It presents a recurring pattern: durable context is represented as files, knowledge items, threads, projects, or checkpoints; work authority is represented by issues, PRs, schedules, or sessions; execution is a runtime that operates in a sandbox. The boundary is often implicit, which is precisely why an open-source platform should make it explicit.

| Product or framework | Durable context or memory | Work authority | Execution and orchestration | Architectural lesson |
|---|---|---|---|---|
| Claude Code | CLAUDE.md is persistent project, personal, or organizational instruction; auto memory records build commands, debugging insights, architecture notes, and preferences, but machine-local auto memory is context rather than enforcement [22] [22]. | Cloud sessions can watch a PR, receive CI and review-comment events, and decide whether to push a clear fix [21]. | Hooks run at session, turn, and tool-call lifecycle points; subagents run in parallel or sequence and can resume by agent id [15] [26] [26]. | Separate guidance from policy. Put hard authorization in a hook or ledger, not in a markdown memory file. |
| OpenAI Codex | AGENTS.md is discovered in global and project scopes, merged by directory precedence, and capped by `project_doc_max_bytes`, **32 KiB by default** [4]. Skills bundle instructions, resources, and scripts [11]. | Projects contain separate agent threads and a review queue; worktrees let multiple agents work on a repository without conflicts [11] [11]. | Automations run in the background on schedules; cloud triggers were described as being built out [11] [11]. | Treat instruction layering and work threads as separate records. Do not mistake an AGENTS file for an issue system. |
| Cursor | Automation memories persist as named entries outside the working filesystem and can be disabled. Cursor warns that untrusted inputs can poison those memories [29]. | Cloud agents clone a repository, work on a separate branch, push changes, and can open PRs; automations can trigger from schedules, GitHub, Slack, and webhooks [25] [29]. | Isolated cloud VMs can run agents in parallel and across multiple repositories [25]. | Persistent automation memory needs trust boundaries and provenance. Multi-repo execution is not the same as multi-repo authority. |
| GitHub Copilot cloud agent | Repository custom-instruction files tell the agent how to understand, build, test, and validate a project [23]. | GitHub issues, branches, commits, PRs, and session logs are the work surface. Copilot can be assigned an issue, work independently, and optionally open one PR [23] [23] [23]. | Each session uses an ephemeral GitHub Actions development environment, explores code, edits, tests, and records each step in commits and logs [23] [23]. | The host system owns durable work identity. An agent runtime is a bounded implementation, not the source of truth. |
| Devin | Knowledge is organization or enterprise-scoped guidance, retrieved when relevant and optionally pinned to a repository or all repositories [6] [6]. | Scheduled sessions and Automations own recurring or event-triggered work; past sessions are retained for audit [14] [14] [14]. | Devin sessions execute autonomous coding work; schedule triggers can be cron-based, one-time, or event-driven [14]. | A shared knowledge plane and a session scheduler are distinct. Make both explicit rather than hiding them inside an agent loop. |
| OpenHands | The SDK exposes a Python and REST boundary for agents that work with code and can run locally or in the cloud [7]. | The SDK description is execution-oriented and does not establish a universal issue ledger, lease model, or receipt authority. | Runtime components execute actions and manage the runtime environment; task planning and decomposition are SDK features [7]. | OpenHands is a useful Flow implementation, but Memory must wrap it with run identity, limits, and receipts. |
| LangGraph and LangSmith | LangGraph persistence provides thread/checkpoint state and replay or interruption primitives; LangSmith records traces, feedback, evaluation, cost, and latency. These are application-state and observability layers, not automatically an issue authority [9] [3]. | The application chooses the business owner of a run; LangSmith observes it rather than replacing that owner [3]. | LangGraph executes graph steps and durable checkpoints; LangSmith monitors and evaluates them. | Adopt the separation of checkpointed execution from observability, but keep canonical work state outside a vendor-specific trace store. |
| Temporal | Temporal treats workflows as durable execution histories, recommends idempotent Activities, and supports worker versioning so new worker builds can coexist safely with running workflows [5] [20]. | The workflow engine owns execution history and signals, but the business system must still own issue semantics and authorization. | Workers execute Activities with retries and version routing. | Borrow durable execution and versioning patterns without forcing all product concepts into a workflow engine. |

The contrast is important. Claude Code and Codex emphasize repository-local instructions and session continuity. Cursor and Devin emphasize always-on triggers and persistent automation memory. GitHub makes issues and pull requests the visible authority. OpenHands exposes a runtime that an external control plane can govern. LangGraph and Temporal make checkpointing and replay explicit, while LangSmith makes observability explicit. The common design opportunity is therefore not another agent loop. It is a stable control plane that can host many loops.

## 2. Native Capability Matrix: What Is Proven, Emulated, or Unknown

The phrase "background agent" hides several distinct capabilities. A schedule starts a new run. A monitor wakes an existing run. Streaming sends incremental observations. Resume rehydrates state. Cancellation changes authority and stops work. Cleanup reclaims credentials, VMs, branches, and leases. The table distinguishes official evidence from adapter behavior.

| System | Background or recurring | Monitor and event delivery | Resume or wake | Cancellation | Scoped cleanup | Status |
|---|---|---|---|---|---|---|
| Claude Code | Official cloud sessions persist after browser or laptop closure. PR Auto-fix subscribes to GitHub activity and investigates CI failures or review comments [21] [21]. | Official PR events reach the cloud session; the docs do not promise a generic event stream to an initiating agent. | Official: when an inactive VM is reclaimed, reopening the session provisions a fresh VM with conversation history restored [21]. Subagents can resume by id; manual `/tasks` or SDK stop does not auto-resume as of the documented version [26]. | Official stop-monitoring exists through the Auto-fix toggle. A separate in-progress task cancellation API, command interruption semantics, and partial-change behavior are not established [21]. | Official SessionEnd hooks can log, save state, or clean up; cloud VM reclamation is documented. Exact resource, credential, and branch cleanup guarantees remain unknown [15] [21]. | Strongest documented lifecycle, but do not infer exactly-once event delivery. |
| Codex | Official app Automations run in the background on a schedule; cloud-trigger support is described as under development [11] [11]. | The official app page documents a review queue, not streaming events to the originating thread. | Threads and projects preserve task context; the page does not specify wake semantics for an existing run [11]. | The app page does not specify cancellation behavior. | The app page does not specify VM, worktree, secret, or branch cleanup after cancellation or expiry. | Background and schedule are official; stream, wake, cancel, and cleanup are unknown. An adapter may emulate them with polling. |
| Cursor | Official Cloud Agents run in isolated VMs. Automations run on recurring schedules or GitHub, Slack, and webhook events [25] [29]. | Official actions include branch, PR, comment, and reviewer operations; generic streaming to the initiating agent is not documented [29]. | Persistent automation memories are official, but resume of a prior run or wake of a paused run is not documented [29]. | Cancellation semantics are not specified in the cited docs. | Cleanup of VMs, credentials, branches, and automation memories after cancellation is not specified. | Strong trigger surface; lifecycle contract remains partial. |
| Hermes | The official repository advertises a built-in cron scheduler, unattended delivery, parallel isolated subagents, and environments that hibernate and wake on demand [48]. | The TUI provides streaming tool output, and the terminal supports interrupt-and-redirect [48]. That is an interface capability, not proof of a durable event channel to a parent run. | Cross-session conversation search, memory, and hibernating environments support continuity [48]. A formal run resume token or receipt protocol is not established. | Interrupt-and-redirect is official at the interactive surface. Durable cancellation, lease revocation, and descendant cancellation are unknown. | No authoritative scoped cleanup contract for cron-created processes, secrets, worktrees, or subagents is established in the README. | Rich open-source adapter/runtime, but use a Memory-owned wrapper for leases and cleanup. |

**Decision rule.** A capability is native only when the product documentation defines its trigger, state, and lifecycle. If a local adapter polls a log, stores a cursor, or kills a process, label that behavior adapter-emulated. This distinction prevents a compatibility layer from accidentally promising guarantees that the underlying tool does not provide.

## 3. Recommended Asymmetric Architecture: Memory Owns the Contract

The proposed asymmetry is sound, with one naming and boundary correction. Memory should mean a durable work ledger and policy plane, not a semantic search database. Flow should mean one or more replaceable execution strategies, not a second workflow authority.

### The canonical model

Memory owns these records:

1. **Issue and intent**: immutable external reference, normalized goal, requester policy, repository scope, and privacy class.
2. **Workflow**: versioned plan or policy that defines allowed transitions, retry budget, test policy, and required capabilities.
3. **Run and attempt**: stable run id, attempt id, parent run, executor identity, model/provider metadata, and state transition history.
4. **Lease**: owner, expiry, fencing token, renewal policy, and cancellation generation. A stale worker must be rejected even if it continues executing locally.
5. **Work Packet**: a bounded, signed or integrity-checked request containing only the context and capabilities needed for one step.
6. **Receipt**: accepted, started, progress, blocked, succeeded, failed, cancelled, or expired status; artifact references; test evidence; and idempotency key.
7. **History and privacy**: retention, deletion, redaction, access audit, and user-visible history.

Flow receives a packet and returns events or a receipt. It may run Claude Code, Codex, Cursor, Hermes, OpenHands, a custom loop, or a human. It may checkpoint internally, but those checkpoints are not canonical until Memory accepts them. Flow must not directly mutate issue state, rotate leases, or write an authoritative receipt without going through the Memory interface.

The packet interface should have four operations: `claim`, `heartbeat`, `emit`, and `complete`. `claim` is conditional on a fencing token. `heartbeat` renews a lease. `emit` accepts deduplicated progress and artifact references. `complete` is a compare-and-set transition from the current attempt state. Every operation carries `run_id`, `attempt_id`, `sequence`, `idempotency_key`, `contract_version`, and executor capability facts.

### Comparison of structural options

| Option | Strength | Main failure mode | Decision |
|---|---|---|---|
| Memory-first modular monolith | One transaction boundary, easy debugging, fast package refactoring, one canonical writer | Internal coupling can remain hidden; scale is not independent | **Choose first**. Enforce package APIs and contract tests. |
| Neutral protocol product | Broad ecosystem appeal and lower product bias | A protocol without authority does not solve leases, history, privacy, or rollback; standards become a second product | Use a neutral wire contract as a capability, not as the first company/product boundary. |
| Plugin-only architecture | Low operational cost and easy local experimentation | Plugins share process, dependencies, credentials, and failure domain; cleanup and isolation are weak | Use plugins for local Flow adapters after Memory contracts stabilize. |
| Separate Memory and Flow services | Independent scaling, deployment, and security boundaries | Network retries, schema drift, lease races, observability, and release coordination arrive immediately | Earn this split after failure tests and real load justify it. |
| Separate repositories immediately | Clear ownership and independent releases | Cross-repo PR choreography and incompatible versions slow every architectural change | Anti-recommendation for the first restructuring phase. |

This is not a case for a permanent monolith. It is a case for delaying a distributed system until its contracts have operational evidence. The Memory/Flow asymmetry is better than a neutral protocol product because it assigns responsibility. It is safer than immediate services because it keeps the first authority transaction local. It is more durable than plugins because the protocol survives replacement of any plugin.

## 4. Protocol Layer: MCP, A2A, and AG-UI Without Authority Leakage

Use protocol standards at their natural layers. MCP is a tool and server interaction boundary. Its Tasks work describes durable task state around long-running requests, but the platform should map MCP task identifiers to a Memory attempt rather than make an MCP server the owner of an issue. A2A is appropriate for a remote Flow executor that advertises capabilities, accepts a task, returns artifacts, and supports streaming or asynchronous delivery. The A2A task remains an execution projection of the Memory run.

AG-UI is a frontend interaction layer. Its documentation describes a streaming event-based architecture in which events are the fundamental communication units between agents and frontends [27]. That makes it useful for `RunStarted`, `ToolCall`, `TextDelta`, `Artifact`, `ApprovalRequired`, `RunFinished`, and `RunError` projections. It does not by itself define leases, durable retention, issue authority, or exactly-once delivery.

The internal protocol should therefore be richer than a UI stream and narrower than a universal agent standard. Define a canonical event envelope with: `event_id`, `run_id`, `attempt_id`, `sequence`, `event_type`, `occurred_at`, `producer`, `contract_version`, `payload_ref`, and `privacy_class`. At-least-once delivery is the safe default. Consumers deduplicate by `event_id` and reject sequence regressions unless a replay mode is explicitly requested.

Capability negotiation belongs at the Flow boundary. A worker should advertise capabilities such as `streaming`, `resume`, `cancel`, `workspace_snapshot`, `multi_repo`, `mcp_tasks`, `a2a_push`, `test_impact_analysis`, and `scoped_cleanup`. Memory then chooses a workflow policy compatible with the advertised set. If a worker lacks `cancel`, Memory can mark the attempt cancellation-requested, revoke the lease, and quarantine late receipts rather than pretending that the process stopped.

## 5. Package Extraction, Repository Splitting, and Rollback

### Stage 1: package boundaries inside one repository

Start with a dependency rule, not a directory move. `work-ledger` may depend on storage abstractions and contract types, but never on a specific agent SDK. `flow-runtime` may depend on the packet interface, but never update the issue table directly. `observers` may consume events but cannot mutate canonical state. `protocol-contracts` contains schemas, version rules, test fixtures, and compatibility vectors.

Use a compatibility facade around the existing API. The facade translates legacy commands into canonical Memory commands and translates canonical receipts back into the old response shape. The Strangler Fig pattern is appropriate because a facade can route selected requests to new functionality while the legacy path continues to serve the rest; the pattern is explicitly intended to reduce migration risk through incremental replacement [39] [41]. Do not make the facade a second business implementation. It must be a translation and routing layer with metrics.

### Stage 2: event history and one writer

Use an append-only run event log if replay, audit, or reconciliation is a real requirement. Do not event-source every token delta by default. Persist state-changing commands and materialize views for the UI, while treating verbose model output as an expiring artifact unless retention policy says otherwise.

For side effects, use a transactional outbox. The command transaction writes the canonical state change and an outbox record; a publisher retries delivery; consumers deduplicate. The outbox guidance supports reliable event publication, but it does not remove the need for idempotent consumers or define exactly-once external effects [46]. All external effects need an idempotency key, such as `run_id + attempt_id + effect_type + logical_target`.

Use dual reads, but avoid dual-authority writes. First, the old store remains canonical while the new projection reads and compares. Then the new projection becomes the read path behind a feature flag. Only after parity is proven should the new ledger become the canonical writer. Never let old and new systems both accept authoritative writes without a conflict protocol. If rollback is needed, route reads and writes back to the old writer, stop new claims, replay the event or outbox stream, and fence late workers with a generation token.

### Stage 3: repository and release extraction

Extract a repository only when a package has a stable owner, contract tests, an independent release need, and an operational reason to scale or isolate it. Publish a signed cross-repository BOM containing exact versions, source revisions, dependency hashes, contract schema versions, and build provenance. GitHub describes an SBOM as a representation of repository dependency state in SPDX format [34]. Artifact attestations establish where and how an artifact was built [32]. These are valuable integrity controls, but an SBOM does not prove API compatibility and provenance does not prove behavioral correctness.

Use three compatibility axes: wire contract, data/schema, and behavioral capability. Semantic Versioning requires a declared public API and distinguishes backward-compatible minor additions from breaking major changes [44]. For event schemas, prefer additive fields, tolerant readers, explicit deprecation windows, and N/N-1 consumer compatibility. For workflows, use worker versioning or equivalent routing so in-flight runs remain on a compatible implementation [20].

Rollback must be a designed command. Define how to pause new claims, drain or fence attempts, restore the previous worker version, route to the previous facade, preserve receipts, and replay missing events. A release that can deploy forward but cannot stop claims or reject stale receipts is not rollback-capable.

## 6. Lowering Test and Token Cost Without Lowering Quality

Test impact analysis is the primary lever. TIA analyzes a source call graph to identify tests affected by production changes [45]. The research base is not a single anecdote: the systematic review identified **27 papers**, **36 empirical studies**, and **28 regression-selection techniques** [47]. That evidence supports selective execution, but not blind trust in a graph.

Implement an exact-candidate matrix. For every changed file, symbol, public contract, event type, database migration, and permission, record candidate unit, integration, contract, end-to-end, security, and migration tests. Add a risk owner and a reason for inclusion. The selector produces three sets: `required`, `recommended`, and `blocked-unknown`. Any change that touches authorization, lease fencing, persistence, migration, or cross-repository contracts automatically expands to the full relevant suite.

Use risk ownership rather than a single global threshold. The owner of a domain declares its high-risk surfaces and the fallback suite. A false-negative incident promotes the missed dependency to a permanent matrix rule. Track selection precision, missed-test defects, time saved, and token budget by run. If the graph is stale or the change is ambiguous, fail open to broader tests rather than silently claiming coverage.

Separate deterministic observers from agent diagnosis. AWS describes observer and monitoring agents as passive listeners that observe systems and telemetry, detect patterns, and trigger actions without directly initiating behavior [36]. In this platform, deterministic observers should first parse exit codes, structured test results, lease violations, event sequence errors, and changed-file maps. A server-side model may summarize a bounded failure bundle after those facts are collected. The client agent should not spend tokens polling dashboards or restating logs.

Use event-driven monitoring with bounded payloads. Emit one deduplicated event for a state change, not a heartbeat-sized transcript. Store raw logs outside the model context, hash or reference them, and send the agent only the failing test, relevant diff, prior attempt receipt, and next permitted action. This is both a token optimization and a correctness measure: the agent reasons from stable facts rather than a noisy stream.

## 7. Privacy-Safe Feedback and Cloud Triage

The client feedback path should be an explicit user action, not implicit telemetry. Default payload: category, free-text description, application version, contract version, a random feedback id, and optional user-selected logs or diff excerpts. Do not include account identity, device identifiers, filesystem paths, repository URLs, environment variables, full transcripts, or source code unless the user deliberately attaches them. Do not rely on client-side model summarization; it consumes tokens and may leak more than the user intended.

Apply deterministic redaction before upload. Remove secrets, access tokens, email addresses, absolute paths, hostnames, and repository remotes. Show the redacted preview and let the user edit it. The server should record the minimum envelope needed for deduplication and triage, with separate retention for metadata and content. Diagnostic data categories need to be treated explicitly; Android's privacy guidance distinguishes crash-log data such as crash counts and stack traces as a data category [37].

Use two channels. Normal product feedback goes to an anonymous intake queue. Security reports go to a private vulnerability channel; GitHub documents private vulnerability reporting that lets anyone submit a report directly and privately to maintainers [42]. A cloud triage worker can classify, deduplicate, label, and suggest routing, but it should not push code, delete issues, or change repository settings. Those permissions are unnecessary for triage.

The triage pipeline should be server-side and event-driven: ingest, redact again, hash a normalized signature, group duplicates, assign a risk label, and create a ticket only after policy checks. If an LLM is used, send the minimum redacted bundle from the server and retain the model output according to the same privacy policy. The initiating client pays no model-token cost for collection or classification. Never use feedback text to write durable agent memory automatically; require explicit maintainer approval to convert a report into a trusted Knowledge or project-instruction item.

## 8. Pull Request Strategy for an Architecture Train

| PR class | Appropriate content | Review value | Main hazard | Recommendation |
|---|---|---|---|---|
| Small, usually under one conceptual seam | Rename and move, contract type, facade adapter, event envelope, one test matrix rule, documentation | Google says small CLs are reviewed more quickly and more thoroughly because reviewers can find short review windows and avoid comment overload [40]. | Reviewers may approve locally without seeing the eventual architecture. | Use continuously. Every small PR states the target boundary and compatibility rule. |
| Medium, one vertical slice | Create run, claim lease, execute one Flow adapter, emit receipt, expose one UI projection | Preserves enough behavior to test end to end while remaining understandable. | Hidden coupling appears when the slice crosses storage, protocol, and runtime. | Use stacked PRs with contract tests, failure injection, and a rollback switch. |
| Large, unavoidable cutover | Mechanical repository split, generated schema migration, mass import, final routing flip | Can preserve atomicity for changes that are unsafe to land partially. | Review fatigue, merge conflicts, buried behavior changes, untestable rollback, and false confidence from green mechanical checks. | Keep behavior frozen, automate the diff, split review by ownership, and land only after small and medium PRs have proved the seam. |

Pull requests are a pre-integration review mechanism, not proof that the architecture is correct [35]. Large PRs become hazardous when reviewers must simultaneously infer the new domain model, verify compatibility, inspect security changes, and understand a new deployment topology. A large mechanical PR can be safer than a small semantic PR if it is generated, behavior-neutral, and backed by parity tests. Size alone is not the control; conceptual surface area and rollback difficulty are.

An architecture train should therefore be a sequence: decision record and contract, package boundary, compatibility facade, one vertical execution slice, observers and test matrix, shadow read, canary, then cutover. Each PR must have a single operational question and a revert path. Do not mix repository moves, schema changes, new retry semantics, provider replacement, and UI redesign in one train.

## 9. Red-Team Findings and Anti-Recommendations

**Premature multi-repo split.** The strongest objection is operational, not ideological. Microservices introduce more moving parts, development and testing difficulty, data-consistency concerns, and observability burden [31]. A split before the run state machine is stable creates a distributed monolith: every change still requires coordinated releases, but failures now cross networks. Anti-recommendation: do not split because package names feel crowded.

**Contract overdesign.** A universal Work Packet that includes every provider, UI, workflow, and future protocol field will become a compatibility cemetery. Start with the minimum state-changing contract and put extension data behind namespaced, versioned metadata. Do not freeze token-level streaming, model-specific reasoning fields, or provider-specific sandbox details as core fields.

**Operational complexity.** Leases, retries, outbox delivery, event sourcing, receipts, redaction, and rollback are individually sensible but collectively expensive. The inference is that each new guarantee adds a failure mode and an observable state. Keep one process and one database transaction boundary until the product can measure lease contention, duplicate effects, orphaned workspaces, and reconciliation latency.

**Vendor lock-in.** LangSmith, Temporal, OpenHands, MCP, A2A, AG-UI, and hosted coding agents are useful, but their state models should remain adapters. Keep canonical run IDs, receipts, privacy classes, and event envelopes in an open schema. Store vendor IDs as optional references. If a Flow provider disappears, Memory must still show the run, revoke the lease, and dispatch the packet elsewhere.

**Memory poisoning.** Cursor explicitly warns that automation memories can be influenced by untrusted input and may become misleading or malicious [29]. The same risk applies to auto-generated project memory, feedback, and agent-written lessons. Anti-recommendation: never promote observed text to trusted memory without provenance, scope, approval, and deletion.

**Release and versioning mistakes.** A signed BOM proves what was built and a SemVer label communicates intended API compatibility; neither proves that an old worker can interpret a new event or that a provider will honor cancellation. Require contract replay tests, N/N-1 compatibility, capability negotiation, signed release metadata, and a tested pause-and-rollback command.

**Review theater.** Small PRs reduce review burden, but a sequence of individually green PRs can still create a bad system if no one owns the end-to-end decision. Require an ADR, an operational demo, failure injection, and an explicit red-team signoff before the routing flip.

### Irreversible decisions to postpone

| Decision | Why postponement preserves optionality | Evidence needed before deciding |
|---|---|---|
| Separate Memory and Flow deployments | Avoids network and release complexity while contracts are changing | Measured load, isolation need, and failure tests |
| Event-source every model and tool token | Prevents storage, privacy, and replay cost from becoming permanent | Audit and replay requirements, retention budget |
| Make MCP or A2A the canonical domain model | Prevents standards churn from freezing product semantics | Two independent adapters and contract parity |
| Require exactly-once external effects | Exactly-once is often an application illusion across networks | Idempotency tests and effect reconciliation |
| Store all agent memory centrally | Avoids turning private local context into a liability | User need, consent, deletion and poisoning controls |
| Commit to a single hosted provider | Keeps Flow replaceable and reduces vendor lock-in | Provider-neutral benchmark and migration exercise |

## 10. Staged Execution Plan With Exit Criteria

**Phase 0 - Freeze the problem, not the implementation.** Write an ADR that names Memory as authority and Flow as executor. Define the state machine, packet, receipt, lease, event envelope, privacy classes, and capability vocabulary. Exit only when invalid transitions, stale receipts, and cancellation states are enumerated.

**Phase 1 - Modular monolith.** Create packages and dependency checks. Put all legacy calls behind the compatibility facade. Implement one in-process Flow adapter and one fake adapter that injects timeout, duplicate receipt, stale lease, partial artifact, and cancellation races. Exit when contract tests pass against both adapters.

**Phase 2 - Observability and cost controls.** Add deterministic observers, outbox publication, exact-candidate matrices, risk ownership, and bounded failure bundles. Measure test-selection precision, tokens per successful run, duplicate events, orphan resources, and time to reconcile. Exit only if selective testing has a full-suite fallback and no silent coverage loss.

**Phase 3 - Shadow migration.** Keep the old writer canonical. Build the new ledger projection with dual reads and compare state, receipts, and history. Redact and retention-test feedback. Exit when parity holds across normal, retry, cancel, restart, and crash-recovery scenarios.

**Phase 4 - Controlled authority cutover.** Flip one repository or tenant at a time to the new writer behind a feature flag. Fence old workers, drain claims, and keep a reversible route to the old facade. Use signed artifacts, BOMs, contract replay, and N/N-1 compatibility. Exit when rollback has been performed in a staging failure drill, not merely documented.

**Phase 5 - Optional Flow extraction.** Extract Flow to a separate package, then a separate repository or service only if independent scaling, sandbox isolation, or release cadence is demonstrated. Offer MCP, A2A, and AG-UI adapters at this stage. The first remote Flow should be deliberately less trusted than the in-process adapter so that the authority boundary is exercised.

## Synthesis

Across the market, durable context and execution are separated by different mechanisms: files and Knowledge in Claude Code, Codex, Cursor, and Devin; issue and PR systems in GitHub and Claude Code; checkpoints in LangGraph; workflow histories and worker versions in Temporal; and runtime APIs in OpenHands. The mechanisms differ, but the design signal is consistent: the agent loop is replaceable, while context, work identity, history, and policy must outlive it.

The key tension is between Cursor, Devin, Hermes, and Codex, which are moving toward always-on automation, and the incomplete lifecycle contracts documented for several of them. Trigger breadth is not durability. A schedule can start work without defining how a lease expires, how a duplicate trigger is deduplicated, how an initiating agent receives events, or how a VM and secret are cleaned up. Claude Code currently provides the clearest documented example of PR event monitoring and session restoration, but even its docs leave separate in-progress cancellation semantics open [21]. The platform should compete on these boring guarantees rather than imitate another trigger catalog.

The second tension is between neutral interoperability and product authority. MCP, A2A, and AG-UI make it easier to connect tools, agents, and interfaces, but a connection protocol cannot decide which receipt is canonical, who owns a lease, which history may be deleted, or whether a late worker may publish a result. Therefore the best architecture is asymmetric in responsibility but neutral in execution: Memory owns the durable contract; Flow can be any compliant adapter.

The final tension is speed versus reversibility. Small PRs, selective tests, and event-driven observers reduce cost, but only if risk ownership, full-suite escape hatches, and end-to-end review remain. The recommended architecture earns its future multi-repo shape through package seams, compatibility facades, one-writer migrations, signed release evidence, and rollback drills. It does not assume that a clean repository split is the same thing as modularity.

## References

1. *Automations - Cursor*. https://cursor.com/changelog/03-05-26
2. *Starting GitHub Copilot sessions*. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
3. *LangSmith Observability*. https://docs.langchain.com/langsmith/observability
4. [
  Custom instructions with AGENTS.md | ChatGPT Learn
](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
5. *Activity Definition | Temporal Platform Documentation*. https://docs.temporal.io/activity-definition
6. *Knowledge*. https://docs.devin.ai/product-guides/knowledge
7. *Software Agent SDK - OpenHands Docs*. https://docs.all-hands.dev/sdk/index
8. *Introducing Devin*. https://docs.devin.ai/get-started/devin-intro
9. *Persistence*. https://docs.langchain.com/oss/python/langgraph/persistence
10. *Persistence*. https://docs.langchain.com/oss/python/langgraph/durable-execution
11. *Introducing the Codex app | OpenAI*. https://openai.com/index/introducing-the-codex-app/
12. *Adding repository custom instructions for GitHub Copilot*. https://docs.github.com/en/copilot/how-tos/custom-instructions/adding-repository-custom-instructions-for-github-copilot
13. *OpenHands/openhands/runtime at main - OpenHands/OpenHands - GitHub*. https://github.com/OpenHands/OpenHands/tree/main/openhands/runtime
14. *Scheduled Sessions*. https://docs.devin.ai/product-guides/scheduled-sessions
15. *Hooks reference*. https://code.claude.com/docs/en/hooks
16. *Streaming & Asynchronous Operations - A2A Protocol*. https://a2a-protocol.org/latest/topics/streaming-and-async/
17. *Build agents that run automatically - Cursor*. https://cursor.com/blog/automations
18. *Introducing Codex | OpenAI*. https://openai.com/index/introducing-codex/
19. *OpenHands/openhands/runtime/README.md at main - OpenHands/OpenHands - GitHub*. https://github.com/OpenHands/OpenHands/blob/main/openhands/runtime/README.md
20. *Worker Versioning*. https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning
21. *Use Claude Code on the web*. https://code.claude.com/docs/en/claude-code-on-the-web
22. *How Claude remembers your project*. https://code.claude.com/docs/en/memory
23. *About GitHub Copilot cloud agent*. https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
24. *Specification - A2A Protocol*. https://a2a-protocol.org/v0.3.0/specification
25. *Fetched web page*. https://cursor.com/docs/cloud-agent
26. *Create custom subagents*. https://code.claude.com/docs/en/sub-agents
27. *Events*. https://docs.ag-ui.com/concepts/events
28. *SEP-1686: Tasks*. https://modelcontextprotocol.io/seps/1686-tasks
29. *Automations | Cursor Docs*. https://cursor.com/docs/cloud-agent/automations
30. *Tasks*. https://modelcontextprotocol.io/extensions/tasks/overview
31. *Microservices Architecture Style - Azure Architecture Center | Microsoft Learn*. https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/microservices
32. *Using artifact attestations to establish provenance for builds*. https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
33. *Microservices*. https://martinfowler.com/articles/microservices.html
34. *Exporting a software bill of materials for your repository*. https://docs.github.com/code-security/supply-chain-security/understanding-your-software-supply-chain/exporting-a-software-bill-of-materials-for-your-repository
35. *Pull Request*. https://martinfowler.com/bliki/PullRequest.html
36. *Observer and monitoring agents*. https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/observer-and-monitoring-agents.html
37. *Declare your app's data use -|- Privacy -|- Android Developers*. https://developer.android.com/privacy-and-security/declare-data-use
38. *SLSA - Security levels*. https://slsa.dev/spec/v1.0/levels
39. *Strangler Fig Pattern - Azure Architecture Center | Microsoft Learn*. https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig
40. *Small CLs | eng-practices*. https://google.github.io/eng-practices/review/developer/small-cls.html
41. *How to break a Monolith into Microservices*. https://martinfowler.com/articles/break-monolith-into-microservices.html
42. *Privately reporting a security vulnerability*. https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability
43. *Firefox Privacy Notice - Mozilla*. https://www.mozilla.org/en-US/privacy/firefox/
44. *Semantic Versioning 2.0.0 | Semantic Versioning*. https://semver.org/
45. *The Rise of Test Impact Analysis*. https://martinfowler.com/articles/rise-test-impact-analysis.html
46. *Implement the Transactional Outbox Pattern by Using Azure Cosmos DB - Azure Architecture Center | Microsoft Learn*. https://learn.microsoft.com/en-us/azure/architecture/databases/guide/transactional-out-box-cosmos
47. *A Systematic Review on Regression Test Selection ...*. https://fileadmin.cs.lth.se/cs/Personal/Emelie_Engstrom/Papers/IST_syst_review_regr_test.pdf
48. *GitHub - NousResearch/hermes-agent: The agent that grows with you - GitHub*. https://github.com/NousResearch/hermes-agent
