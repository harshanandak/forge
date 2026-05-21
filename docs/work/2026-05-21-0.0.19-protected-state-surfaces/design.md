# Feature: 0.0.19 Protected State Surfaces

Date: 2026-05-21
Status: locked for development
Issue: forge-2agy.1
Branch: codex/0.0.19-protected-state-surfaces

## Purpose

Protect Forge's local runtime state from direct agent edits. The protected surfaces are Beads state, Forge config, generated harness files, memory projections, workflows, lockfiles, extension manifests, secrets, immutable paths, and append-only logs.

## Success Criteria

- Direct edits to protected paths are blocked or flagged with a repair hint.
- Allowed Forge API writes can still write protected paths when they declare the required surface.
- Bypass attempts are detectable from staged file changes before commit.
- Edit attempts produce audit-ready events with actor, path, decision, and required surface.
- Tests cover allowed writes, blocked writes, bypass detection, audit completeness, and repair hints.
- Documentation explains protected categories, repair hints, and the sanctioned API write path.

## Out of Scope

- No 0.0.20 issue graph or Beads control plane work.
- No dashboards.
- No Beads replacement.
- No database schema migration.

## Approach

Add a small core module for protected state surfaces:

- `lib/protected-state-surfaces.js` classifies repo-relative paths into protected surfaces.
- `assertProtectedWriteAllowed()` blocks direct writes unless the caller declares a Forge API write for the matching surface.
- `writeProtectedFile()` is the sanctioned helper for Forge-owned writes.
- `buildProtectedStateAuditEvent()` returns an audit-ready payload for callers and tests.
- `scripts/protected-state-check.js` inspects staged changes and exits non-zero on direct protected edits, printing repair hints.

Hook integration stays conservative: add a pre-commit command alongside the existing TDD hook. CI can invoke the same script later without duplicating rules.

## Repair Hint Policy

Every protected decision includes a specific repair hint. Hints point to the command/API surface that owns the path instead of merely saying "do not edit this."

## Ambiguity Policy

If a path matches multiple categories, the stricter first match wins in this order: immutable, secrets, append-only logs, Beads state, Forge config, extension manifests, lockfiles, workflows, generated harness files, memory projections.
