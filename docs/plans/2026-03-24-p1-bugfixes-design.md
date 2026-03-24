# P1 Bugfixes: Plan Path Contract, Onboarding Doc, Smart-Status jq Error

**Feature**: p1-bugfixes
**Date**: 2026-03-24
**Status**: approved
**Beads**: forge-eji (epic), forge-ddk3, forge-3tnu

## Purpose

Fix three P1 bugs that break core workflow functionality:
1. Plan file path mismatch prevents `/validate` from finding plans created by `/plan`
2. ENHANCED_ONBOARDING.md describes a non-existent 9-stage workflow with invalid `--type` values
3. smart-status.sh crashes because beads 0.62.0 changed JSON field types

## Success Criteria

1. `bin/forge-cmd.js` status command finds plans in `docs/plans/` (not `.claude/plans/`)
2. All references to `.claude/plans/` in source code updated to `docs/plans/`
3. ENHANCED_ONBOARDING.md accurately describes the 7-stage workflow with valid `--type` values (critical|standard|simple|hotfix|docs|refactor)
4. `smart-status.sh` handles both numeric priorities (0-4) and string priorities ("P0"-"P4")
5. `smart-status.sh` handles null `type` fields gracefully
6. All existing tests pass after changes

## Out of Scope

- Changing the actual `/plan` command output location (it already uses `docs/plans/` correctly)
- Restructuring ENHANCED_ONBOARDING.md into multiple files
- Upgrading beads further or changing beads configuration
- Fixing other P2+ bugs found in adjacent code

## Approach Selected

**Direct fix** — update all references to match reality. No architectural changes.

- Bug 1: Find-and-replace `.claude/plans` -> `docs/plans` across all source files
- Bug 2: Rewrite ENHANCED_ONBOARDING.md sections to match AGENTS.md (7-stage, valid types)
- Bug 3: Update jq expressions to normalize priority/type before comparison

## Constraints

- Must maintain backward compat with any older beads versions that still return string priorities
- ENHANCED_ONBOARDING.md rewrite must match AGENTS.md as source of truth
- Test fixtures must match the new canonical path

## Edge Cases

- Priority field: could be number (0-4), string ("P0"-"P4"), or null — handle all three
- Type field: could be string or null — handle both
- `.claude/plans/` directory may still exist in some user projects — no harm, just won't be checked

## Ambiguity Policy

These are deterministic bugfixes. No spec gaps expected. If found, fix conservatively and document.

## Technical Research

### OWASP Analysis
- **A03 (Injection)**: smart-status.sh already sanitizes inputs. No new injection surface.
- No other OWASP categories affected — these are path reference and data type fixes.

### TDD Scenarios
1. Happy path: status command detects plan in `docs/plans/` correctly
2. Edge case: smart-status.sh handles numeric priority (2) same as string ("P2")
3. Edge case: smart-status.sh handles null type without crashing
4. Error path: status command returns no plan when `docs/plans/` doesn't exist
