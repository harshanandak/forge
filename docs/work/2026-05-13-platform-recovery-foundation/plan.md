# 0.0.16 Platform Recovery Foundation

## Scope

Reliability hardening for Forge on Windows, WSL, external worktrees, Beads state recovery, and hook setup. This slice covers `forge-9ats`, `forge-epkw`, `forge-u7go`, `forge-0g2m`, and the overlapping setup portion of `forge-ujq.2`.

## Current Findings

- Beads recovery already has a shared module at `lib/beads-bootstrap.js` with symlink, safe init, backup restore, and fresh init strategies.
- `lib/commands/worktree.js` calls Beads bootstrap from `forge worktree create` and runs package install for hook dependencies.
- `lib/beads-health-check.js` retries recoverable Beads create failures through the bootstrap path.
- The requested WSL helper name, `bootstrap-windows-tools.sh`, is not present on this branch, so bash entrypoints cannot consistently share Windows/WSL command discovery.

## Implementation Plan

1. Add focused tests for metadata-driven Beads init, external worktree main-root detection, recovery warnings, helper sourcing, and worktree install behavior.
2. Add a shared bash helper for Windows/WSL command discovery and source it from bash entrypoints that call `bd`, `jq`, or `gh`.
3. Tighten Beads bootstrap recovery messages so failures explain the attempted strategy and recovery hint.
4. Keep scope limited to platform recovery; do not implement patch intent, upgrade self-heal, rollback, or adoption templates.

## Platform Assumptions

- Windows worktrees may require directory junctions for `.beads`.
- WSL/bash entrypoints must tolerate Windows-hosted tools discovered through `where.exe`.
- External worktrees may have tracked `.beads` metadata but no live Dolt state.
- Fresh init is last resort and must preserve metadata-derived Dolt database naming.

## Acceptance Criteria

- Beads bootstrap uses `.beads/metadata.json` `dolt_database` for fresh init instead of inferring from folder basename.
- External worktree recovery can locate the main worktree and link or reconstruct `.beads`.
- Bash entrypoints that require `bd`, `jq`, or `gh` source the shared Windows/WSL helper.
- Worktree creation still runs package install so hooks can be installed when dependencies are absent.
- Validation passes with targeted tests plus full project checks.
