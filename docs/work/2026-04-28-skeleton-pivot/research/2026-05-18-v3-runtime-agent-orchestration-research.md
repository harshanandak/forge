# V3 Runtime And Agent Orchestration Research

Date: 2026-05-18

## Correction From The Board-Only Read

The board is only one late surface. The broader Forge v3 plan is a runtime contract for agentic software delivery: graph primitives, configurable execution, evidence/evaluator regions, skills, adapters, memory, protected paths, extension packaging, harness translation, and team runtime visibility.

Local anchors:
- Forge defines itself as a configurable workflow/runtime building-block system, not one workflow, template library, skill library, or orchestration layer (`docs/work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md:9`, `docs/work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md:11`).
- Core primitives are `Phase`, `Action`, `Artifact`, `EvaluatorRegion`, `Gate`, `Evidence`, `Skill`, and `Adapter` (`docs/work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md:27`-`35`).
- The runtime engine loads the graph, runs actions, invokes skills, captures evidence, evaluates state, and applies gate policy (`docs/work/2026-04-28-skeleton-pivot/runtime-building-blocks-refinement.md:39`-`46`).
- The team board/dashboard is `0.0.18`, after graph, config, evaluators, templates, patch/upgrade, skills, and insights (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:97`-`248`).

## Current Ecosystem Pattern

Modern agent tooling is converging around these layers:

1. Durable runtime graph.
   - LangGraph positions itself as an orchestration runtime for durable execution, streaming, human-in-the-loop, persistence, and memory.
   - Source: https://docs.langchain.com/oss/python/langgraph/overview

2. Deterministic workflow control plus autonomous workers.
   - Google ADK distinguishes deterministic workflow agents (`SequentialAgent`, `ParallelAgent`, `LoopAgent`) from LLM agents, and composes agents in parent-child hierarchies.
   - Sources:
     - https://adk.dev/agents/multi-agents/
     - https://adk.dev/agents/workflow-agents/

3. Flow controls the process; agent teams do the uncertain work.
   - CrewAI frames Flows as stateful/event-driven control and Crews as autonomous collaborative work units.
   - Source: https://docs.crewai.com/en/introduction

4. Trace every meaningful run boundary.
   - OpenAI Agents SDK traces full runs, agent spans, generations, tool calls, guardrails, handoffs, and supports trace grouping/metadata.
   - Source: https://openai.github.io/openai-agents-python/tracing/

5. Standards are shifting from prompt-only to protocol surfaces.
   - MCP standardizes server features as Resources, Prompts, and Tools.
   - Agent Skills standardizes portable `SKILL.md` folders with optional scripts, references, templates, and assets.
   - OpenTelemetry now has GenAI semantic conventions, including agent, MCP, OpenAI, Anthropic, spans, events, and metrics surfaces.
   - Sources:
     - https://modelcontextprotocol.io/specification/2025-11-25
     - https://agentskills.io/home
     - https://opentelemetry.io/docs/specs/semconv/gen-ai/

6. Coding-agent products are moving toward control planes.
   - OpenHands describes a control-plane direction with sandboxed runtime execution and defined permissions.
   - Factory emphasizes task decomposition, environment grounding, multi-model trajectories, private/customer-relevant evals, sandboxing, audit trails, and explainability.
   - Sources:
     - https://www.openhands.dev/blog/openhands-enterprise-agent-control-plane
     - https://factory.ai/news/code-droid-technical-report

## Hermes-Specific Lessons

Hermes is relevant even though Forge decided not to actively maintain Hermes translator output in v3 (`docs/work/2026-04-28-skeleton-pivot/locked-decisions.md:161`-`165`). The product pattern is still worth learning from.

Hermes Kanban architecture:
- Dashboard, CLI, and worker tools all route through the same per-board SQLite DB (`~/.hermes/kanban.db` or board-specific DB), keeping every surface consistent.
- Worker agents never use the dashboard directly; they operate through a dedicated `kanban_*` toolset.
- Columns are not just visual: triage, todo, ready, in-progress, blocked, done encode task lifecycle.
- The dispatcher supports dependencies, profile lanes, structured handoffs, run history, retry, circuit breaker, crash recovery, and stranded-task diagnostics.
- Worker lanes have a clear contract: assignee string, spawn mechanism, and exactly one lifecycle terminator (`complete`, `block`, or failure/reap).
- Orchestrator profiles are told to route, not execute; they decompose work and create/link child tasks.

Sources:
- https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial
- https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes
- https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/devops/devops-kanban-orchestrator
- https://hermes-agent.ai/features/multi-agent

What Forge should copy:
- A durable task/run/event kernel.
- Worker-only tool/API contract.
- Structured handoff summaries and metadata.
- Parent/child dependencies with automatic readiness promotion.
- Retry history as first-class data, not just latest status.
- Heartbeats, stale claims, crash recovery, circuit breakers, and stranded-work diagnostics.
- Orchestrator anti-temptation rule: decompose and route, do not implement.

What Forge should not copy:
- A Forge-owned always-on dispatcher as the first implementation. The v3 plan explicitly defers a central orchestration layer (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:256`) and requires the dashboard to operate without Forge-owned orchestration while external orchestrators consume the same runtime state (`docs/work/2026-04-28-skeleton-pivot/release-plan.md:248`-`249`).
- A board-first model where the board is the canonical truth. Forge already has Beads, Git, audit, evidence, and adapters; the board should be a view over the runtime ledger.

## V3 Feature Mapping Against Current Options

| Forge v3 feature | Current-day comparable pattern | What to learn |
|---|---|---|
| Runtime graph contract (`0.0.12`) | LangGraph state graphs; ADK workflow agents | Model stages as graph nodes and edges, not a hardcoded ladder. Preserve deterministic dry-run output. |
| Config + introspection (`0.0.13`) | Kubernetes-style effective config; CLI explain/why surfaces | `forge options why <id>` is as important as the config loader because agents need a queryable reason chain. |
| Evaluator regions + evidence (`0.0.14`) | OpenAI tracing, LangSmith/Langfuse-style eval traces, Factory Crucible | Every gate should have target, evidence, policy, and trace id. Do not let "passed" exist without proof. |
| Templates/install profiles (`0.0.15`) | Backstage templates, CrewAI skills, Agent Skills folders | Templates should compose primitives and record ancestry. They should not become the product. |
| Patch/upgrade/rollback (`0.0.16`) | Terraform/Kustomize overlays, package lockfiles, rollback snapshots | Treat user modifications as intent records, not raw file edits. Keep upgrade reversible. |
| Skills/insights (`0.0.17`) | Agent Skills, Voyager-style skill libraries, Factory pattern detection | Mine repeated work patterns into proposals. Human acceptance must remain explicit. |
| Team runtime dashboard (`0.0.18`) | Hermes Kanban, GitHub Projects, LangGraph Studio, agent control planes | The board should show run state, stale work, review packets, evidence gaps, and adapter drift over the same ledger. |
| Typed memory | MemGPT/Letta tiering, Generative Agents reflection, Claude project memory | Memory categories must differ by write rate, retention, and provenance. Avoid a single vector store as default. |
| Harness translator | Claude/Cursor/Codex skills/hooks/commands | Translate the same contract into harness-native forms, but keep Forge CLI/state as the canonical source. |
| Protected paths | Claude hooks, sandbox runtimes, OpenHands control plane | Enforce before agents mutate sensitive/generated/runtime state. Refuse with repair hint. |
| Extension system | VS Code contributions, Homebrew taps, MCP servers | Declarative manifests, lockfile, trust metadata, namespaced contributions, and sandboxed hooks. |

## What We Need To Do

### 1. Define The Runtime Ledger Before More UI

Minimum event model:
- `runtime.graph.resolved`
- `run.created`
- `run.claimed`
- `run.heartbeat`
- `run.completed`
- `run.blocked`
- `run.failed`
- `run.reclaimed`
- `evidence.captured`
- `evaluator.started`
- `evaluator.passed`
- `evaluator.failed`
- `handoff.created`
- `adapter.sync.started`
- `adapter.sync.failed`
- `proposal.created`
- `proposal.accepted`
- `proposal.rejected`

Each event needs:
- schema version
- workspace/repo/branch
- issue adapter id
- graph node id
- run id
- actor/agent/harness
- parent correlation id
- artifact links
- evidence links
- policy decision
- provenance

### 2. Add A Worker Contract, Not A Dispatcher

Forge should define the equivalent of Hermes worker lanes but keep execution pluggable:
- claim work
- read context
- emit heartbeat
- emit structured handoff
- complete/block/fail exactly once
- attach evidence and artifacts
- preserve run history

This can be consumed by Codex, Claude, Cursor, Hermes, OpenHands, or a custom CI worker without Forge owning the orchestrator.

### 3. Make Handoff Context First-Class

A downstream worker should not reread everything. It should receive:
- parent summaries
- prior attempts
- block reasons
- changed files
- tests run
- decisions
- open questions
- evidence links
- reviewer requirements

Hermes does this well through `worker_context`; Forge should do it through `forge run context --json` or equivalent.

### 4. Separate Deterministic Control From LLM Autonomy

Use deterministic runtime logic for:
- dependency readiness
- stage transitions
- required evidence checks
- retry limits
- stale claim detection
- protected path enforcement
- config resolution

Use agents for:
- decomposition
- implementation
- critique
- synthesis
- research
- proposal generation

This matches ADK/CrewAI/LangGraph patterns and keeps the runtime auditable.

### 5. Treat Evidence As The Main Differentiator

Many tools orchestrate agents. Forge's edge should be evidence-bound software delivery:
- every claim cites proof
- every gate cites evidence
- every reviewer packet has source links
- every accepted insight has audit history
- every "why" answer is reconstructable

### 6. Keep Hermes As A Product Pattern, Not A Target

D13's decision to drop active Hermes translator maintenance is still reasonable if translator stability/adoption is weak. But Hermes Kanban should influence Forge's `0.0.18` design:
- task/run/event tables
- worker lane contract
- claim TTL
- heartbeats
- block/unblock
- prior-attempt context
- external lane plugins
- diagnostic views

### 7. Reframe The Board As One View Over Runtime State

The board should show:
- intake readiness
- run ledger
- blocked/stale/crashed runs
- evidence gaps
- evaluator failures
- review-required work
- adapter sync health
- proposal queue
- team scorecards

It should not be the runtime itself.

## Recommended Next Research/Build Slices

1. Runtime ledger schema.
   - Compare Hermes `task_runs`/`task_events`, OpenAI trace spans, OTel GenAI conventions, and current Beads audit capabilities.

2. Worker contract.
   - Draft `claim/read-context/heartbeat/complete/block/fail` API and map it to Codex/Claude/Cursor/Hermes/OpenHands.

3. Handoff packet schema.
   - Define exactly what downstream agents receive from parent tasks, prior attempts, evidence, reviews, and decisions.

4. Evaluator/evidence schema.
   - Make evaluator targets, required evidence, policy, and gate outcomes serializable and queryable.

5. External orchestrator adapter.
   - Prove Forge can be driven by one external scheduler without adopting a central dispatcher.

6. Board/dashboard views.
   - Build only after the ledger and worker contract exist.

## Bottom Line

Forge v3 should compete as an agentic delivery runtime, not as a Kanban board. The key product bet is: a team can use any coding agent or orchestrator, but Forge gives them the durable graph, evidence, gates, memory, adapter contract, handoff state, and audit trail that make the work trustworthy.

