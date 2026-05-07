# Forge Runtime Building-Block Pivot

**Status**: D1-D42 remain the historical decision baseline for this folder. The current active refinement is [runtime-building-blocks-refinement.md](./runtime-building-blocks-refinement.md). The old `v3` wording is a design-folder codename, not the package version plan. The active package roadmap is `0.0.x` based in [release-plan.md](./release-plan.md), starting from the verified package baseline `forge-workflow@0.0.10`.

## Summary

Forge pivots from a fixed 7-stage opinionated workflow to configurable workflow/runtime building blocks:

- **L1 locked rails**: TDD intent gate, secret scan, branch protection, signed commits, schema + integrity.
- **Runtime primitives**: phases, actions, artifacts, evaluator regions, gates, evidence, skills, adapters, run ledger, review packets.
- **Configurable graph**: project and user config compose primitives into a workflow.
- **Templates**: starter compositions for adoption, not the product itself.
- **Adapters**: Beads/GitHub/Linear, agent harnesses, and external orchestrators consume the same runtime contract.

The old 5-stage model remains useful as one template. The refined model is graph-based: actions produce artifacts, evaluator regions judge artifacts or state, and gates decide continue/warn/loop/block/handoff.

## Release Plan

Use small `0.0.x` package releases, not `v3.x` product versions.

| Release | Focus |
|---|---|
| `0.0.11` | Design alignment and docs refinement |
| `0.0.12` | Runtime graph contract |
| `0.0.13` | Config and introspection |
| `0.0.14` | Evaluator regions and evidence |
| `0.0.15` | Adoption templates and install profiles |
| `0.0.16` | Safety, patch, rollback, upgrade |
| `0.0.17` | Skills and insights |
| `0.0.18` | Team runtime dashboard |

See [release-plan.md](./release-plan.md) for scope, evaluator regions, gates, and deployment steps.

## Reading Order

1. [runtime-building-blocks-refinement.md](./runtime-building-blocks-refinement.md) - current refinement and product hierarchy.
2. [release-plan.md](./release-plan.md) - active `0.0.x` release roadmap.
3. [FINAL-THESIS.md](./FINAL-THESIS.md) - historical 2026-04-29 baseline; keep for context.
4. [locked-decisions.md](./locked-decisions.md) - D1-D42 decisions with rationale, tradeoffs, and anti-decisions.
5. [LEARNINGS.md](./LEARNINGS.md) - takeaways from the iteration process.
6. [iteration-driven-planning-skill.md](./iteration-driven-planning-skill.md) - planning method, now treated as one configurable planning template/skill.
7. [v3-redesign-strategy.md](./v3-redesign-strategy.md) - reference strategy with superseded sections preserved.

Design references:

- [layered-skeleton-config.md](./layered-skeleton-config.md) - runtime graph config, evaluator regions, L1 rails, templates, and adapters.
- [extension-system.md](./extension-system.md) - extension manifest, resolvers, lockfile, and sandbox notes.
- [skill-distribution.md](./skill-distribution.md) - skill distribution and name collision rules.
- [skill-generation.md](./skill-generation.md) - observed-work mining into skill proposals.
- [agent-memory-architecture.md](./agent-memory-architecture.md) - typed memory categories and storage choices.
- [template-library-and-merge-flow.md](./template-library-and-merge-flow.md) - templates as adoption scaffolds, plus optional community merge flow.

## Continuous Refinement Rule

When new clarity arrives:

1. Add a small successor refinement or decision note.
2. Mark stale claims as superseded instead of silently rewriting history.
3. Keep package release plans in `0.0.x` terms.
4. Keep external orchestrator compatibility explicit.
5. Keep the strict current workflow expressible as one template.
