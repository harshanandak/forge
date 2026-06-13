# Beads Backlog Issue Map

This file maps the roadmap PR into Beads backlog items. The hierarchy intentionally separates decisions, features, and tasks so later implementation PRs can pick small slices.

## Parent roadmap

- `forge-2agy.9` — Roadmap: Kernel backlog, storage, and project knowledge alignment

## Level 1 roadmap slices

- `forge-2agy.9.1` — Define Kernel storage authority boundaries and guards
- `forge-2agy.9.2` — Define issue backlog taxonomy for stories, sprints, and tasks
- `forge-2agy.9.3` — Design Project Knowledge Layer verbatim index MVP
- `forge-2agy.9.4` — Specify forge orient and recap bounded context commands
- `forge-2agy.9.5` — Add local SQLite multi-agent concurrency tests
- `forge-2agy.9.6` — Guard Beads projection fidelity during Kernel migration
- `forge-2agy.9.7` — Plan Hermes harness as Forge project-state consumer
- `forge-2agy.9.8` — Gate multi-machine team writes on serialized authority
- `forge-2agy.9.9` — Define release lanes and gates for next Forge feature releases

## Deeper backlog tasks

### Storage authority boundaries — `forge-2agy.9.1`

- `forge-2agy.9.1.1` — Audit current storage surfaces against authority/read-model/projection classes
- `forge-2agy.9.1.2` — Document Dolt capabilities Forge must replace or explicitly drop
- `forge-2agy.9.1.3` — Add storage-mode guardrail UX for unsupported team-local writes
- `forge-2agy.9.1.4` — Define storage backend conformance matrix
- `forge-2agy.9.1.5` — Run Dolt capability spike before storage migration lock-in — **closed with decision: SQLite first authority; Dolt remains projection/history only**
- `forge-2agy.9.1.6` — Spike Dolt server/remotes for projection/history transport and Beads fidelity — **deferred follow-up outside Kernel authority path**
- `forge-2agy.9.1.7` — Clean Forge CLI authority surface around SQLite Kernel
- `forge-2agy.9.1.8` — Retire Dolt from Forge hot path behind TypeScript Kernel API

### Backlog / sprint / story taxonomy — `forge-2agy.9.2`

- `forge-2agy.9.2.1` — Define Kernel issue types and status lifecycle
- `forge-2agy.9.2.2` — Model sprint, release, milestone, and roadmap buckets separately
- `forge-2agy.9.2.4` — Design frontend backlog board query model
- `forge-2agy.9.2.5` — Map Beads and GitHub issue fields into Kernel taxonomy

Note: `forge-2agy.9.2.3` was skipped because Beads rejected `story` as a custom issue type. The item was recreated as a `feature` at `forge-2agy.9.2.4`.

### Project Knowledge Layer — `forge-2agy.9.3`

- `forge-2agy.9.3.1` — Inventory verbatim knowledge sources and metadata fields
- `forge-2agy.9.3.2` — Design FTS5 read-model schema and rebuild flow
- `forge-2agy.9.3.3` — Define provenance-backed summary and fact proposal model
- `forge-2agy.9.3.5` — Evaluate vector backend options after FTS5 baseline
- `forge-2agy.9.3.6` — Design temporal project fact graph for conflicts and stale facts

Note: `forge-2agy.9.3.4` was skipped because Beads rejected `spike` as a custom issue type. The vector evaluation item was recreated as a `task` at `forge-2agy.9.3.5`.

### Orient / recap commands — `forge-2agy.9.4`

- `forge-2agy.9.4.1` — Specify forge orient bounded project briefing contract
- `forge-2agy.9.4.2` — Specify forge recap issue-scoped context contract
- `forge-2agy.9.4.3` — Define forge knowledge search command and JSON schema
- `forge-2agy.9.4.4` — Add context budget and ranking policy for orientation outputs

### Local SQLite / worktree concurrency — `forge-2agy.9.5`

- `forge-2agy.9.5.1` — Build multi-process local Kernel write fixture
- `forge-2agy.9.5.2` — Test expected_revision and idempotency under concurrent writes
- `forge-2agy.9.5.3` — Test claim lease races across agents and worktrees
- `forge-2agy.9.5.4` — Define SQLite busy timeout retry and transaction policy
- `forge-2agy.9.5.5` — Verify git common-dir worktree routing for Kernel DB

### Beads fidelity / projection safety — `forge-2agy.9.6`

- `forge-2agy.9.6.1` — Preserve unsupported Beads fields as provider extensions
- `forge-2agy.9.6.2` — Compare Beads ready-work semantics against Kernel dependency graph
- `forge-2agy.9.6.3` — Document Beads import/export rollback and dry-run workflow
- `forge-2agy.9.6.4` — Add projection quarantine cases for stale Beads/GitHub writes

### Hermes integration boundary — `forge-2agy.9.7`

- `forge-2agy.9.7.1` — Define Hermes orient/recap consumption contract
- `forge-2agy.9.7.2` — Draft Hermes SKILL.md template for Forge workflows
- `forge-2agy.9.7.3` — Define Hermes evidence and decision writeback path
- `forge-2agy.9.7.4` — Document Forge vs Hermes memory boundary

### Team authority gate — `forge-2agy.9.8`

- `forge-2agy.9.8.1` — Define server sequence and entity revision model for team authority
- `forge-2agy.9.8.2` — Design Durable Object project mutation contract
- `forge-2agy.9.8.3` — Specify offline/team-mode refusal and recovery UX
- `forge-2agy.9.8.4` — Design projection outbox, retries, and dead-letter handling

## Evaluator amendment issues

After evaluator/review loops, additional issues were added in multiple batches to make the plan safer:

### Local SQLite / worktree concurrency amendments — `forge-2agy.9.5`

- `forge-2agy.9.5.6` — Implement atomic SQLite broker transaction contract
- `forge-2agy.9.5.7` — Select and validate real SQLite runtime driver
- `forge-2agy.9.5.8` — Add local filesystem and WAL safety doctor
- `forge-2agy.9.5.9` — Define idempotency collision and replay semantics
- `forge-2agy.9.5.10` — Enforce claim lease invariants at DB level
- `forge-2agy.9.5.11` — Add Forge state doctor and bootstrap repair for new worktrees

### Beads fidelity / projection amendments — `forge-2agy.9.6`

- `forge-2agy.9.6.5` — Prevent Beads projection and import echo loops
- `forge-2agy.9.6.6` — Add real Beads Dolt ready-queue parity fixtures

### Backlog / frontend amendments — `forge-2agy.9.2`

- `forge-2agy.9.2.6` — Define board rank and mutation event model
- `forge-2agy.9.2.7` — Define sprint release milestone entities and rollups
- `forge-2agy.9.2.8` — Define readiness and blocked-work policy model
- `forge-2agy.9.2.9` — Lock SQLite backlog sprint issue schema before implementation
- `forge-2agy.9.2.10` — Recast pre-merge as task-type gate not universal workflow stage

### Project Knowledge Layer amendments — `forge-2agy.9.3`

- `forge-2agy.9.3.7` — Reconcile existing Forge project memory with Project Knowledge Layer
- `forge-2agy.9.3.8` — Add Knowledge Layer redaction and prompt-injection safety policy
- `forge-2agy.9.3.9` — Add retrieval quality and provenance conformance fixtures
- `forge-2agy.9.3.10` — Design agent memory federation adapters for Forge project memory
- `forge-2agy.9.3.11` — Add read-only direct agent memory file connectors
- `forge-2agy.9.3.12` — Lock Forge memory authority and Knowledge Layer storage boundary
- `forge-2agy.9.3.13` — Document Graphify usage as derived architecture navigation

### Decision registry / design authority amendments — `forge-2agy.9.3`

- `forge-2agy.9.3.14` — Design unified project design and decision registry schema/API
- `forge-2agy.9.3.15` — Add Kernel authority events for decisions, facts, evidence, and knowledge conflicts
- `forge-2agy.9.3.16` — Implement design/decision proposal acceptance and supersession lifecycle
- `forge-2agy.9.3.17` — Import Beads memory/comments as KnowledgeStore sources and proposals, not accepted truth
- `forge-2agy.9.3.18` — Add decision/conflict sections to orient and recap contracts
- `forge-2agy.9.3.19` — Add decision registry validation for duplicate topics, stale evidence, ADR backlinks, and unsuperseded conflicts

### Mandatory architecture capture amendments — `forge-2agy.9.3`

- `forge-2agy.9.3.20` — Define mandatory architecture record taxonomy and scoped file layout
- `forge-2agy.9.3.21` — Add architecture impact PR and session gate
- `forge-2agy.9.3.22` — Implement docs-first architecture record validator
- `forge-2agy.9.3.23` — Design architecture impact detection from changed paths to records
- `forge-2agy.9.3.24` — Design brownfield architecture discovery workflow
- `forge-2agy.9.3.25` — Add architecture coverage and conflict surfacing to orient recap

### Hook-backed architecture capture amendments — `forge-2agy.9.3`

- `forge-2agy.9.3.26` — Design architecture impact manifest for Forge hook policy engine
- `forge-2agy.9.3.27` — Implement Forge architecture impact policy engine for agent hooks Lefthook and CI
- `forge-2agy.9.3.28` — Wire Lefthook as optional architecture impact adapter and validate worktree setup diagnostics
- `forge-2agy.9.3.29` — Add CI required architecture capture check and branch-protection status documentation
- `forge-2agy.9.3.30` — Add architecture hook adapter tests and brownfield fixtures
- `forge-2agy.9.3.31` — Project architecture impact guidance into agent-native hooks and instructions
- `forge-2agy.9.3.32` — Add forge hooks doctor install sync for agent and worktree adapters
- `forge-2agy.9.3.33` — Add agent no-verify guard and audited bypass flow
- `forge-2agy.9.3.34` — Add architecture impact declaration templates and scaffolding helper
- `forge-2agy.9.3.35` — Add KnowledgeStore-backed architecture impact retrieval follow-up

Recommended dependency and acceptance notes:

| Issue | Depends on | Acceptance focus |
| --- | --- | --- |
| `forge-2agy.9.3.26` | `.20`, `.21`, `.23`, `.24` | Versioned manifest schema, glob precedence, path normalization, capture modes, declaration locations, valid/invalid examples. |
| `forge-2agy.9.3.27` | `.22`, `.23`, `.24`, `.26` | Forge-owned policy engine, mode-specific behavior, JSON schema, exit codes, changed-file sources, no-impact validation, performance/path handling. |
| `forge-2agy.9.3.31` | `.27` | Agent-native instructions/adapters call Forge engine, support brownfield observed/unknown/question capture, and do not mutate private profiles without authorization. |
| `forge-2agy.9.3.32` | `.27`, `.31` | `forge hooks doctor/install/sync` reports agent adapter, Lefthook, worktree/common-dir, container, manifest, and CI check status with `--json` and safe repair commands. |
| `forge-2agy.9.3.28` | `.27`, `.32` | Lefthook invokes Forge policy only, detects absent/stale local hook setup through doctor output, and stays non-authoritative. |
| `forge-2agy.9.3.33` | `.27`, `.31`, optionally `.28` | Agent no-verify guard, audited Forge bypass event schema, expiry/specific-action semantics, command/environment/script-mediated bypass handling, CI verification. |
| `forge-2agy.9.3.30` | `.22`, `.24`, `.27`, `.28`, `.31`, `.32`, `.33` | Fixtures for sensitive/no declaration, no-impact rationale, valid/invalid records, brownfield unknown/question/conflict, missing Lefthook, worktree/container drift, no-verify attempts, Windows/MSYS paths. |
| `forge-2agy.9.3.29` | `.27`, `.30`, `.33` | CI required check, PR diff base handling, branch-protection status-check documentation, unknown policy, and proof local bypass cannot merge invalid architecture changes. |
| `forge-2agy.9.3.34` | `.21`, `.27` | `architecture-impact.md` scaffolding/template helper and PR/session declaration generation. |
| `forge-2agy.9.3.35` | `.27` plus KnowledgeStore MVP | KnowledgeStore-backed architecture impact retrieval as indexed/provenance-backed search, not authority. |

### Orient / recap amendments — `forge-2agy.9.4`

- `forge-2agy.9.4.5` — Resolve forge recap command compatibility
- `forge-2agy.9.4.6` — Design Forge MCP read-only Kernel MVP
- `forge-2agy.9.4.7` — Integrate Context Mode as retrieval provider for orient and recap

### Hermes / agent integration amendments — `forge-2agy.9.7`

- `forge-2agy.9.7.5` — Define agent work contract for claims stages and evidence
- `forge-2agy.9.7.6` — Add Hermes no-profile-write integration guard
- `forge-2agy.9.7.7` — Stop generated Forge docs and harness churn during lifecycle commands
- `forge-2agy.9.7.8` — Align fresh Forge setup with docs/work plan task decision structure

### Workflow friction / release-readiness amendments — cross-cutting

- `forge-2agy.9.3.36` — Complete design.md to plan.md migration across commands skills and docs
- `forge-2agy.9.3.37` — Ensure hook and lint installation is reliable in linked worktrees
- `forge-2agy.9.9` — Define release lanes and gates for next Forge feature releases

Recommended dependency and acceptance notes:

| Issue | Depends on | Acceptance focus |
| --- | --- | --- |
| `forge-2agy.9.7.7` | `.9.3.37`, `.9.5.11`, `.9.5.9` | Lifecycle commands are idempotent; generated harness/runtime churn no longer forces agents to stash files during push/review/verify/merge cleanup. Includes generated-state manifest, protected-state-aware writes, and clean-checkout/linked-worktree lifecycle smoke gate. |
| `forge-2agy.9.7.8` | `.9.3.36`, `.9.2.10`, `.9.7.5` | Fresh setup, existing-project update/repair, generated instructions, skills, and command prompts teach `docs/work/<date>-<slug>/plan.md`, `tasks.md`, `decisions.md`, and the minimum evidence artifact contract. |
| `forge-2agy.9.3.36` | `.9.3.1` | Default work-item planning references migrate from `design.md` to `plan.md`; KnowledgeStore/orient/recap source classes distinguish work plans, legacy design files, architecture designs, task lists, decisions, evidence, generated harnesses, runtime projections, summaries, and proposals. |
| `forge-2agy.9.3.37` | `.9.1.7`, `.9.5.5` | General worktree hook/lint doctor detects missing/stale local gates and provides safe `--json`/`--dry-run` repair commands, independent of later architecture-capture policy. |
| `forge-2agy.9.5.11` | `.9.1.7`, `.9.5.5`, `.9.5.7`, `.9.5.8`, `.9.3.37` | Worktree Forge state doctor verifies `.forge`, projection/Beads state, Kernel bootstrap state, common-dir mapping, and hooks with idempotent protected-state-safe repair. |
| `forge-2agy.9.2.10` | `.9.2.1`, `.9.2.8`, `.9.2.9` | `premerge` is modeled as an embedded task-type gate/checkpoint, not a universal top-level stage. |
| `forge-2agy.9.1.8` | `.9.1.1`, `.9.1.2`, `.9.1.7`, `.9.5.6`-`.9.5.11`, `.9.6.1`-`.9.6.6`, `.9.2.5`, `.9.2.8` | Normal Forge commands stop shelling out to `bd`, reading `.beads/issues.jsonl`, or requiring Dolt except inside import/export/projection adapters; Beads/Dolt parity gates remain mandatory. |
| `forge-2agy.9.9` | parent only | Release lanes are a sequencing/gating issue and intentionally not blocked by the broad lanes it orders; downstream release work should consume its lane/gate decisions. |

### Team authority amendments — `forge-2agy.9.8`

- `forge-2agy.9.8.5` — Define team authority protocol and recovery design
- `forge-2agy.9.8.6` — Define config and workflow revision agreement for team writes
- `forge-2agy.9.8.7` — Define team roles permissions and handoff UX

See `evaluator-beads-proposed.tsv`, `decision-registry-beads-proposed.tsv`, `architecture-capture-beads-proposed.tsv`, `architecture-hooks-beads-proposed.tsv`, and `workflow-friction-beads-proposed.tsv` for proposed IDs. These TSVs are implementation backlog proposals until an authoritative Beads/Kernel state export is committed through the owning sync surface.

## Release lanes for the next feature releases

`forge-2agy.9.9` is the release coordinator issue for this lane map. It is documentation/planning only, should merge before implementation PRs that consume this sequencing, and should not close or implement the lane issues below.

| Lane | Issues in lane | Dependency / merge order | Parallelism rule | Release gate |
| --- | --- | --- | --- | --- |
| Release coordinator | `forge-2agy.9.9` | Merge this lane map first so downstream PRs can cite one ordering source. | Standalone docs PR. | `issue-map.md` contains lane membership, dependency notes, PR concurrency limits, and next-release gates. |
| Self-hosting stability | `forge-2agy.9.3.37`, `forge-2agy.9.5.11`, `forge-2agy.9.7.7` | Stack `forge-2agy.9.3.37` before `forge-2agy.9.5.11`; stack `forge-2agy.9.7.7` after `forge-2agy.9.5.11` and `forge-2agy.9.5.9`. | Mostly sequential/stacked because generated lifecycle cleanup depends on hook/lint doctor, state bootstrap, and idempotency semantics. | Clean checkout plus linked worktree can complete push, review, verify, merge, and post-merge cleanup without surprise generated dirt, stashes, or manual repair. |
| Fresh setup correctness | `forge-2agy.9.3.36`, `forge-2agy.9.2.10`, `forge-2agy.9.7.8` | `forge-2agy.9.3.36` and `forge-2agy.9.2.10` may proceed independently once their own prerequisites are satisfied; `forge-2agy.9.7.8` stacks after both and `forge-2agy.9.7.5`. | The two foundation PRs can run in parallel with self-hosting work, but the setup-alignment PR is sequential after them. | Fresh setup and existing-project repair teach `plan.md`, `tasks.md`, `decisions.md`, and evidence artifacts consistently without reviving `design.md` as the default work-item plan. |
| Kernel state foundation | `forge-2agy.9.5.7`, `forge-2agy.9.5.6`, `forge-2agy.9.5.9`, `forge-2agy.9.5.10` | Start with `forge-2agy.9.5.7` driver validation. Then implement the transaction contract (`.9.5.6`), idempotency semantics (`.9.5.9`), and claim lease invariants (`.9.5.10`) as stacked or tightly coordinated PRs. | Driver validation can run in parallel with hook/lint work; transaction/idempotency/lease changes should be stacked or merged in dependency order. | Real SQLite driver proof covers WAL, busy timeout, FTS5, backup, checkpoint, Windows behavior, atomic broker writes, idempotency replay/collision handling, and DB-enforced claim leases. |
| Beads projection safety | `forge-2agy.9.6.5`, `forge-2agy.9.6.6` | These can start after Kernel event/projection boundaries are stable enough to test. Keep them before any PR that claims Beads/Dolt is removed from the hot path. | Can run in parallel with later Kernel foundation PRs if fixtures use the same authority/projection contract. | Projection writes cannot echo back over Kernel authority, stale external writes are quarantined, and ready-queue parity differences are either passing or intentionally documented. |

## Release stability gates

The next reliable feature release must pass these gates before downstream Knowledge, hook UX, or team-authority feature claims expand:

1. Self-hosting lifecycle smoke gate: clean checkout plus linked worktree plus generated harness plus hooks plus Forge state plus projection state completes push/review/verify/merge/post-merge cleanup without stash/manual repair.
2. Worktree gate: hook/lint doctor and Forge state doctor both report machine-readable status and safe repair behavior for main and linked worktrees.
3. Fresh setup gate: fresh setup and existing-project update/repair generate the current work-folder contract and keep legacy `design.md` compatibility without teaching it as the default.
4. Kernel authority gate: normal Forge issue/state writes go through the SQLite broker contract with expected revision, idempotency, projection outbox, and claim lease invariants.
5. Beads projection gate: Dolt/Beads remains compatibility/projection/import-export state only; projection parity, echo-loop prevention, quarantine, and rollback/dry-run paths are proven before retirement claims.

## Implementation order and PR concurrency

Keep active implementation PRs capped at **2-3 at a time**. A fourth implementation PR should wait unless one active PR is merged, closed, or explicitly paused.

1. Merge the release coordinator PR (`forge-2agy.9.9`) first.
2. Open the first parallel pair: `forge-2agy.9.3.37` for linked-worktree hook/lint reliability and `forge-2agy.9.5.7` for real SQLite driver validation.
3. After `forge-2agy.9.3.37` and the Kernel driver/common-dir prerequisites are stable, stack `forge-2agy.9.5.11` for Forge state doctor/bootstrap repair.
4. After `forge-2agy.9.5.11` and `forge-2agy.9.5.9`, stack `forge-2agy.9.7.7` for generated docs/harness churn and lifecycle idempotency.
5. In the second slot, run fresh-setup foundation work: `forge-2agy.9.3.36` and `forge-2agy.9.2.10`; stack `forge-2agy.9.7.8` after both and `forge-2agy.9.7.5`.
6. Continue Kernel state foundation in merge order: `forge-2agy.9.5.6`, `forge-2agy.9.5.9`, then `forge-2agy.9.5.10`, keeping any overlapping PRs small and explicitly stacked.
7. Run Beads projection safety (`forge-2agy.9.6.5`, `forge-2agy.9.6.6`) before `forge-2agy.9.1.8` or any release note claiming Dolt/Beads left the hot path.
