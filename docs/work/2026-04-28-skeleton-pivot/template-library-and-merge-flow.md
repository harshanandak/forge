# Template Library And Optional Community Merge Flow

**Status**: Active refinement.
**Supersedes in part**: the earlier claim that templates are the day-one product.

## Positioning

Templates are adoption scaffolds. The product is the runtime building-block system.

A template is a starter composition of:

- phases,
- actions,
- artifacts,
- evaluator regions,
- gates,
- evidence requirements,
- skills,
- adapters,
- dashboard views,
- handoff rules.

Users should be able to apply a template, inspect the generated graph, and replace any non-locked primitive.

## Day-One Value

The day-one value is not "a template library" by itself. The day-one value is that a user can see how the building blocks fit together without authoring a graph from scratch.

Initial templates should be deliberately small:

| Template | Purpose |
|---|---|
| `strict-tdd` | Current Forge discipline expressed as a graph. |
| `fast-bugfix` | Minimal plan, targeted tests, validate, ship. |
| `research-first` | Source-backed research, plan artifact, plan evaluator, task split. |
| `external-orchestrator` | Forge emits contracts/evidence for Symphony-style or Conductor-style runners. |
| `team-runtime` | Dashboard, issue readiness, run ledger, review packet, no central orchestration. |

## Template Format

```yaml
schema_version: 1.0
kind: Template
id: strict-tdd
version: 0.0.11
description: Current Forge workflow discipline expressed as a runtime graph.

composes:
  phases:
    - plan
    - dev
    - ship
    - review
    - verify

overrides:
  workflow.phases.plan.enabled: true
  evaluator_regions.tdd_evidence.policy.on_required_failure: block

artifacts:
  - .forge/config.yaml
  - docs/work/{date}-{slug}/design.md
```

## `forge new <template>` Flow

```bash
forge new strict-tdd
forge options lint
forge options why workflow.phases.plan
forge run plan --dry-run
```

Expected behavior:

1. Resolve the template from the local template catalog.
2. Write or update `.forge/config.yaml`.
3. Record template ancestry in `.forge/template-state.yaml`.
4. Print the generated phases, evaluator regions, gates, and adapters.
5. Run config lint.

## Upgrade And Merge

`.forge/template-state.yaml` records:

- template id,
- template version,
- source commit or package version,
- generated files,
- local overrides.

On upgrade, Forge should compare:

1. old template,
2. new template,
3. local edited graph/config.

If conflicts occur, Forge should preserve the user's intent and produce a reviewable patch. Template upgrades must never silently overwrite user configuration.

## Optional Community Flow

Community publishing is deferred. It should not block the building-block runtime.

If a community forms later:

- templates can be published as extension blocks,
- conformance checks validate template schema and fixtures,
- maintainers can absorb useful templates into the in-tree starter set,
- `derived-from` attribution should be preserved.

## Anti-Goals

- Do not make templates the product.
- Do not make a marketplace a prerequisite for local value.
- Do not force a single workflow style.
- Do not hide the generated graph.
- Do not make template upgrades overwrite user changes.
