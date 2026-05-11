# Feature: 0.0.12 Runtime Graph Contract

Date: 2026-05-11
Status: in progress
Issue: forge-besw.1

## Purpose

Publish the first runtime graph contract for Forge 0.0.12 so the current command workflow can be represented as composable runtime building blocks instead of a stage-only contract.

## Success Criteria

- Runtime graph primitives exist under `lib/core/`: Phase, Action, Artifact, EvaluatorRegion, Gate, and Evidence.
- A versioned JSON schema/envelope is published for runtime graph artifacts.
- The current command flow is represented as a resolved graph.
- `forge migrate --dry-run` can print the resolved graph without writing files.
- Tests prove the current command docs/flow can be represented by the graph.

## Out of Scope

- L1 rails.
- Config loading.
- Options API.
- Protected paths.
- Init behavior.
- Install profiles.
- Audit persistence.
- Behavior rewrites of existing commands.

## Approach Selected

Add a small CommonJS runtime contract module under `lib/core/runtime-graph.js`, export a static schema envelope and a resolved graph for the existing command workflow, and include that graph in the existing migrate dry-run report. This keeps the PR as extraction and reporting only.

## Constraints

- Preserve existing migrate dry-run behavior and report status.
- Keep graph data deterministic and side-effect free.
- Reuse `.claude/commands/*.md` as the compatibility surface for current command docs.
- Do not introduce runtime config loading or user-selectable options.

## Edge Cases

- Missing command docs should be surfaced by tests, not hidden by graph generation.
- Dry-run rendering must keep the existing mutation guard.
- The graph envelope must remain serializable as JSON.

## Ambiguity Policy

Use the 7-dimension `/dev` decision gate. Proceed only for local representation choices that do not alter public behavior. Stop for user input if a choice changes command behavior, adds config loading, or touches persistence.

## Technical Research

- Existing dry-run proof path is `lib/migrate-dry-run.js`, with `buildMigrationDryRunReport` and `renderMigrationDryRunReport`.
- Existing migrate command is `lib/commands/migrate.js`, which only supports `forge migrate --dry-run`.
- Current command docs are `.claude/commands/plan.md`, `.claude/commands/dev.md`, `.claude/commands/validate.md`, and `.claude/commands/ship.md`.
- Existing validation scripts are `bun run typecheck`, `bun run lint`, `bun test`, and `node scripts/validate.js`.

## TDD Scenarios

- Happy path: the resolved graph exposes all six primitives and the plan/dev/validate/ship command flow.
- Compatibility path: every command represented by the graph has a matching `.claude/commands/<command>.md` doc.
- Dry-run path: migrate dry-run output prints the resolved runtime graph and still preserves the mutation guard.
