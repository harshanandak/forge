# Forge Runtime Graph Config Architecture

**Status**: Active config model for the runtime building-block refinement.
**Supersedes in part**: the previous stage/gate-only layered skeleton config.

## Goal

The config should describe composable runtime primitives, not only a list of stages. A stage is now a preset shape over lower-level primitives:

`Phase -> Action -> Artifact -> EvaluatorRegion -> Gate -> Evidence`

## `.forge/config.yaml`

```yaml
schema_version: 1.0

forge:
  package_range: ">=0.0.11 <0.1.0"

rails:
  tdd_intent:
    locked: true
  secret_scan:
    locked: true
  branch_protection:
    locked: true
  signed_commits:
    locked: true
  schema_integrity:
    locked: true

workflow:
  phases:
    plan:
      enabled: true
      actions:
        - id: write_design
          skill: planning
          produces: design_doc
      evaluator_regions:
        - id: plan_review
          target: artifact:design_doc
      gates:
        - id: plan_required_for_critical

    dev:
      enabled: true
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
    kind: markdown
    path: docs/work/{date}-{slug}/plan.md
  patch:
    kind: git_diff

evaluator_regions:
  plan_review:
    evaluators:
      - plan_completeness
      - risk_review
    evidence:
      capture: summary
    policy:
      on_required_failure: block

gates:
  plan_required_for_critical:
    when: issue.classification == "critical"
    outcome: block

templates:
  strict-tdd:
    composes:
      - workflow.phases.plan
      - workflow.phases.dev
      - workflow.phases.ship
      - workflow.phases.review
      - workflow.phases.verify

adapters:
  issue:
    primary: beads
    mirrors:
      - github
  harness:
    targets:
      - codex
      - claude
      - cursor
```

## Resolution Order

1. Core locked rails.
2. Package defaults.
3. Applied template.
4. Project `.forge/config.yaml`.
5. Team overlay.
6. User profile overlay.
7. Explicit command flags.

The resolved graph must be inspectable. Agents and external orchestrators should not need to read YAML directly.

## Introspection Commands

- `forge options phases`
- `forge options actions --phase <id>`
- `forge options artifacts`
- `forge options evaluator-regions`
- `forge options gates`
- `forge options adapters`
- `forge options templates`
- `forge options diff`
- `forge options why <id>`
- `forge options lint`
- `forge run <phase-or-action> --dry-run`

## Off Semantics

Disabled primitives remain known, addressable, and auditable.

| State | Behavior |
|---|---|
| `enabled: true` | Runs normally. |
| `enabled: false` | Refuses by default with a clear notice and suggested re-enable command. |
| `--force` | One-shot run; writes audit/run evidence. |
| `locked: true` | Cannot be disabled by template, project config, patch, or user profile. |
| Required by template | `forge options lint` warns or blocks according to the template policy. |

## Preserved Advantages

- The old workflow matrix remains expressible as a template.
- Stage transition enforcement becomes graph transition enforcement.
- Conversational enforcement stays: refusals should include the next concrete fix.
- Beads remains the default issue/run/audit substrate.
- Multi-harness sync remains adapter-driven rather than runtime duplication.

## Open Questions

1. Should evaluator region schemas live in `lib/core/` or `lib/evaluators/`?
2. Should `patch.md` target graph node IDs directly or anchor IDs inside generated files?
3. How much of `forge options *` should be available before full runtime graph execution ships?
