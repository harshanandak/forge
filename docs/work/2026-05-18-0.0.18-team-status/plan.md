# 0.0.18 Team Status Surface

Date: 2026-05-18
Status: planned
Issues: forge-sxg2, forge-11ds

## Purpose

`forge status` should answer what the current developer should work on next from local Beads/runtime evidence. A companion team board should summarize the same local state for coordination without adding Forge-owned orchestration, ReviewAdapter, IssueAdapter, GitHub sync, or Projects v2 integration.

## Success Criteria

- `forge status` keeps the existing zero-argument personal focus behavior and adds machine-readable JSON for the same state.
- The personal state clearly separates clean repo context, active assigned work, blocked work, stale work, ready work, recent completions, and unresolved workflow state.
- A team board command consumes the same snapshot model and works in human and JSON modes.
- Tests cover clean repo, active work, blocked work, stale work, and empty state.
- Documentation states behavior, limits, sample output, and non-scope.

## Out Of Scope

- ReviewAdapter, IssueAdapter, GitHub Projects v2, GitHub sync, remote review provider state, and Forge-owned orchestration.
- Mutating Beads issue state as part of status or board rendering.
- Replacing the existing workflow-stage status behavior for explicit `--workflow-state` or `--issue-id` invocations.

## Approach

Extend the existing `lib/status/beads-snapshot.js` reader into a shared local runtime snapshot. Keep it file-backed against `.beads/issues.jsonl` plus git context, and derive simple categories rather than adding a cache or remote dependency.

Add presentation helpers for personal status and a new `forge board` registry command. Both commands should accept `--json`; text mode remains the default. `forge status --json` should return the same categories rendered in human mode.

## Acceptance Tests

- Clean repo: context reports clean working tree and status output still renders useful sections.
- Active work: assigned `in_progress` issues appear in personal focus and board active columns.
- Blocked work: open issues with unresolved dependency counts appear as blocked.
- Stale work: old active/open work appears in stale sections based on local `updated_at`.
- Empty state: no issues renders explicit empty sections and JSON arrays.

## Limits

The surface is only as current as local Beads JSONL data. It does not infer GitHub review status, CI state, issue sync freshness, sprint velocity, or remote project columns.
