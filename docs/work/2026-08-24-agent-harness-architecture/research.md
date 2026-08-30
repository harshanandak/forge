# Forge multi-harness and skill-orchestration architecture

Decisions needed: none. The user selected control-plane first; D1-A, D2-A, and D3-A are the accepted roadmap decisions.

**Issue:** `f831f7c5-7e48-4a77-b327-a0c572828b8b`
**Parent:** `44ed41f0-eda8-41a6-93cc-64ac350cc497`
**Historical research base:** `origin/master` at `f2a688add5345c00fc37f8a8347542ab4b5fd1e1`
**Refreshed base:** `origin/master` at `37ffef8202c5d5853613834e2cc1eb6b4d7a0f6d` on 2026-08-30
**Scope:** research, architecture, plan correction, and issue decomposition only; no runtime implementation in this branch.

## Executive decision

Forge should become the control plane for a **versioned agent-runtime protocol**, not a universal agent implementation and not a Cordis port.

The smallest coherent design is:

1. **Forge Kernel owns durable authority:** issue, plan DAG, worktree, lease, run state, evidence, decisions, and terminal policy.
2. **Agent Config owns operator policy:** reachability, model/cost weights, privacy constraints, enabled skill groups, and per-machine projections.
3. **Agent Companion owns portable execution:** idempotent work requests, durable jobs, controls, traces, and receipts.
4. **Harness adapters own translation:** Codex, Claude, OpenCode, Pi, and DeepSeek Harness each negotiate real capabilities and translate the common protocol without copying credentials.
5. **Skills are packages with executable metadata:** invocation class, conflicts, requirements, outputs, supported ABI, and completion predicates. A deterministic resolver selects one process skill and any compatible technique skills.
6. **Plugins are replaceable capability providers:** reversible in-process registrations, explicit draining/cancellation, versioned contracts, and transactional profile reconciliation. External writes remain governed by commit/compensation rules because they cannot be made reversible by a plugin framework.

This directly addresses the strongest cross-session pattern: Forge currently has good individual mechanisms, but their state is split across prose, plans, Kernel rows, worktrees, PRs, plugin caches, host sessions, and child-agent messages. More trigger prose will not reconcile those authorities.

## Evidence method

Claims use the five-rung evidence ladder:

- **Rung 2 — pointed at the artifact:** a line or exact source ref was inspected.
- **Rung 4 — ran it:** a real command, test, or executable probe was run.
- **Rung 5 — live system:** the installed host/plugin inventory or runtime was queried after the operation.

Transcript keyword counts below are Rung 2 frequency signals. They overlap, can be triggered by pasted briefs, and are not defect rates. Confirmed incidents are listed separately. Source-repository facts are bound to exact commits; local dirty projects are observations, not upstream truth.

## Source ledger

| Source | Bound version / location | What it supports | Evidence |
|---|---|---|---|
| Forge | historical `f2a688add5345c00fc37f8a8347542ab4b5fd1e1`; refreshed `37ffef8202c5d5853613834e2cc1eb6b4d7a0f6d` | Skill metadata, chain schema, harness inventory, plans, Kernel issues, and the current delivery graph | Rung 2; live Kernel/worktree state Rung 4 |
| DeepSeek Harness | [`b150a551`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e) | Plugin-first architecture, profiles, capability seams, event/log model, SDK limits | Rung 2 |
| DSH architecture | [`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/architecture.md) | Everything-as-plugin composition and provider replacement | Rung 2 |
| DSH Cordis primer | [`docs/cordis-primer.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-primer.md) | Context services, injection, dispatch modes, reversible effects | Rung 2 |
| DSH packages | [`packages/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/README.md) | Service-definition/provider/consumer package boundaries | Rung 2 |
| DSH SDK server | [`packages/sdk/server/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/sdk/server/README.md) | Stdio JSON-RPC admission/event surface and current limitations | Rung 2 |
| Cordis paper | [`cordiverse/paper@13f2858`](https://github.com/cordiverse/paper/tree/13f28585668a28106b2f53bedada36e45bc1ed3e) and local 88-page PDF | Reversible effects, reactive coeffects, lifecycle, HMR, guarantees and limitations | Rung 2; representative render visually checked |
| Matt Pocock skills | [`5b15a47`](https://github.com/mattpocock/skills/tree/5b15a47f2d7150f545fbcacbfe381787fc0230dc) | User/model invocation split, progressive disclosure, trigger mechanics | Rung 2 |
| Invocation contract | [`.agents/invocation.md`](https://github.com/mattpocock/skills/blob/5b15a47f2d7150f545fbcacbfe381787fc0230dc/.agents/invocation.md) | User-only workflows cannot be model- or skill-invoked | Rung 2 |
| Skill mechanics | [`SKILL-MECHANICS.md`](https://github.com/mattpocock/skills/blob/5b15a47f2d7150f545fbcacbfe381787fc0230dc/skills/productivity/writing-for-agents/SKILL-MECHANICS.md) | Context load, cognitive load, routers, and invocation boundaries | Rung 2 |
| Pstack | [`cursor/plugins@4612556`](https://github.com/cursor/plugins/tree/46125561306434d8a1d7745d540d8932ab0cd2a2/pstack) | Transcript mining, independent judging, isolated overnight loops, auditable decisions | Rung 2 |
| Pstack transcript mining | [`automate-me`](https://github.com/cursor/plugins/blob/46125561306434d8a1d7745d540d8932ab0cd2a2/pstack/skills/automate-me/SKILL.md) | Promote only recurring patterns from independent transcript slices | Rung 2 |
| Pstack autonomy | [`07-overnight.md`](https://github.com/cursor/plugins/blob/46125561306434d8a1d7745d540d8932ab0cd2a2/pstack/docs/guide/07-overnight.md) | Falsifiable finish condition, worktree, decision log, escape hatch | Rung 2 |
| Pstack multi-judge | [`interrogate`](https://github.com/cursor/plugins/blob/46125561306434d8a1d7745d540d8932ab0cd2a2/pstack/skills/interrogate/SKILL.md) | Same prompt/rubric across independent judges; lead resolves disagreements | Rung 2 |
| OpenViking | [`volcengine/OpenViking@2c88269d`](https://github.com/volcengine/OpenViking/tree/2c88269d5440b55456db4209866564d329e6308b) | Filesystem-shaped resource/memory/skill context, tiered loading, observable retrieval, and host integrations | Rung 2 |
| Mem0 | [`mem0ai/mem0@19cb89af`](https://github.com/mem0ai/mem0/tree/19cb89aff472325c707f64b2f34ae6afdbf7faf7) and [how it works](https://github.com/mem0ai/mem0/blob/19cb89aff472325c707f64b2f34ae6afdbf7faf7/docs/core-concepts/how-it-works.mdx) | Scoped fact extraction and retrieval; inferred memories versus verbatim storage | Rung 2 |
| Graphiti | [`getzep/graphiti@8b61fce9`](https://github.com/getzep/graphiti/tree/8b61fce9f003cc3a05e246f6201f8b782dfe6546) | Temporal facts, episode provenance, supersession, and hybrid graph retrieval | Rung 2 |
| Supplied video transcript | `.codex/attachments/6d6596a8-c453-4d7e-974d-d716f1127aff/pasted-text.txt` | Intent behind Matt/Pstack usage: adapt, do not copy; descriptions are triggers | Rung 2 |
| Agent Companion | `C:\\Users\\harsha_befach\\Downloads\\agent-companion` | Durable job/receipt/control implementation and host integrations | Rung 2; installed inventories queried at Rung 5 by audit worker |
| Agent Config | `C:\\Users\\harsha_befach\\agent-config` | Global routing policy, weights, reachability, and projections | Rung 2 |
| DSH agent workers | `C:\\Users\\harsha_befach\\dsh-agent-workers` | Cordis bundle patch and external CLI worker tools | Rung 2; prior live smoke evidence, current executable version probed |
| Session corpus | Curated rollout summaries and representative Codex, Claude, and OpenCode root sessions | Recurring failure taxonomy and representative incidents; exact archive totals removed because the source list is not tracked with this artifact | Rung 2 |

The user's “Coddisk paper” is read as **Cordis** with high confidence: DeepSeek names Cordis as the Harness foundation in its pinned [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/architecture.md) and [Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-primer.md), and this audit found no distinct “Coddisk” agent-harness paper.

Public repository pages and local Forge issue, branch, worktree, Bun, test-runner, and executable state were refreshed on 2026-08-30. Live bounded probes returned Codex `0.151.0`, Claude Code `2.1.251`, OpenCode `1.18.25`, Pi `0.84.3`, and DSH `0.1.0-rc.7`.

## What the transcript is actually asking us to copy

The useful mechanism is not Matt's or Pstack's exact skill list. It is the separation of concerns behind it:

- A skill description is a **retrieval trigger**, not a compressed manual.
- Invasive, choice-heavy workflows are human-invoked; reusable discipline primitives can be model-invoked.
- A router helps the user discover human-only workflows but does not silently run them.
- Context is progressively disclosed; shared reference has one owner.
- History mining should promote repeated patterns, not one memorable failure.
- Independent candidates use the same prompt and rubric; the lead records agreement and disagreement.
- Autonomous loops need a falsifiable finish predicate, isolation, permissions, a decision trail, and an escape hatch.
- Personal/global configuration should have a canonical source and project/harness projections; copied installations become drift.

Forge should adapt those mechanics into its Kernel and adapter model. It should not import another fixed stage ladder or a Cursor-specific orchestration hierarchy.

## Current-state findings

### 1. Invocation metadata exists but is not an executable boundary

At the research base, `ship`, `review`, and `rollback` declare `invocation: user`, but `lib/using-forge.js` drops invocation from catalog entries and the current routing test explicitly expects behavior to remain unchanged. Mandatory chain metadata still routes `validate -> ship -> review -> verify`. This makes `invocation: user` descriptive rather than enforced.

The chain model also overloads three meanings:

- dynamic dispatch from an umbrella/router;
- return to a caller after a reusable primitive;
- a true terminal workflow state.

`terminal: true` and one scalar `next` cannot represent classification-dependent flows, pre/post-merge checkpoints, or reusable subroutine return. This is a root cause of the reported "four skill" conflicts: the skills are individually reasonable, but their invocation and continuation semantics are under-specified.

### 2. Supported harnesses are hard-coded, not negotiated

`docs/reference/AGENT_SKILL_PARITY.md`, `lib/harness-capability-matrix.js`, and `lib/capabilities/probes.js` enumerate Claude, Codex, Cursor, and Hermes. Pi, OpenCode, and DSH currently have no first-class Forge adapter/probe identity. The probe implementation throws for an unknown harness, so adding support is not a documentation-only change.

This conflicts with the user's current product direction and with local working integrations. It requires an explicit amendment to the earlier supported-harness decision, not a silent edit.

### 3. Canonical plans and design indexes do not reconcile themselves

The approved product-restructure task list still presents Task 0 / PR1 as the next action, while the Kernel epic records later PR waves completed and PR5 open. The decisions file retains a pending decision even though dependent implementation has advanced. `docs/PROJECT_DESIGN.md` describes itself as current while retaining superseded Beads language, the legacy harness set, and an old canonical skill path. The release plan's package version also differs from `package.json`.

These are symptoms of a structural gap: Markdown plans are write-only caches of Kernel state. Updating them manually will fix today's lines but not the recurrence.

### 4. Local projects have clear roles, but their installers and policies conflict

#### Agent Companion

The working source implements lead host -> one companion -> one downstream adapter -> durable receipt. It already has normalized request digests, leases, status/control/resume, atomic snapshots, append-only traces, MCP tools, and Codex/Claude/OpenCode/Pi host bridges. It does not implement cross-harness workflow phases, and it should not become Forge's scheduler.

#### Agent Config

The source of truth is `C:\\Users\\harsha_befach\\agent-config`, not Downloads. It owns routing prose, weights, objective, reachability, and sync projections. Nothing compiles that policy into Agent Companion's routing configuration or resolver, so the two systems can disagree while both appear valid.

#### DSH agent workers

The local Cordis plugin is a thin tool provider: it registers Codex/OpenCode/Claude/Pi subprocess tools, confines real paths, bounds execution, and handles cancellation/timeout. It returns a bounded result but has no durable job, trace, steering, or resume protocol. It overlaps Agent Companion at the process-launch layer and should become an adapter/provider behind the same protocol, not a second scheduler.

#### Confirmed integration conflicts

1. `~/.agents/skills/handoff` and `~/.agents/skills/agent-companion` are broken junctions to a missing old source, while Codex and Claude plugin caches point to the Downloads copy.
2. The Pi installer copies `handoff` into `~/.pi/agent/skills`, while Agent Config treats entries there as an error because Pi already reads the shared hub.
3. The OpenCode installer copies a real skill directory, while Agent Config expects links into the shared hub.
4. Routing has two authorities: Agent Config policy and Agent Companion candidate/rule/resolver data.
5. The handoff request has no enforceable provider-policy/privacy capability, so per-request zero-data-retention routing cannot be proven.
6. The handoff skill documents one automatic, read-only resume, but core resume accepts any terminal job and unlimited retries.
7. The DSH adapter rejects read-only requests because rc.7 exposes no permission flag, making it unusable for safe audit fan-out; unrestricted writes are the only accepted mode.
8. Agent Config forbids non-Claude hosts from invoking Claude, while the DSH plugin registers a callable `claude_worker` without that central constraint.
9. OpenCode V1/V2 guidance and defaults disagree across routing docs, changelog, and adapter code.

### 5. A live lease probe exposed actor identity leakage

`forge issue owns <id> --actor codex-root-01a02ffc --json` reported actor `forge` and `owned: false`, even though the issue row showed `claimed_by: codex-root-01a02ffc`. Setting `FORGE_ACTOR=codex-root-01a02ffc` made the same proof return `owned: true`. This is Rung 4 evidence of a CLI/operator mismatch and must be covered by a focused issue or existing actor-propagation issue.

The focused fix now exists on remote branch `fix/actor-session-identity` at `4df1e1195fc80bf6c67959a6f1d089cffe3be0c5`. It resolves identity once, rejects ignored `--actor` flags, and returns actor/session identity in mutation results. Focused tests and independent reviews passed. The issue remains open because full validation exposed a separate Bun process-level test error; no identity assertion failed.

Two supporting fixes are already delivered on remote branches:

- Issue path forwarding (`2aa2d58f-078a-4003-a9c4-04eea48410fd`) is closed at `a0b8f7e19301f4fdf85371baf4e45e6ca73843f7`.
- Shard termination diagnostics (`15d5d9f2-c0bf-48ef-92ca-62d3a9f7f77a`) are closed at `4241dcb0c02c2c7ccf451cc4d70a01671f232b08`.

The remaining runner issue (`465f7e62-1928-4bcf-97a5-c2db05504a7e`) is isolated, not a reason to expand the control-plane design. Bun 1.3.12 emitted one `Unhandled error between tests` outside its green JUnit file. Bun 1.4 still tracks between-test errors separately from test-case failures in its [test runner](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/runtime/test_runner/bun_test.rs#L1204-L1252), and its [release notes](https://bun.com/blog/release-notes/bun-v1.4.0#other-test-runner-fixes) do not claim that JUnit absorbs those process-level errors. That is not a Bun 1.4 reproduction, so the correct conclusion is only that 1.4 has not been proven to repair the condition. Forge must continue requiring both exit code zero and a complete green receipt.

## Cross-session failure taxonomy

### Sampling boundary

The read-only audit sampled curated rollout summaries and root-only sessions while excluding spawned child sessions and injected instructions. The recurring categories were handoff/context loss, continuation drift, worktree/authority mismatch, incomplete verification, skill-invocation conflict, plan/task drift, and underused parallelism. Because the exact source list is not tracked with this artifact, these categories support the qualitative taxonomy below, not prevalence or completion-rate claims.

### Ranked root causes and product remedies

| Rank | Root cause | Representative evidence | Product remedy |
|---:|---|---|---|
| 1 | Handoff is prose, not durable run state | Manual reconstruction across Claude/Codex; partial multi-track runs; unreconciled Volleyball artifacts | `WorkItem -> Run -> Attempt` with ordered events, receipts, exact next predicate, and host-session mapping |
| 2 | Evidence has no typed subject or freshness | PRs became stale/behind; new review thread after green checks; restart/runtime verification absent | `EvidenceReceipt` bound to exact subject/ref/environment/rung and invalidation rule |
| 3 | Worktree, lease, branch, and PR facts drift independently | Stale/dirty worktrees, unshowable issue IDs, scope mismatch after successful scratch spike | One refreshable `AuthoritySnapshot` required before mutation and irreversible transitions |
| 4 | Skill invocation is prose | Missing executable commands, duplicate names, stale mirrors, invalid generated host values | Compiled namespaced skill registry with invocation, conflicts, required ABI, and fallback |
| 5 | Parallelism is prompt-driven | Explicit underuse complaints, but one slice used 10 agents, 87 waits, and about 78 minutes waiting | Schedule ready DAG leaves, event-driven completion, one owner per artifact, critical-path metrics |
| 6 | Plans do not reconcile to live state | Tracks disappear on continuation; plan docs lag Kernel/PR state | Compile plans to Kernel tasks and render/reconcile projections with drift reports |
| 7 | Terminal intent conflicts across rules | "Answer and stop", "do all tracks", "do not push", and human merge gates collide | Persist and evaluate `TerminalPolicy` after each transition |
| 8 | Harness assumptions leak | Windows path-length/shell failures, unsupported schema keywords, live-control deadlocks | Versioned adapter ABI and install/live certification receipts |

Strong incident identifiers include Codex throughput audit `019fe62b-fc12-7420-8dfe-7072e7588dc0`, cross-harness continuation `01a00e91-39b1-7ea2-b412-a344050eedee`, CuraPod remediation `01a00e44-2ba5-7e90-86dd-0692e0532f00`, Zwapit `01a009d3-8663-74f2-a18a-1c85e031ffcc` and `01a00a01-12fe-7aa0-a16e-5550b0946f06`, Volleyball `019fe383-6e6d-7440-9e51-6b392aa5e454`, DSH `01a01463-a9bd-7841-88a6-e1cbceb3605a`, and Agent Companion `01a006c1-f229-74a0-8714-18d03191d927`.

## What Cordis and DSH contribute

### Mechanisms worth adopting

1. **Definition/provider/consumer split.** Consumers depend on a typed capability definition, not a concrete provider. This is the correct seam for Forge harness adapters.
2. **Owned reversible registrations.** Every in-process registration returns a disposer; unloading composes disposers in reverse order.
3. **Reactive dependency activation.** A plugin declares requirements and activates only when a compatible provider set exists.
4. **Authoritative desired configuration.** Profiles, bundle patches, user overlays, and CLI overlays compose to one desired plugin tree; runtime state reconciles to it.
5. **Transactional replacement.** Load/validate the candidate, preserve the old working state, switch only when coherent, and roll back failed activation.
6. **Lifecycle-aware withdrawal.** Stop advertising a provider, drain dependents while bindings remain readable, then recover provider effects.
7. **Durable vs live events.** Model-visible/session context must be reconstructable from durable log events; transient capability status remains a live stream.
8. **Capability mediation.** Plugin context exposes only declared services and can attenuate them through interceptors.

### Limits Forge must preserve

- Cordis guarantees observational reversal only for shared locations and operations mediated by its context. Ambient globals, process state, network calls, Git pushes, issue mutations, and external messages are outside that guarantee.
- Atomic inverse correctness remains the plugin author's obligation.
- External emissions need a commit boundary, withholding, an idempotency key, or a compensating action; LIFO disposers are insufficient.
- Declared capabilities are not a sandbox for untrusted code. Forge still needs worktrees, process isolation, path confinement, permission checks, output bounds/redaction, and eventually OS/container/WebAssembly isolation where risk warrants it.
- Capability key collision and version/interface compatibility remain open design problems in the paper; Forge needs explicit namespacing and compatibility ranges.
- Cyclic requirements can leave plugins inactive. Breaking cycles into smaller integration components increases cognitive and configuration cost.
- The Koishi case study demonstrates feasibility in one ecosystem, not comparative productivity, safety, or performance for agent harnesses.
- DSH's SDK currently lacks complete per-session close/cancel/per-prompt-result semantics and relies on deployment discipline for stdout purity. Forge must not pretend those capabilities exist.

### Decision on using Cordis itself

Do **not** make Cordis a Forge runtime dependency now. Adopt its contracts and testable lifecycle properties in a small TypeScript/JavaScript capability registry that matches Forge's existing runtime. Make a future Cordis-backed provider possible behind the same ABI. This avoids a second framework, ecosystem lock-in, and migration risk while preserving the architecture's useful ideas.

## Memory: keep authority local, make richer stores optional

Forge should not adopt a universal memory product as a second truth store. The default remains Kernel events plus the existing local SQLite/FTS5 projection. Improve that path with provenance before adding embeddings or a graph:

- every item carries `projectId`, optional `sessionId`, `sourceKind`, `sourceRef`, `contentHash`, authority class, capture time, and supersession/redaction state;
- verbatim artifacts and accepted Kernel events remain authoritative inputs;
- summaries, extracted facts, inferred preferences, and graph edges are proposals with source references;
- recall is project-bound and allowlisted; private cross-project/session retrieval is opt-in;
- forget, redact, export, compact, and supersede are explicit operations;
- stale or deleted source material invalidates derived projections without rewriting issue/run authority.

The three requested systems contribute different mechanisms: OpenViking and Mem0 are design references for native Forge improvements; only Graphiti remains an optional provider candidate.

| Provider | Useful mechanism | Forge boundary | Adoption trigger |
|---|---|---|---|
| OpenViking | Filesystem hierarchy, L0/L1/L2 context loading, and observable retrieval paths | Design reference only. Implement useful tiering and retrieval traces inside Forge where measurement justifies them; do not add an OpenViking connector or merge resources, skills, and memory into one authority. | A native Forge retrieval experiment beats the existing FTS5 path on quality or token cost |
| Mem0 | Scoped `user_id`/`agent_id`/`run_id` fact extraction, deduplication, and explicit inferred-versus-verbatim storage | Design reference only. Reuse the scoped-fact and proposal boundary natively; do not add a Mem0 connector or auto-promote extracted facts. | A native proposal/deduplication experiment improves the privacy-safe replay corpus |
| Graphiti | Temporal validity windows, episode provenance, supersession history, and hybrid semantic/keyword/graph retrieval | Optional temporal read model over Forge events. It may suggest relationships; it cannot close work, resolve decisions, or grant authority. | A real temporal/relationship query workload that justifies graph infrastructure and ingestion cost |

The corresponding Kernel issue is `ff843904-714d-4fe1-bcee-7925ffec60ff`. It is deliberately blocked by the authority-contract and plugin-lifecycle issues. Graphiti is the only optional integration candidate; OpenViking and Mem0 are references for native Forge improvements. Forge must operate cleanly with no external memory provider.

## Runtime performance and Bun 1.4

A frozen local comparison found Bun 1.4 materially faster on the selected Kernel and memory-recall groups (24.7% lower combined median), but the first Bun 1.4 memory run exceeded a real five-second test ceiling and the repository comparator returned `INCOMPLETE`. Bun 1.4 has not been proven to remove the green-JUnit/nonzero-exit condition described above. Keep the package pin at Bun 1.3.12 until issue `64baba16-8dc1-457f-9a98-2d57518e28f1` produces comparable, repeated evidence across correctness, variance, and the full validation surface.

## Target architecture

```text
Operator intent + Agent Config policy
                  |
                  v
        Forge plan / Kernel authority
      (Run DAG, leases, evidence, gates)
                  |
           ready WorkPackets
                  v
        Scheduler + skill resolver
        /          |           \
   inline      Agent Companion   native host child
                  |
       negotiated HarnessAdapter
       /      /       |      \
    Codex  OpenCode   Pi      DSH       (Claude only from allowed origins)
                  |
       receipts + durable events
                  v
            Run reconciliation
```

### Ownership boundaries

| Layer | Owns | Must not own |
|---|---|---|
| Forge Kernel | Issue/plan DAG, authority, worktree, run state, evidence, decisions, terminal policy | Provider credentials, harness-specific argv, model implementation |
| Agent Config | Global operator policy, reachability, weights, privacy, enabled groups, projections | Job lifecycle, issue authority, worktree mutation |
| Skill registry/resolver | Canonical identity, invocation and composition rules, compatibility, trigger explanation | Durable run state or arbitrary scheduling |
| Agent Companion | Idempotent jobs, trace, status/control/resume, receipt normalization | Forge planning/claim authority or routing-policy authorship |
| Harness adapter | Capability probe, argv/protocol translation, host session mapping, cancellation | Global policy or copied credentials |
| Plugin provider | One capability implementation and its owned effects | Unbounded ambient mutation or hidden scheduling |
| External worker | Bounded task execution in an authorized workspace | Claim release, merge, or upstream authority decisions |

## Core contracts

### `SkillManifest`

Required fields:

- `id`: namespaced stable ID, e.g. `forge.workflow.plan`.
- `version` and `requiresForge`.
- `invocation`: `user | model | internal`.
- `kind`: `process | technique | reference | router`.
- `triggers`: positive intent predicates for model-invoked skills.
- `exclusiveGroup`: at most one process skill from a group.
- `requires`, `provides`, and `conflicts` capability IDs with version ranges.
- `allowedCallers`: for example `human`, `forge.workflow.smith`, or an internal resolver.
- `inputs`, `outputs`, and checkable completion predicate.
- `supportedHarnesses` only when genuinely host-specific; otherwise required capability predicates.
- `fallback`: explicit route or `unsupported`; never silent approximation.

Resolution rule:

1. Human-explicit invocation wins if authorized.
2. Filter by CLI and capability compatibility.
3. Select exactly one primary `process` skill per exclusivity group.
4. Add compatible `technique` and `reference` skills.
5. Reject recursive user-only invocation.
6. Emit a deterministic explanation: candidates, exclusions, conflicts, selected primary, fragments, and fallback.

This replaces the current 1%-trigger pile-up with one resolver decision. `using-forge` becomes a lightweight router over the registry, not another competing workflow.

### `WorkItem`, `Run`, and `Attempt`

- `WorkItem` is the stable planned scope: purpose, success criteria, constraints, edge cases, out-of-scope boundary, dependency edges, and exact next unsatisfied predicate.
- `Run` is one authorized execution of a WorkItem: stable ID, lifecycle, owner, policy/capability snapshot, ordered events, and references to authority, decisions, artifacts, and evidence.
- `Attempt` is one executor try within a Run: stable ID, harness/session identity, one-writer file set, retry lineage, idempotency key, and terminal outcome.
- Run lifecycle: `planned -> ready -> admitted -> running -> draining -> verifying -> complete | failed | cancelled | blocked`.
- `handoff` is an ordered Run event containing the attempt ID, checkpoint, evidence references, blocker, continuation constraints, and next predicate. It is not another state store.

Older drafts called the Run record `ForgeRun` and the authority record `AuthorityBundle`. Do not implement aliases or parallel schemas; the canonical wire names are `WorkItem`, `Run`, `Attempt`, and `AuthoritySnapshot`.

### `AuthoritySnapshot`

Captured atomically for any mutating Attempt:

`{ issue, revision, actor, lease, worktree, branch, baseSha, expectedHead, pr, scopeContract, expiresAt }`

It is refreshed before mutation, push, close, release, or merge. A mismatch fails closed with a diagnostic that names the stale field. Claims are not inferred from branch names or transcript prose.

### `WorkPacket`

- immutable task intent and plan-node ID;
- authorized workspace and file ownership;
- input artifact hashes;
- required capability predicates and budget;
- read/write/network/external-effect permissions;
- model/routing privacy policy handle;
- stop conditions, cancellation token, and expected outputs;
- return contract for partial, blocked, failed, and complete outcomes.

### `EvidenceReceipt`

`{ subjectType, subjectId, repository, exactRef, environment, commandOrCheck, timestamp, rung, result, blocker, expiresWhen, artifactHash }`

Completion predicates enumerate required receipts. A base/head change, restart-required runtime, unresolved review thread, or expired lease invalidates only the affected receipt and reopens the owning node.

### `CompletionReceipt`

`{ workItemId, runId, authorityHash, requestedSubjects, evidenceRefs, verifiedAt, result }`

The Kernel issues it only after fresh verification of every requested subject. `result` is `PASS | FAIL | INCOMPLETE`; pending, unknown, timed-out, stale, or unverified subjects force `INCOMPLETE` and prevent the Run from becoming complete.

### `TerminalPolicy`

- authorized stages and desired terminal state;
- autonomous continuation rule;
- hard stops and human gates;
- external-write, push, PR, merge, and deployment authority;
- approval requirements;
- escape hatch and timeout behavior.

Questions naturally terminate after the answer. End-to-end goals continue through their authorized stages. A human merge gate remains terminal even when other policy says "do not stop."

### `HarnessAdapter`

The versioned capability response must report independently:

- executable identity/version and probe revision;
- workspace/path/shell model;
- one-shot and persistent sessions;
- addressed message, status, streaming, and event delivery;
- interrupt, prompt cancel, process-tree termination, and resume/fork;
- permission schema and external-effect modes;
- output bounds, spill artifacts, redaction, and stdout purity;
- native worktree/sandbox isolation;
- credential/auth-handle policy;
- per-request model/provider/privacy enforcement;
- live-control support and known deadlock/unsupported states.

Unknown, stale, malformed, or untested capabilities are unavailable. Product decisions use predicates, never harness names.

### Plugin lifecycle

`discovered -> resolved -> loading -> active -> draining -> inactive`

Failure can occur at resolution, load, run, drain, or unload. Each transition writes a durable event and every owned in-process effect registers a disposer. Replacement order is:

1. Resolve and validate candidate dependencies/version ranges.
2. Load candidate in a provisional context.
3. Stop advertising the old provider.
4. Drain/cancel dependents with a bounded timeout while old bindings remain readable.
5. Atomically publish the candidate.
6. Dispose old effects in reverse order.
7. If candidate activation fails, dispose candidate effects and restore the previous provider/config snapshot.

External effects follow the WorkPacket's explicit commit/compensation policy rather than the disposer stack.

## Compatibility strategy

| Harness | Current local evidence | Initial Forge tier | Required work before write delegation |
|---|---|---|---|
| Codex | CLI `0.151.0`; native child agents; Companion role bridge previously live-smoked | Tier 1 | Adapter certification, durable session mapping, exact cancellation receipt |
| Claude Code | CLI `2.1.251`; Companion plugin installed; reachability intentionally restricted | Tier 1 from Claude origin only | Enforce origin/reachability in central policy; never expose Claude through DSH from Codex |
| OpenCode | CLI `1.18.25`; ACP/server/session surfaces; V1 historical live-control failure; V2 path exists | Tier 1 one-shot, Tier 2 persistent after certification | Canonical V2 default, database migration issue, link-only skill install, control/cancel matrix |
| Pi | CLI `0.84.3`; prior worker smoke exists | Experimental | Shared-hub-only skills, auth/profile policy, cancellation/live-control tests |
| DeepSeek Harness | CLI `0.1.0-rc.7`; profile/plugin launcher; local external-worker plugin | Experimental read-only only after adapter repair | Permission capability or safe sandbox; durable receipt/control bridge; remove hard-coded executable/model paths |
| Cursor | Existing Forge surface | Existing supported | Bring under same registry/ABI; do not copy Pstack host assumptions |
| Hermes | Existing Forge surface | Existing supported | Preserve consumer-only Kernel boundary |

Tier names describe verified capabilities, not product prestige. A provider can be Tier 1 for one-shot reads and unavailable for persistent control or writes.

## Scheduling and multi-agent behavior

Agent count is not the objective. The scheduler should:

1. Compute ready leaves from the Run DAG.
2. Partition by genuine artifact ownership and required capability.
3. Dispatch independent leaves up to the configured concurrency budget.
4. Keep the integrator, authority mutations, and conflict resolution with one lead.
5. Receive event-driven completion receipts rather than polling every child.
6. Cancel superseded or doomed work and wait for termination proof before releasing claims.
7. Escalate model/effort only after ambiguity, consequence, or a failed attempt; never repeat the same failed configuration.
8. Record queue time, execution time, blocked time, duplicate work, and critical-path time.

This explains both observed extremes: sessions that ignored explicit parallelism and sessions that created many agents but spent most elapsed time waiting.

## Security and failure containment

- Credentials remain in native harness stores. WorkPackets carry policy handles, never secret material.
- Reachability is a hard capability check. Codex/DSH cannot obtain a Claude worker merely because a plugin registered one.
- Workspaces are resolved to absolute canonical paths and confined to an authorized root.
- Read, write, network, process, issue, Git, PR, merge, and deployment effects are separate capabilities.
- Output is bounded, redacted, and spillable to a hashed artifact; structured stdout channels stay pure.
- Cancellation includes descendant process termination and a positive termination receipt.
- Retries require idempotency and policy. A completed write is not automatically resumable.
- Plugin packages are namespaced, version-pinned, integrity-recorded, and loaded from an allowlisted source.
- Capability declarations are mediation, not trust. Untrusted plugins need a real sandbox.
- Event logs record decisions and hashes, not secrets or uncontrolled transcript dumps.

## Amendments to the current Forge plan

1. Replace the static supported-harness list with capability-defined support. Preserve Claude/Codex/Cursor/Hermes behavior while adding OpenCode, Pi, and DSH through adapters.
2. Extend PR5 capability negotiation rather than creating a parallel probe stack.
3. Extend the Smith execution-adapter issue to cover the common `HarnessAdapter` ABI and Agent Companion bridge.
4. Replace scalar skill `next`/`terminal` semantics with typed transition edges and return-to-caller semantics.
5. Enforce invocation metadata in the generated registry and resolver; do not merely preserve it in mirrored Markdown.
6. Make plan Markdown a rendered projection or explicitly historical. Kernel tasks and decisions are authoritative; drift is reported automatically.
7. Add a source registry and link-only installer for skills/plugins; no host-specific copied skill directories.
8. Compile Agent Config policy to a versioned, explainable Agent Companion/Forge routing policy rather than maintaining two hand-authored rule sets.
9. Add durable run/evidence/terminal records before adding multi-phase cross-harness orchestration.
10. Keep Cordis concepts behind the Forge plugin ABI; do not change the Kernel or CLI authority substrate.

## Delivery sequence and gates

The accepted order is control-plane first. Skills and plugins do not move ahead of authority merely because they are more visible.

### Wave 0 — close the research/projection gap

- Refresh this artifact against live Kernel/worktree/remote evidence.
- Record exact issue IDs, dependencies, accepted decisions, and anti-decisions.
- Preserve dirty local sources and separate historical evidence from current verification.

Gate: the research branch is tracked and pushed, the remote tree contains this artifact, and the research issue has a verified stage-exit receipt. The epic stays open as the delivery umbrella.

### Wave 1 — authority and completion contracts

- Finish explicit actor/session identity without hiding the independent runner flake.
- Add the minimal durable model: `WorkItem -> Run -> Attempt`, ordered events, evidence refs, and immutable policy/capability snapshots.
- Add `AuthoritySnapshot`, `WorkPacket`, `EvidenceReceipt`, `CompletionReceipt`, and typed handoff events incrementally to the Kernel.
- Reconcile the live issue graph with the accepted plan before opening more execution surfaces.

Gate: crash/restart replay, issue/worktree/base/head/lease binding, actor mismatch, stale evidence invalidation, tri-state `PASS | FAIL | INCOMPLETE`, and no prose-only completion path.

### Wave 2 — deterministic skill product

- Preserve invocation metadata end to end.
- Record qualified identity, source, version/commit, hash, scope, physical path, and invocation mode.
- Deduplicate same hashes, surface different-hash conflicts, require explicit preference, and add preview/doctor/enable/disable/test surfaces.
- Project one canonical source atomically to each harness.

Gate: pairwise conflict fixtures, malformed capability handling, worktree-safe discovery, user-only recursion rejection, and drift-free projections.

### Wave 3 — open adapter ABI and certification

- Generalize existing probes and execution seams to the common adapter ABI.
- Certify Codex first, then OpenCode, Pi, and DSH according to real capabilities; keep unsupported cells unavailable.
- Add local fake/hostile executables before opt-in live zero-token probes.

Gate: Windows/macOS/Linux path and shell matrix, timeout/cancel descendant cleanup, output/redaction, stale/malformed capability failure, and no credential copying.

### Wave 4 — Companion, Agent Config, and backpressure

- Map Forge WorkPackets to Companion requests and receipts back to Forge evidence/events.
- Snapshot Agent Config policy at Run creation with an explainable RouteDecision.
- Enforce privacy, reachability, write, retry, resume, and cancellation policy centrally.
- Fix Agent Companion Windows progress persistence before relying on it as a provider.

Gate: idempotent replay, crash recovery, completed-write retry rejection, positive cancellation receipt, origin/reachability denial, and conformance across two materially different adapters.

### Wave 5 — plugin lifecycle

- Add first-party pinned manifests, owned disposers, reactive requirements, draining, overlays, and transactional replacement.
- Keep executable providers out of process where needed.
- Optionally prove a Cordis-backed provider behind the same ABI; do not make it default.

Gate: load/unload leak tests, withdrawal ordering, failed-upgrade rollback, dependency-cycle diagnostics, digest-bound permission grants, and external-effect compensation.

### Wave 6 — memory, UX, scheduling, and evaluation

- Add provenance plus selected OpenViking tiering and Mem0 proposal mechanics to the existing SQLite/FTS5 path; evaluate only Graphiti as an optional external temporal projection.
- Dispatch ready DAG leaves by artifact ownership and capability rather than agent count.
- Mine recurring session patterns into proposals, never automatic rules.
- Promote changes only through a frozen smoke/replay corpus and critical-path metrics.

Gate: cross-project isolation, forget/redact/export, no-connector operation, no regression in task success/evidence completeness, bounded cost, and human approval for policy/skill changes.

## Required test matrix

1. **Manifest:** invalid/duplicate IDs, version mismatch, missing capability, conflict cycles, ambiguous primaries, user-only recursion.
2. **Transition graph:** dynamic dispatch, reusable return, hard terminal, classification branch, pre/post-merge human gate.
3. **Authority:** wrong actor, expired lease, wrong worktree, stale base/head, scope drift, claim release after proven cancellation.
4. **Evidence:** exact-ref binding, freshness expiry, partial matrix, unresolved review, restart-required runtime, blocked-not-passed semantics.
5. **Adapters:** absent executable, hostile stdout, malformed capability JSON, hung process, child process leak, path with spaces/non-ASCII/long root.
6. **Companion:** duplicate request, crash between snapshot/log writes, status/control race, resume policy, receipt redaction, adapter version drift.
7. **Plugin lifecycle:** missing provider, provider replacement, dependent drain, inverse failure, activation failure rollback, cycle, external effect compensation.
8. **Cross-harness:** Codex/Claude/OpenCode/Pi/DSH capability snapshots and contract tests, with unsupported cells asserted rather than skipped.
9. **Scheduler:** dependency ordering, one owner per artifact, bounded concurrency, event-driven wake, cancellation, critical-path measurement.
10. **Projection:** Agent Config -> policy, registry -> host manifests, Kernel -> plan/status docs, with drift detection and source hashes.

## Issue graph

The final Kernel pass found and linked the durable implementation graph below. Status and dependency columns were refreshed live on 2026-08-30; they are not inferred from Markdown. Wave 0 performs this reconciliation manually; the later Kernel-to-plan issue productizes continuous projection and drift detection after the Companion bridge exists.

| Wave | Issue | Status | Direct dependencies / disposition |
|---:|---|---|---|
| 0 | Research artifact (`f831f7c5-7e48-4a77-b327-a0c572828b8b`) | in progress, blocked | This branch; validation reproduced green JUnit/nonzero shard exits, so close only after runner issue `465f7e62-1928-4bcf-97a5-c2db05504a7e` and remote-tree verification |
| 0 | Converge plan and execute first slice (`e4d530eb-104e-4e5e-9280-ff19ac781878`) | done | Completed plan/review loop and first dependency-safe implementation |
| 1 | Actor/session identity (`7b60525b-a1e2-4c94-a6b4-81fa76459a24`) | open, blocked | Diagnostics done; post-JUnit runner issue still open |
| 1 | WorkItem/Run/Attempt authority and completion contracts (`85be2945-ab34-4e3c-abd3-893ee7ea3b4e`) | open, blocked | Actor/session identity |
| 1 | Public `issue.owns` contract (`9e5485f2-ad10-4cd6-874d-823c8ec5569d`) | open | Focused follow-up; do not widen actor fix |
| reused by 2 | Canonical workflow/invocation projection (`205a8106-bf54-44b7-9129-6f3f111b9103`) | open | Existing owner outside this epic; skill registry depends on it rather than creating another invocation authority |
| 2 | Skill collision/source registry (`da760874-32c4-4011-99a2-88abe865e667`) | open, blocked | Authority contracts and canonical workflow/invocation projection |
| 3 | Open harness-adapter registry (`6f2dbe75-29ea-442e-a175-c7de13aa3c52`) | open, blocked | Authority contracts and plan convergence; extend existing probes/Smith seams |
| 3 | Permission/retry/resume/cancel semantics (`84c942f3-b7e0-4416-a7d3-11b6c783c0bc`) | open, blocked | Authority contracts and plan convergence |
| 3/4 | Cross-harness certification (`8d3786a0-6d1d-4df8-8893-a7c5b710b54c`) | open, blocked | Companion bridge and skill registry |
| 4 | Agent Config policy compiler (`ce785690-af5d-4a40-bc95-bc99d0ac9125`) | open, blocked | Authority contracts and plan convergence |
| parallel repair | Agent Companion Windows backpressure (`1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`) | open | Deliberate exception: bounded existing-executor bug, not a new authority surface; Companion bridge still depends on it |
| 4 | Forge/Companion WorkPacket bridge (`8d14651d-03a6-4727-8204-2a05ad7fb280`) | open, blocked | Authority, adapter, permission, policy, and backpressure issues |
| 4/6 | Kernel-to-plan/design reconciliation (`732bd0fa-61bb-40ac-801d-de2468507cff`) | open, blocked | Companion bridge |
| 5 | Reversible plugin lifecycle (`4d831b25-66f5-4aed-b664-49131f7da797`) | open, blocked | Authority contracts; no marketplace; first-party pinned providers first |
| 6 | Provenance-first memory and optional Graphiti projection (`ff843904-714d-4fe1-bcee-7925ffec60ff`) | open, blocked | Authority contracts and plugin lifecycle; OpenViking/Mem0 are design references only |
| optimization | Bun 1.4 evaluation (`64baba16-8dc1-457f-9a98-2d57518e28f1`) | open | Independent promotion gate; current verdict INCOMPLETE |
| delivered support | Issue `--path` forwarding (`2aa2d58f-078a-4003-a9c4-04eea48410fd`) | done | Remote branch verified |
| delivered support | Shard exit diagnostics (`15d5d9f2-c0bf-48ef-92ca-62d3a9f7f77a`) | done | Remote branch verified |
| isolated support | Bun post-JUnit exits (`465f7e62-1928-4bcf-97a5-c2db05504a7e`) | open | Keep separate from authority design |

Existing seams remain the reuse targets: PR5 capability negotiation (`5f4da13f-a813-4e91-a4f8-806755384f31`), Smith execution adapters (`3b863d8b-1e42-4f75-bb45-6a5a8da0de6b`), and shipped skill-invocation metadata (`588e6973-842c-47aa-aff3-77434e0ccdcc`). No parallel probe stack, scheduler, or skill authority should be added.

## Risks and anti-decisions

- Do not replace the Forge Kernel with Cordis, Agent Companion, DSH, or transcript state.
- Do not make every Forge module a plugin. Use plugins at genuine provider boundaries.
- Do not claim external writes are reversible because registrations are disposable.
- Do not define support by harness name or lowest-common-denominator behavior.
- Do not copy skills into every host; project one canonical package.
- Do not let a skill launch another human-only workflow implicitly.
- Do not add orchestration before durable run/evidence/authority records exist.
- Do not optimize for number of agents; optimize verified critical-path completion.
- Do not auto-promote history-mined rules or skills without replay evidence and human approval.
- Do not expose Claude reachability through DSH or another host when central policy forbids it.
- Do not build a plugin marketplace, generic event bus, vector-memory default, or cloud skill-sync service before two materially different adapters pass the same contracts.
- Do not keep duplicate routers, copied skill trees, prose-only handoffs, TSV/Markdown shadow authority, or fixed model tables. Delete or project them from one owner.
- Do not hop workflow phases across harnesses until a Run can resume from durable events and fresh authority rather than transcript reconstruction.
- Do not convert every good Matt/Pstack procedure into core behavior. Keep a small model-invoked discipline set, explicit user-invoked workflows, and optional executable plugins.

## Decisions

### D1 — supported harness scope

- **A (accepted):** amend the supported set to capability-defined tiers and build adapters for OpenCode, Pi, and DSH alongside existing hosts.
- **B:** keep those three as external/experimental integrations with no Forge compatibility commitment.
- **C:** support OpenCode first, defer Pi and DSH until the ABI is proven.

### D2 — Cordis adoption

- **A (accepted):** adopt the lifecycle/capability/reconciliation semantics behind a small Forge-native ABI; keep Cordis itself optional.
- **B:** embed Cordis as the default Forge plugin runtime now.
- **C:** use DSH only as an external worker and adopt none of the Cordis mechanisms.

### D3 — control-plane ownership

- **A (accepted):** Forge Kernel = authority, Agent Config = policy, Agent Companion = execution protocol, harness adapters = translation.
- **B:** move scheduling and run authority into Agent Companion.
- **C:** let each harness/plugin own its own run state and reconcile afterward.

These decisions implement the user's explicit control-plane-first selection. Changing one requires a new decision event and dependency-graph reconciliation; it is not a wording-only edit.
