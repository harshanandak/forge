# Incremental Runtime Building-Block Release Plan

**Date**: 2026-05-06
**Status**: Active release-numbered roadmap
**Supersedes**: the old major-version roadmap from D39

## Verified State

- Current package: `forge-workflow@0.0.10`.
- Default branch: `origin/master`.
- The active release path is GitHub Release driven: `.github/workflows/npm-publish.yml` runs tests, verifies `npm pack --dry-run`, then publishes with npm provenance.
- The `2026-04-28-skeleton-pivot` folder name is a historical codename. It is not the package version plan.

## Release Principle

Ship small `0.0.x` releases. Each release must deliver a usable slice, update docs, run the relevant evaluator regions, and be publishable through GitHub Release to npm.

Do not describe active package plans with the old major-version labels.

Future releases get detailed task breakdowns only when that release starts. The roadmap should define sequence, contracts, gates, and release value now; it should not pre-split every future issue into implementation tasks before the preceding release has landed.

## Current Baseline After Recent Merges

The latest `origin/master` baseline already includes the initial migrate dry-run slice from `docs/work/2026-05-05-w0-migrate-dry-run/`, `lib/migrate-dry-run.js`, `lib/commands/migrate.js`, and `test/migrate-dry-run.test.js`.

Treat that work as available baseline for later releases:

- `0.0.12` should reuse the dry-run command path when proving the graph contract.
- `0.0.13` should expose dry-run decisions through config and introspection instead of creating a separate dry-run surface.
- `0.0.16` should extend the existing migrate dry-run into upgrade, rollback, patch, and fixture safety rather than rebuilding migration discovery.

## After 0.0.11: Execution Sequence

1. `0.0.12` starts only after the active docs point to the building-block refinement and the release-numbering evaluator passes.
2. `0.0.12` publishes the runtime graph contract first: phases, actions, artifacts, evaluator regions, gates, and evidence. It must prove the current command flow can be represented without replacing the runtime.
3. `0.0.13` consumes the `0.0.12` graph contract and makes it configurable and explainable through `.forge/config.yaml` and `forge options *`.
4. `0.0.14` consumes the graph and config surfaces, then makes evaluator regions and evidence attachable to plans, research, development, validation, review, claims, and transitions.
5. `0.0.15` consumes graph, config, and evaluator regions to ship starter templates and install profiles. Templates compose primitives only.
6. `0.0.16` consumes the template/config baseline and the existing migrate dry-run baseline to make patch intent, upgrade, rollback, and fixture compatibility safe.
7. `0.0.17` consumes evidence and review history to propose skills, evaluator regions, and workflow improvements with accept/reject audit trails.
8. `0.0.18` consumes issue adapters, run state, evidence, and review packets to ship the team runtime dashboard without requiring a Forge-owned orchestration layer.

## Release Slice Rule

Each release should have:

- One primary user value.
- One required contract or behavior surface.
- One release-specific evaluator region.
- One validation gate that proves the slice is usable.
- Documentation updates that explain adoption and limits.
- A package release through the existing GitHub Release to npm path.

Do not start later-release implementation until the previous release has either shipped or explicitly recorded why it was deferred.

## 0.0.11 Exit / 0.0.12 Entry Handoff

`0.0.11` can exit when:

- Active docs link to `runtime-building-blocks-refinement.md`.
- Active roadmap language uses `0.0.x` release numbering.
- Templates are described as adoption scaffolds, not the product.
- Skills are described as executable playbooks, not the enforcement layer.
- Version-language and concept evaluators pass.
- Validation status is recorded, including any unrelated baseline failures.

`0.0.12` can start when:

- The graph schema file locations are chosen.
- The refined N2 issue is claimed or created against the current baseline.
- The existing strict workflow is represented as graph fixtures.
- The existing migrate dry-run path is identified as the proof surface for resolved graph output.
- Backward-compatibility checks against command docs are listed before implementation starts.

## 0.0.11 - Design Alignment Release

Scope:

- Add `runtime-building-blocks-refinement.md`.
- Supersede active `v3.x` release language.
- Update `README.md`, `FINAL-THESIS.md`, `release-plan.md`, `layered-skeleton-config.md`, and `template-library-and-merge-flow.md`.
- Reframe templates as adoption scaffolds, not product.
- Reframe skills as executable playbooks, not the enforcement layer.

Evaluator regions:

- Doc alignment evaluator.
- Version-language evaluator: active roadmap text must use `0.0.x`, not `v3.x`.
- Concept evaluator: building blocks > templates > skills.

Release gate:

- `runtime-building-blocks-refinement.md` is linked from the folder README.
- `release-plan.md` maps future work to `0.0.x` increments.
- Existing strict workflow remains expressible as a template.

## 0.0.12 - Runtime Graph Contract

Scope:

- Replace the old stage-only contract with graph primitives:
  - `Phase`
  - `Action`
  - `Artifact`
  - `EvaluatorRegion`
  - `Gate`
  - `Evidence`
- Start from N2, but refine it beyond `Stage { enter, run, exit }`.

Evaluator regions:

- Schema conformance.
- Backward compatibility against current command docs.
- Dry-run graph evaluator.

Release gate:

- A workflow graph schema is published.
- Current command flow can be represented by the graph.
- `forge run --dry-run` can print the resolved graph without side effects.

## 0.0.13 - Config And Introspection

Scope:

- Refined N3, N4, N5.
- `.forge/config.yaml` loads workflow graph defaults and project overrides.
- `forge options *` explains phases, actions, gates, evaluators, adapters, and why each is active.

Evaluator regions:

- Config lint.
- Disabled-but-known behavior.
- L1 rail cannot-disable evaluator.

Release gate:

- `forge options why <id>` cites the source of each decision.
- L1 rails cannot be disabled by config, template, or patch.
- Disabled phases/actions remain known, addressable, and auditable.

## 0.0.14 - Evaluator Regions And Evidence

Scope:

- Evaluators attach anywhere: plan, research, dev, validation, review, claim, transition, run failure, and dashboard recommendation.
- Evidence capture becomes first-class.

Evaluator regions:

- Plan quality.
- Research citation quality.
- TDD evidence.
- Review packet completeness.

Release gate:

- An evaluator region can target a plan artifact before development.
- An evaluator region can target a patch before validation.
- Evidence is captured in a structured report.

## 0.0.15 - Adoption Templates And Install Profiles

Scope:

- N6 plus refined N15.
- Starter templates:
  - `strict-tdd`
  - `fast-bugfix`
  - `research-first`
  - `external-orchestrator`
  - `team-runtime`
- Templates compose primitives only.

Evaluator regions:

- Template round-trip.
- Generated config validates.
- Template docs match actual output.

Release gate:

- `forge new <template>` writes a valid config and records template ancestry.
- Users can inspect and override every generated primitive.

## 0.0.16 - Safety, Patch, Upgrade

Scope:

- N11, N12, `forge-1nh6`, `forge-c11n`.
- `patch.md` intent records.
- Rollback snapshots.
- v2 fixture corpus.
- Upgrade dry-run.

Evaluator regions:

- Upgrade idempotency.
- Rollback restore.
- Fixture compatibility.

Release gate:

- Upgrade can be dry-run against representative fixtures.
- Rollback restores the previous managed surfaces.
- Patch intent survives upstream changes.

## 0.0.17 - Skills And Insights

Scope:

- N13 and `forge-besw.24`.
- Pattern detection proposes skills/evaluators from observed review failures.
- Planning skill becomes one configurable template, not the canonical workflow.

Evaluator regions:

- Insight quality.
- Skill proposal usefulness.
- Accept/reject audit trail.

Release gate:

- `forge insights --review-feedback` produces ranked proposals with evidence.
- Accepted proposals can become skills or evaluator suggestions.

## 0.0.18 - Team Runtime Dashboard

Scope:

- `forge board` / dashboard.
- IssueAdapter SPI.
- Run ledger.
- Review packets.
- Ready, blocked, in-flight, stale, review-needed, and conflict-risk views.

Evaluator regions:

- Claim recommendation quality.
- Stale-run detection.
- Review packet completeness.

Release gate:

- Team dashboard can operate without a Forge-owned orchestrator.
- External orchestrators can consume the same runtime state.

## Deferred

- Marketplace allowlist N16.
- Full five resolver set N8; start with local and GitHub only.
- Hardened sandbox.
- Central orchestration layer.
- Auto-merge by default.

## Deployment Per Release

1. Implement on a release branch/worktree.
2. Run `bun run check`, targeted tests, and release-specific evaluator regions.
3. Bump `package.json` to the next `0.0.x`.
4. Tag and create a GitHub Release.
5. Let `.github/workflows/npm-publish.yml` publish to npm.
6. Verify the npm package and update related Beads/GitHub issues.
