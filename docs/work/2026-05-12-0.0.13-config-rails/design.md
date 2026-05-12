# 0.0.13 Config Rails And Graph Introspection

**Date**: 2026-05-12
**Status**: in progress
**Branch**: `codex/0.0.13-config-rails`
**Issues covered**: `forge-besw.2`, `forge-besw.3`, `forge-besw.4`, and protected paths from `forge-5146` where it fits the config lint surface.

## Purpose

Build on the landed 0.0.12 runtime graph contract by resolving project `.forge/config.yaml` into the graph, enforcing locked L1 rails, and exposing graph primitives through `forge options`.

## Success Criteria

- `.forge/config.yaml` is optional, parsed when present, and merged into the resolved runtime graph.
- Locked L1 rails cannot be disabled by project config.
- Disabled primitives remain present, addressable, and auditable in the graph.
- `forge options stages|gates|adapters|diff|why <id>|lint` supports human output and `--json`.
- Bad config, disabled locked rails, and protected path policy mistakes produce validation errors.

## Out Of Scope

- `/build` audit persistence.
- Beads audit wiring.
- 0.0.14 audit/evidence storage.
- Runtime execution of graph actions beyond introspection.

## Approach Selected

Extend `lib/core/runtime-graph.js` rather than creating a new graph model. Add a small registry command in `lib/commands/options.js` for introspection, keeping command behavior unchanged unless this new command is called.

## Constraints

- Preserve the 0.0.12 graph shape and command flow.
- Config resolution is project-local only in this PR.
- Protected path support is validation/introspection only, not enforcement against file changes.

## Edge Cases

- Missing `.forge/config.yaml` resolves to package defaults.
- Malformed YAML returns a lint/config error.
- Unknown primitive IDs in config return lint/config errors.
- Attempts to disable locked L1 rails return lint/config errors.
- Broad or invalid protected path entries return lint/config errors.

## Technical Research

- `docs/work/2026-04-28-skeleton-pivot/layered-skeleton-config.md` defines `.forge/config.yaml`, resolution order, `forge options *`, off semantics, and locked rails.
- `lib/core/runtime-graph.js` is the existing runtime graph model from 0.0.12.
- `lib/commands/_registry.js` auto-discovers command modules, so `lib/commands/options.js` is the least invasive CLI surface.

## TDD Scenarios

- Happy path: valid `.forge/config.yaml` disables an unlocked gate and `forge options gates --json` reports it disabled with config provenance.
- Error path: config disables a locked L1 rail and graph resolution/lint reports a blocking error.
- Edge path: malformed YAML and invalid protected paths are reported by `forge options lint`.

## Ambiguity Policy

Use the 7-dimension /dev decision rubric. Proceed only for local, reversible CLI/model details that do not change public execution semantics. Stop for schema, persistence, audit, or command behavior changes outside this PR.
