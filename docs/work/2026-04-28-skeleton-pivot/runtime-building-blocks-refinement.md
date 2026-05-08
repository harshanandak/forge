# Runtime Building-Blocks Refinement

**Date**: 2026-05-06
**Status**: Active successor refinement for the `2026-04-28-skeleton-pivot` design folder
**Supersedes in part**: `FINAL-THESIS.md` product hierarchy, `release-plan.md` version labels, and template-as-product framing

## Thesis

Forge is a configurable workflow/runtime building-block system for agentic software delivery.

The product is not one workflow, one template library, one skill library, or one orchestration layer. The product is the set of primitives that lets teams define:

- what work exists,
- what actions can run,
- what artifacts must be produced,
- where evaluation happens,
- what evidence is required,
- what gates block or warn,
- which skills implement behavior,
- which skill fragments can be invoked independently,
- which adapters expose the same contract to agents, trackers, and external orchestrators.

Templates remain important, but only as adoption scaffolds. A template is a precomposed example of the primitives, not the primitive itself.

## Product Hierarchy

1. **Core primitives**
   - `Phase`
   - `Action`
   - `Artifact`
   - `EvaluatorRegion`
   - `Gate`
   - `Evidence`
   - `Skill`
   - `Adapter`
   - `RunLedger`
   - `ReviewPacket`

2. **Runtime engine**
   - loads the workflow graph,
   - resolves project/user/tool overrides,
   - runs actions,
   - invokes skills,
   - captures evidence,
   - evaluates artifacts and state,
   - applies gate policy,
   - writes audit/run state.

3. **Adapters**
   - issue adapters: Beads, GitHub, Linear,
   - harness adapters: Codex, Claude, Cursor, and later additional harnesses,
   - external orchestrator adapters: Symphony-style, Conductor-style, hosted coding agents.

4. **Templates**
   - starter compositions for common team styles,
   - editable examples,
   - adoption accelerators,
   - never the only supported path.

## Workflow Graph Model

Stages are presets. The runtime model is a graph.

```yaml
workflow:
  phases:
    plan:
      actions:
        - id: write_design
          produces: design_doc
      evaluator_regions:
        - id: plan_review
          target: artifact:design_doc
      gates:
        - id: plan_required_for_critical

    dev:
      actions:
        - id: implement_task
          produces: patch
      evaluator_regions:
        - id: tdd_evidence
          target: artifact:patch
        - id: spec_compliance
          target: artifact:patch

artifacts:
  design_doc:
    path: docs/work/{date}-{slug}/design.md
  patch:
    source: git_diff

evaluator_regions:
  plan_review:
    evaluators:
      - plan_completeness
      - risk_review
    policy: block_on_required_failure
```

## Evaluator Regions

Evaluation must be attachable anywhere, not only to code validation.

Evaluator regions can run:

- before an issue is claimed,
- before a phase starts,
- after an action,
- against an artifact,
- before a transition,
- before ship,
- during review,
- after a failed run,
- on a dashboard recommendation.

Each evaluator region defines:

- `target`: artifact, phase, action, transition, issue, PR, run, or workspace,
- `evaluators`: deterministic checks, AI reviewers, human review, external tools,
- `evidence`: required proof,
- `policy`: continue, warn, loop, block, handoff, human approval, or audit skip,
- `retry`: whether a failed region can rerun automatically,
- `visibility`: local, team, public issue, or PR comment.

## Skills

Skills are executable/procedural playbooks. They are not enforcement.

A skill can implement:

- planning,
- research,
- debugging,
- review,
- migration,
- a tool integration,
- an evaluator,
- a remediation loop.

The runtime decides whether the result passes. Skills provide behavior; evaluator regions and gates provide proof and policy.

## Composable Skill Invocation

Skills are hierarchical runtime nodes, not only top-level commands. A stage skill such as `plan` or `dev` can act as a super-skill that composes smaller callable sub-skills:

- `plan.intent_capture`
- `plan.parallel_research`
- `plan.parallel_critics`
- `plan.synthesis`
- `plan.final_lock`
- `dev.implement_task`
- `dev.spec_review`
- `dev.quality_review`
- `validate.reproduce`
- `validate.root_cause`
- `validate.verify`

The runtime may invoke the whole super-skill, or only one sub-skill, depending on the workflow graph, current evidence, user request, and gate state. This is how Forge keeps the strict current workflow expressible as one template without forcing every run to execute every phase.

Invocation rules:

- Super-skills declare the full composition and default order.
- Sub-skills declare their own inputs, outputs, evidence requirements, evaluator regions, and gates.
- A skipped sub-skill remains addressable in the resolved graph; it is not deleted from the contract.
- `forge options why <skill-id>` explains why a super-skill or sub-skill was invoked, skipped, blocked, or delegated.
- Accepted local skills can replace a sub-skill without replacing the whole stage.

## Templates

Templates are starter compositions of the runtime primitives.

Initial examples:

- `strict-tdd`
- `fast-bugfix`
- `research-first`
- `external-orchestrator`
- `team-runtime`
- `docs-only`
- `security-sensitive`

Users can apply a template, inspect the graph, and then override phases, actions, evaluator regions, gates, and adapters.

## External Orchestrator Compatibility

Forge should not require teams to run a Forge-owned orchestrator.

Instead, Forge should expose contracts that existing orchestrators can consume:

- issue readiness,
- workspace contract,
- workflow graph,
- evaluator regions,
- required evidence,
- run ledger state,
- review packet shape,
- gate outcomes.

Symphony-like, Conductor-like, Cursor, Copilot, Jules, Agent Zero, and other agent runners can execute work while Forge provides the workflow/runtime contract.

## Release Numbering

This folder keeps the historical `v3` codename because it is already linked across docs and Beads issues. It is not the package version plan.

Active package releases are incremental `0.0.x` releases. The current package is `forge-workflow@0.0.10`; this refinement targets the `0.0.11` design-alignment release.

## Continuous Refinement Loop

Every future clarity pass should:

1. Evaluate current docs against this thesis.
2. Mark stale claims as superseded instead of silently rewriting history.
3. Add or update a small release-numbered slice.
4. Keep the current strict workflow expressible as one template.
5. Keep external orchestrator compatibility explicit.
6. Keep super-skill/sub-skill invocation visible in the runtime graph and evaluator regions.
