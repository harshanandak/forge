# Week 3 Runtime Capability Packs

**Status:** Week 3 planning target.
**Verified on:** 2026-05-24.
**Depends on:** W0 cross-harness skill parity and W1 protected-path harness evidence.

## Current Implementation Check

Current Forge implementation does not yet match the full parity model discussed for v3.

What exists:

- W0 skill metadata parity: one canonical skill fixture rendered to Claude Code, Cursor, and Codex surfaces, documented in [AGENT_SKILL_PARITY.md](../../reference/AGENT_SKILL_PARITY.md).
- W1 protected-path parity work exists as PR #187 at verification time, not as landed `master` behavior. That PR adds a protected-path manifest and evidence command for seven protected-path categories across Claude, Cursor, and Codex, with Cursor marked as fallback.
- v3 docs already frame templates as adoption scaffolds and runtime building blocks as the product.

What is missing:

- A canonical capability registry covering skills, commands, hooks, MCPs, ACPs, books/docs, agents, memory policies, protected paths, marketplace metadata, and workflow stages.
- Replaceable workflow packs so users can disable Forge defaults and activate packs such as Superpowers, Impeccable, project-local packs, or marketplace packs.
- Runtime-enforced required skill loading at stage/gate boundaries.
- On-demand skill loading through a Forge skills MCP server so large or expensive skills stay hidden until needed.
- Installed plugin/workflow discovery and recommendation based on project preferences.
- Harness projections generated from the active project workflow, not hand-maintained per-agent copies.

## Product Rule

Forge owns the stable workflow shell. Capability packs own the implementation.

The user-facing shell remains familiar:

```text
status -> plan -> dev -> validate -> ship -> review -> premerge -> verify
```

Each stage can be implemented by Forge defaults, an external pack, a local project pack, or a composed chain. The runtime must resolve the active graph before any harness receives instructions.

## Capability Pack Model

A pack can contribute:

- stages and substages
- skills and subskills
- commands and command shims
- hooks and fallback checks
- MCP servers, tools, and resources
- ACP adapters
- books, docs, and reference bundles
- agent/subagent roles
- memory policies and patch override rules
- protected-path categories
- marketplace metadata and trust policy
- UI workflow-composer fields

Each pack must declare:

- `id`, `name`, `version`, `source`, and `lock`
- provided stages and capabilities
- supported harnesses
- permissions and trust requirements
- cost, latency, and risk hints
- conflicts, replacements, and extension points
- recommended task types and project types
- rollback and stale-artifact cleanup rules

## Workflow Composition

Project configuration must support stage-level composition:

| Mode | Meaning | Example |
| --- | --- | --- |
| `replace` | Use this pack instead of the default stage implementation. | Replace Forge `/plan` with Superpowers planning. |
| `extend_before` | Run this pack before the default stage. | Add project context discovery before `/dev`. |
| `extend_after` | Run this pack after the default stage. | Add Impeccable design review after frontend implementation. |
| `optional` | Recommend but do not require the capability. | Offer a security review for low-risk UI copy changes. |
| `disabled` | Do not expose or invoke this capability. | Disable Forge default planning in a Superpowers-only project. |
| `blocked` | Never auto-load; explicit user approval only. | Dangerous migrations, destructive cleanup, or paid long-running scans. |

Resolution precedence:

1. explicit run override from CLI/UI
2. task classification override
3. project config
4. user profile default
5. Forge default pack

## Skill Invocation Policy

Skills cannot rely only on model discretion. The runtime must enforce loading policy.

| Policy | Runtime behavior |
| --- | --- |
| `required` | Must load before a stage, gate, or protected action can proceed. |
| `recommended` | Router should load when task metadata matches. |
| `on_demand` | Metadata is visible, body is loaded only after selection. |
| `gated` | Requires explicit user/runtime approval before loading. |
| `hidden` | Not discoverable unless an explicit command, dependency, or policy asks for it. |
| `execution_only` | Agent never receives full instructions; MCP/runtime executes and returns evidence. |

Mandatory examples:

- `/plan` loads the active planning pack and any required research/critic subskills.
- `/dev` loads TDD, protected-path, task execution, and decision-gate policies.
- `/validate` loads validation and debug policies.
- `/ship` loads PR, docs, and check policy.
- `/review` loads GitHub review/comment policy.
- `/verify` loads post-merge proof policy.

## On-Demand Skills MCP

Forge should expose a `forge-skills-mcp` server instead of projecting every skill body into every harness.

Required tools:

- `search_capabilities(task, projectContext)`
- `inspect_capability(id)`
- `resolve_required_capabilities(stage, action)`
- `load_skill(id, reason)`
- `assert_required_loaded(stage, action)`
- `run_capability(id, inputs)`
- `record_invocation_evidence(event)`
- `recommend_workflow_changes(projectContext)`

The always-visible harness payload should be a small router skill/rule. Most skill bodies remain in the registry until the runtime or user requests them.

## Plugin Discovery And Recommendation

Forge must recognize installed customer workflows and recommend adaptations.

Discovery sources:

- project `.forge/packs`
- user-level Forge pack directory
- `.claude`, `.codex`, and `.cursor` harness folders
- MCP server configs
- marketplace registry/cache
- project-local extension manifests

Recommendation examples:

- Superpowers can replace Forge `/plan`.
- Impeccable can extend frontend design review.
- A GitHub MCP can strengthen `/review`.
- Cursor lacks a verified native hook for a gate, so Forge should keep fallback enforcement.
- A hidden or expensive skill should stay gated because the project prefers low-cost runs.

Recommendations must include evidence, a config diff, rollback path, and affected harness projections.

## Harness Projection Contract

The resolved workflow graph generates harness-specific files:

| Harness | Projection |
| --- | --- |
| Claude Code | plugin manifest, skills, hooks, MCP config, command shims, `CLAUDE.md` if needed |
| Codex | skills, config, MCP config, lifecycle hooks where supported, `AGENTS.md` sections |
| Cursor | `.cursor/rules`, Cursor skills where supported, MCP config, `AGENTS.md`, fallback hook checks |

Cursor projection must explicitly separate on-demand Cursor skills from always-on or scoped `.cursor/rules` policy, and it must keep protected-path hook behavior on fallback unless native Cursor hook evidence exists.

Every projection must report one of:

- `native`
- `translated`
- `fallback`
- `unsupported_known_issue`
- `disabled_by_policy`

## Evaluator Cross-Check Loop

Week 3 implementation must include an evaluator loop so the runtime does not silently drift from the configured workflow.

### Evaluator Inputs

The evaluator must read the same inputs the runtime uses, not an independent checklist:

- `.forge/capabilities.yaml` and any project-local pack manifests
- user profile preferences and project workflow overrides
- task classification and explicit CLI/UI run overrides
- installed pack lock metadata and marketplace trust records
- MCP server configs and discovered MCP capability metadata
- generated Claude, Codex, and Cursor projection files
- protected-path manifest and generated hook/fallback policy
- stage ledger entries showing required, loaded, skipped, gated, and hidden capabilities
- known-issue records for unsupported harness surfaces

The loop runs after capability discovery, workflow resolution, and harness projection:

1. **Collect** installed packs, project/user preferences, task classification, harness support, and current generated files.
2. **Resolve** the active workflow graph with replacement, extension, disabled, gated, hidden, and execution-only rules applied.
3. **Project** the graph into Claude, Codex, and Cursor surfaces.
4. **Cross-check** projections against the graph:
   - every `required` capability is loaded or blocked with a hard error
   - every `gated` capability has an approval record before use
   - every `hidden` capability stays hidden unless a policy dependency opens it
   - every unsupported harness surface is marked `unsupported_known_issue`
   - generated command shims point back to canonical skills or runtime actions
   - disabled packs leave no stale aliases, hooks, rules, or MCP config
5. **Improve** by proposing a minimal config or projection patch when the cross-check fails.
6. **Re-run** the evaluator until it reaches `pass`, `blocked`, or `known_issue`.

The re-run loop must be bounded. The default limit is three repair attempts or five minutes of wall-clock time, whichever comes first. If the evaluator still fails after the limit, it must stop with `blocked`, emit the remaining findings, and include the last proposed repair diff. It must not continue regenerating projections indefinitely.

### Negative Fixtures

Week 3 must include intentionally broken projection fixtures so the evaluator proves it can catch and repair real drift. Required negative fixtures:

- a required stage skill omitted from one harness projection
- a gated skill invoked without approval evidence
- a hidden skill exposed in an always-on harness rule
- a disabled pack leaving behind a stale command alias or hook
- a Cursor projection claiming native hook support when only fallback evidence exists

Each negative fixture must fail before repair, emit a minimal repair recommendation, regenerate or update the projection, and pass on the next evaluator run.

The evaluator must emit machine-readable results:

```json
{
  "kind": "forge.capabilityPackEvaluation",
  "workflowId": "project-default",
  "status": "pass",
  "requiredLoaded": ["forge.plan", "forge.tdd"],
  "gatedAwaitingApproval": [],
  "hiddenOpenedByPolicy": [],
  "projectionFindings": [],
  "knownIssues": []
}
```

This evaluator is the safety net for customer-installed workflows. If a user installs Superpowers, Impeccable, or a private workflow pack, Forge must re-evaluate the graph, recommend the right replacement or extension, and prove the harness projections still match the active project policy.

## Week 3 Deliverables

1. Add `.forge/capabilities.yaml` with Forge default pack metadata, visibility, invocation policy, and stage bindings.
2. Add a capability registry loader and validator.
3. Add a workflow resolver that applies user/project/task overrides.
4. Add an on-demand skills MCP contract with stubbed tools and JSON evidence.
5. Add generated harness projection evidence for Claude, Codex, and Cursor.
6. Add docs showing how to replace Forge `/plan` with Superpowers and extend frontend review with Impeccable.
7. Add an evaluator loop that cross-checks active workflow graph, required skills, gated/hidden policy, generated projections, stale artifacts, and known issues.
8. Add tests proving required skills cannot be skipped at stage boundaries and evaluator failures produce repair recommendations.

## Acceptance Evidence

Week 3 is complete only when Forge can emit machine-readable evidence for:

- active project workflow graph
- installed packs and disabled packs
- required, recommended, gated, hidden, and execution-only capabilities
- skills loaded for a stage and skills intentionally skipped
- harness projection status for Claude, Codex, and Cursor
- known issues when a harness cannot provide native parity
- rollback cleanup for disabled or replaced packs
- evaluator result showing `pass`, `blocked`, or `known_issue` after every generated projection
