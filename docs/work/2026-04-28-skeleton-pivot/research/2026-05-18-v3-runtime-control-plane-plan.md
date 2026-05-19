# V3 Runtime Control Plane Plan

Date: 2026-05-18

## Intent

Forge should be shaped as a configurable runtime plus control plane for agentic software delivery. The product is not a fixed workflow, a Kanban board, a Beads wrapper, or a UI shell. The product is the contract that lets teams define, inspect, run, evaluate, and change their own agent delivery flows safely.

This plan follows the existing v3 direction:

- Forge is a runtime building-block system, not one workflow (`runtime-building-blocks-refinement.md:9`-`21`).
- The graph contract comes first: phases, actions, artifacts, evaluator regions, gates, evidence, skills, and adapters (`runtime-building-blocks-refinement.md:27`-`35`).
- Config and introspection come before richer surfaces (`release-plan.md:35`-`41`).
- The team dashboard must work without Forge owning a central orchestrator (`release-plan.md:248`-`249`).

## Product Shape

Forge should expose three layers:

1. Runtime kernel.
   - Durable graph.
   - Event/run ledger.
   - Stage/action/hook execution contracts.
   - Evidence and evaluator policy.
   - Adapter interfaces.
   - Protected-path and safety rails.

2. Configuration control plane.
   - Project and profile settings.
   - Toggleable stages, substages, hooks, evaluators, templates, adapters, and extensions.
   - Multi-project view.
   - Diff, why, dry-run, and rollback for every change.

3. Agent-facing generated surfaces.
   - Codex, Claude, Cursor, OpenCode, and future harness outputs.
   - `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, skills, commands, hooks, and MCP config generated from the same runtime source.
   - Native harness files remain generated views, not separate truth.

## Planning Constraints From Evaluator Pass

The plan must avoid three failure modes:

1. Runtime scope drifting into a central orchestrator too early.
   - `0.0.12` should stay schema plus dry-run graph proof.
   - Dispatch/scheduling behavior should wait until the run ledger and adapter contracts prove the demand.

2. UI getting ahead of the data contract.
   - The first UI/control-plane work should be powered by CLI JSON: `options`, `why`, `diff`, `lint`, `dry-run`, and later `board`.
   - The first dashboard should not include every possible saved view, matrix, scorecard, and parallel-console feature.
   - Start with provenance-backed `ready` and `stale/evidence-missing` views.

3. Memory scope expanding into a new database project.
   - Keep typed category/provenance fields.
   - Defer reflection, compaction intelligence, cross-backend recall, and vector search until actual recall failures justify them.

Beads remains the only shipped issue adapter through this stage. Design `IssueAdapter`, but do not spend the first slices building a second adapter without a real trigger.

## Core User Jobs

### Project Owner

- See every project configured under Forge.
- Compare each project's active flow.
- Toggle stages or substages on/off.
- Pick a template or install profile.
- Enable/disable hooks and evaluators.
- Add extensions safely.
- See why a setting is active and where it came from.
- Roll back a bad config change.

### Team Lead

- See which projects are using strict, standard, minimal, or custom flows.
- Enforce organization-level rails.
- Distribute approved extension packs.
- Review run/evidence health without reading raw logs.
- Detect stale work, broken adapters, skipped gates, and missing evidence.

### Agent Orchestrator

- Ask Forge what is runnable.
- Claim or spawn work.
- Read structured handoff context.
- Emit heartbeat, evidence, and final state.
- Respect protected paths and gate policy.
- Run under Codex, Claude, Cursor, Hermes, T3-style UI, CI, or a custom scheduler.

### Individual Developer

- Start a project with `forge new`.
- See a simple dashboard or TUI instead of editing YAML for common changes.
- Understand what changed before committing config updates.
- Use memory and hooks without learning every harness-specific file layout.

## Configuration Model

Treat every configurable feature as a typed runtime component:

```yaml
components:
  stages:
    dev:
      enabled: true
      required: true
      implementation: stage.dev.tdd
      substages:
        red:
          enabled: true
        green:
          enabled: true
        refactor:
          enabled: true
      hooks:
        before:
          - hook.scope_guard
        after_success:
          - hook.capture_tdd_evidence
        after_failure:
          - hook.debug_packet
      evaluators:
        - evaluator.tdd_evidence
      evidence:
        required:
          - test_failure_red
          - test_pass_green
          - final_validation
```

Rules:

- Components are addressable by id.
- A disabled component remains known and explainable.
- Every component has owner, source layer, status, and last validation result.
- UI toggles write a patch/intent record, not silent file mutations.
- `forge options why <id>` must explain source, overrides, dependencies, and safety locks.

## UI Direction

Start with a local web/TUI control plane backed by the CLI, not a cloud product.

The information architecture should be CLI-first and mirrored into UI later:

- `Configure`: templates, phases, actions, artifacts, evaluator regions, gates, adapters, hooks, extensions.
- `Explain`: `forge options why`, config diff, lint, and dry-run resolved graph.
- `Run`: phase/action dry-run and execution once the runtime contract exists.
- `Board`: late views over ready work, stale runs, missing evidence, and adapter health.
- `Audit`: lockfile, ledger, evidence, force/override history.

Primary views:

1. Projects.
   - Project list.
   - active template/profile.
   - health summary.
   - last run.
   - adapter status.

2. Flow Builder.
   - stages and substages as a graph.
   - toggle components.
   - select implementations.
   - dry-run preview.
   - config diff.

3. Hooks And Actions.
   - lifecycle events.
   - enabled handlers.
   - handler source: core, project, profile, extension.
   - permissions/trust.
   - recent executions.

4. Extensions.
   - installed extensions.
   - available extension packs.
   - capabilities contributed: stages, hooks, evaluators, commands, adapters, templates.
   - trust and lockfile status.

5. Memory.
   - project instructions.
   - user memory.
   - typed Forge memory categories.
   - sync/export targets for Codex/Claude/Cursor.
   - provenance and stale-memory warnings.

6. Runs.
   - active runs.
   - run ledger.
   - evidence.
   - handoffs.
   - blocked/stale/crashed work.

## Hooks Model

Forge needs its own normalized hook lifecycle, then translators emit harness-native hooks where available.

Normalized events:

- `forge.session.start`
- `forge.session.stop`
- `forge.config.changed`
- `forge.prompt.submit`
- `forge.stage.start`
- `forge.stage.success`
- `forge.stage.failure`
- `forge.stage.blocked`
- `forge.action.before`
- `forge.action.after.success`
- `forge.action.after.failure`
- `forge.tool.before`
- `forge.tool.after.success`
- `forge.tool.after.failure`
- `forge.permission.request`
- `forge.subagent.start`
- `forge.subagent.stop`
- `forge.task.created`
- `forge.task.completed`
- `forge.extension.install`
- `forge.extension.uninstall`
- `forge.file.changed`
- `forge.evidence.captured`
- `forge.evidence.missing`
- `forge.evaluator.failed`
- `forge.audit.recorded`
- `forge.memory.before_compact`
- `forge.memory.after_compact`

Hook handler types:

- command
- script
- MCP tool
- HTTP endpoint
- prompt
- agent
- Forge extension action

Safety:

- Hooks have declared permissions.
- Hooks have trust source and lockfile entry.
- Hooks can be disabled per project/profile unless locked by L1 or org policy.
- Blocking hooks must return structured decisions.
- Non-blocking hooks must be async and observable.
- Generated Claude/Cursor/Codex hook files should include source comments and checksum metadata.
- Required synchronous hooks may block.
- Advisory hooks may warn but must not silently mutate workflow state.
- Async hooks can only observe/report.
- Long-running hooks need timeout, failure policy, and visible diagnostics.

Claude Code's hook model is a strong reference: it supports session, prompt, tool, subagent, task, worktree, compact, config, and file-change events, multiple handler types, matchers, scope locations, and decision control. Forge should translate to that when targeting Claude, but keep Forge event names stable across all harnesses.

## Memory Model

Memory should not be "Beads memory." Beads is one backend for issue graph and audit, not the universal memory layer.

Forge should expose typed memory categories:

- decisions
- session episodes
- skills/procedures
- working state
- issue graph
- audit trail
- preferences/instructions

Memory files by harness:

- Codex may have its own memory registry and AGENTS.md behavior.
- Claude uses `CLAUDE.md`, project/user/local settings, rules, hooks, and skills.
- Cursor supports project/user rules and `AGENTS.md`.
- Forge should generate or update harness-facing instruction files from typed memory, with provenance and opt-in sync.

Rules:

- Write category is required.
- Read returns source and freshness.
- User-editable memory remains markdown.
- Agent-private memory is inspectable.
- No single vector store as the default.
- Memory compaction is an explicit event and can trigger hooks.
- Stale or superseded decisions must not be silently reintroduced into generated files.

Recommended memory chain:

```text
Forge typed memory
  -> project canonical docs and patch records
  -> harness instruction projections
     -> AGENTS.md
     -> CLAUDE.md
     -> .cursor/rules/*.mdc
     -> skill trigger indexes
```

Projection rules:

- Forge runtime state remains the canonical source for workflow graph, stage composition, typed memory, hooks, adapters, and protected-write policy.
- `AGENTS.md` is the generated generic-agent instruction projection from that runtime source, not a separately edited authority.
- `CLAUDE.md` should delegate to the generated generic projection and contain only Claude-specific affordances.
- Cursor rules, Codex-facing memory surfaces, commands, hooks, and skill trigger indexes are projections, not peer canon.
- Codex `MEMORY.md` should be treated as external agent memory: read/import only when explicitly available, but project writes go through Forge typed memory or `bd remember`.
- Every projection needs source, freshness, and supersession metadata so stale decisions cannot silently re-enter generated files.

## Beads Position

Beads remains valuable for issues, dependencies, sync, and audit history, but Forge should reduce coupling:

- Keep `IssueAdapter` as the contract.
- Keep Beads as the default adapter.
- Avoid writing raw `.beads` files directly.
- Use Beads audit where it works, but define Forge runtime events independently enough to support fallback storage.
- UI should show Beads as an adapter with health, not as the product spine.
- The dashboard should surface adapter drift and sync failures instead of hiding them.

The practical rule is:

- Beads remains issue/workflow authority.
- GitHub sync may overwrite shared issue fields only.
- Forge workflow context and memory categories remain typed and provenance-bearing.
- Cache files never override current Beads state.
- Raw `.beads` file edits are outside the normal runtime path.

## Orchestration Model

Borrow from Hermes, T3 Code, LangGraph, ADK, and CrewAI without copying any one product.

Forge should own:

- runtime graph
- component registry
- run ledger
- worker contract
- handoff schema
- evidence schema
- adapter schema
- hook schema
- generated harness surfaces

Forge should not own first:

- always-on central dispatcher
- cloud-hosted scheduler
- mandatory agent pool
- one canonical UI workflow

Worker contract:

- `listReady(capabilities) -> WorkRef[]`
- `claim(workRef, capabilities, leaseTtl) -> Claim`
- `startRun(claim, actionRef, inputs) -> runId`
- `readContext(runId) -> WorkerContext`
- `heartbeat(runId, phase, summary, evidenceRefs, nextEta)`
- `appendEvidence(runId, evidence)`
- `handoff(runId, handoffPacket)`
- `complete(runId, result | blocked | failed, reviewPacket?)`
- `release(runId, reason)`

Workers must not mutate workflow policy directly. They return evidence, state proposals, and handoff packets; Forge gates decide pass, warn, block, loop, or handoff.

Run ledger fields:

- run id
- project id
- workspace
- branch/worktree
- issue adapter id
- claim id
- graph node id
- parent run id
- orchestrator id
- worker id
- harness
- state
- lease status and expiry
- heartbeat timestamp
- current action
- commit before/after
- inputs hash
- evidence links
- handoff links
- trace ids
- gate results
- cost/risk flags where known
- failure/block reason
- retry count
- policy decisions
- resume token

Handoff packet:

- handoff id
- source run id
- target role or capability
- blocking/non-blocking reason
- task summary
- scope
- files touched
- decisions made
- tests run
- evidence links
- open questions
- blockers
- prior attempts
- next suggested action
- allowed actions
- forbidden actions
- resume command
- expiry

## Extension And Automation Model

Extensions can contribute:

- stage implementations
- substages
- hooks
- evaluators
- evidence collectors
- adapters
- templates
- UI panels
- commands
- skills
- MCP servers/tools

Every extension must declare:

- permissions
- contributed components
- lifecycle hooks
- config schema
- trust source
- version and checksum
- whether it can run automatically
- whether it can block workflow
- whether it can write files

UI behavior:

- install extension
- inspect contributed components
- toggle per project/profile
- dry-run generated changes
- approve trust prompts
- rollback extension update

## Suggested Roadmap Adjustment

### 0.0.12: Runtime Graph Contract

Add explicit component ids and lifecycle slots for stages, substages, hooks, evaluators, and evidence. The graph fixture should include at least two dev variants:

- strict TDD dev
- lightweight implementation dev

Keep this release to schema, fixtures, and dry-run graph proof. Do not add scheduling, dispatch, dashboard, or rich hook execution semantics here.

### 0.0.13: Config And Introspection

Add `forge options` support for:

- enabled/disabled component state
- source layer
- dependency reason
- locked/unlocked status
- generated harness targets
- project/profile override path

Add a machine-readable config diff for UI.

This is the first control-plane backend. It should answer user-facing questions before any rich UI exists:

- What is active?
- Why is it active?
- Where did it come from?
- Is it locked?
- What would change if I toggle it?
- What generated files would be affected?

### 0.0.14: Evidence And Evaluators

Make evaluator result and evidence objects durable enough to power run views, not just pass/fail gates.

Also add the first normalized event records needed by hooks and ledger work, but keep them minimal.

### 0.0.15: Templates And Profiles

Ship templates as selectable runtime compositions:

- minimal
- standard
- strict TDD
- review-heavy
- team runtime

Each template should demonstrate toggles and override points.

### 0.0.16: Patch, Upgrade, Rollback

Make UI changes write patch intent records. Add rollback snapshots for config and generated harness surfaces.

### 0.0.17: Skills, Insights, Memory

Broaden insights beyond review feedback:

- repeated hook failures
- repeated manual toggles
- repeated missing evidence
- repeated handoff gaps
- stale memory references

Keep memory MVP limited to typed write/recall contracts, provenance, and projection manifest. Defer smart compaction and cross-backend recall.

### 0.0.18: Runtime Dashboard

Only build dashboard after:

- runtime ledger exists
- hook events are normalized
- memory projections are explicit
- adapter health is queryable
- config diff/why is stable

First dashboard scope:

- project list
- active template/profile
- ready work
- stale or evidence-missing work
- adapter health
- latest run/evidence links

Defer matrix views, scorecards, ownership workflows, and full parallel-agent console until the ledger proves the data model.

## First Build Slices

1. Component registry and config schema.
   - stages, substages, hooks, evaluators, evidence, adapters, templates.

2. `forge options` as UI backend.
   - list, why, diff, lint, dry-run JSON.

3. Config editor CLI.
   - apply template, toggle primitive, explain locked/disabled states, write via transaction.

4. Template state and upgrade preview.
   - ancestry, local overrides, conflict patch, rollback preview.

5. Hook schema and translators.
   - normalize Forge lifecycle; emit Claude hooks first, then Cursor/Codex projections where possible.

6. Typed memory projection.
   - Forge memory categories to AGENTS/CLAUDE/Cursor rules with provenance.

7. Runtime ledger.
   - run events, worker state, evidence links, handoff packets.

8. Extension manager MVP.
   - `gh:` and `./local`, manifest validation, registry, lockfile, collision report, hook/evaluator contribution toggles.

9. Minimal local control plane.
   - project list, flow builder, hooks panel, memory panel, run view.

10. Board JSON MVP.
   - `ready`, `stale`, `missing-evidence`, `adapter-health`, backed by ledger and adapter state.

## Open Questions

- Should Forge UI be a local web app, TUI, or both?
- Should UI write only `patch.md`, or also edit `.forge/config.yaml` through a CLI transaction?
- How much of hook execution should be Forge-owned versus harness-owned?
- What is the minimum Codex hook projection available today, and should Forge fall back to shell/git hooks where native hooks are absent?
- Should `MEMORY.md` become one generated Forge projection target, or should Forge keep memory projection limited to generic instructions plus harness-specific memory files?
- What is the migration path for existing Beads-heavy projects if Beads remains difficult to update?

## Working Thesis

The next mold for v3 is:

> Forge is the configurable runtime and control plane beneath many agent UIs. T3 Code, Hermes, Codex, Claude, Cursor, CI, or custom schedulers can all sit above it. Forge's job is to make the workflow graph, configuration, hooks, memory, evidence, and run state explainable and safe.
