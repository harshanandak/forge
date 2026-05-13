# 0.0.15 adoption entrypoint

**Date**: 2026-05-13
**Branch**: `codex/0.0.15-adoption-entrypoint`
**Status**: planned
**Issues**: `forge-fvh9`, `forge-besw.5`, `forge-6hzl`, `forge-besw.14`

## Purpose

Make Forge adoptable in a fresh repository through `forge init`. The entrypoint should write inspectable `.forge/config.yaml` defaults and template ancestry metadata so users can inspect the resolved runtime graph immediately with existing `forge options` commands.

## Success Criteria

- `forge init --profile minimal|standard|full --yes` creates `.forge/config.yaml` in a clean repository.
- The three profiles produce distinct runtime graph config defaults.
- The generated config records template ancestry metadata and validates with `forge options lint`.
- A thin interactive onboarding path delegates to the same profile definitions.
- Docs describe the shipped init/profile flow and explicitly frame templates as adoption scaffolds.

## Out Of Scope

- Harness translator.
- Adapter marketplace.
- Upgrade or rollback flows.
- Patch intent.
- Treating templates as the Forge product instead of scaffolds over runtime primitives.

## Approach Selected

Add a registry-backed `init` command and a small profile library. The command writes only `.forge/config.yaml` and delegates inspection to the existing runtime graph loader and `forge options` surface. Profiles are data definitions, not a separate workflow engine.

## Constraints

- Keep config compatible with `lib/core/runtime-graph.js`.
- Keep onboarding thin: ask for a profile only, then call the same non-interactive initializer.
- Do not require Beads for minimal adoption.
- Preserve existing `setup` behavior except for allowing `setup --minimal` as an alias to `init --profile minimal`.

## Implementation Tasks

See `tasks.md`.
