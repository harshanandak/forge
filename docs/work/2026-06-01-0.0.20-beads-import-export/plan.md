# Feature: 0.0.20 Beads Import/Export Adapter And Fidelity Report

Date: 2026-06-01
Status: locked for PR C development
Issue: forge-2agy.2.3
Branch: codex/0.0.20-beads-import-export

## Purpose

Build the Beads compatibility adapter as an import/export boundary for Forge Kernel records. Beads remains import/export compatibility only; it is not the runtime authority and this slice does not route issue commands through Beads or through the PR B broker.

## Success Criteria

- Import Beads JSONL issues, dependencies, and comments into Kernel-shaped records.
- Preserve issue IDs, statuses, priorities, parent-child dependencies, blockers, comments, and available timestamps.
- Preserve Beads close reason and closed-at metadata through Kernel events because schema v1 has no direct issue columns for those fields.
- Produce a fidelity report listing preserved fields and explicit gaps for unsupported Beads fields.
- Export Kernel records back to Beads JSONL as a dry-run by default.
- Provide an explicit rollback snapshot when export writes are enabled.

## Adapter Boundary

The adapter lives at `lib/adapters/beads-kernel-compat.js` and is import/export only. It does not call `bd`, mutate Kernel authority, claim work, close issues, or depend on PR B broker internals.

Import returns pure Kernel-shaped record groups:

- `issues`
- `dependencies`
- `comments`
- `priorityEvents`
- `events`

Export returns Beads-compatible `issues.jsonl`, `comments.jsonl`, and `dependencies.jsonl` content. Dry-run output is the default so callers can inspect proposed writes before touching `.beads`.

## Fidelity Report

The fidelity report includes:

- record counts for issues, dependencies, comments, and close events,
- a preserved-field list for IDs, priorities, statuses, dependencies, comments, close reason, and timestamps,
- gap entries for fields unsupported by Kernel schema v1, currently owner, labels, and dependency metadata.

## Rollback

Import rollback is discard-only because import does not mutate Beads files. Export rollback captures the previous content and existence state of `issues.jsonl`, `comments.jsonl`, and `dependencies.jsonl` before writing, then restores or deletes those files on rollback.

## Out Of Scope

- No PR B broker/API implementation changes.
- No Beads runtime authority.
- No command routing through Kernel APIs.
- No conflict quarantine implementation beyond preserving import metadata needed by the next slice.
