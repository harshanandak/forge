# Status And Board

`forge status` is a local personal focus surface. With no arguments it reads git context plus local Beads runtime files and shows active assigned work, ready work, blocked work, stale work, recent completions, and workflow state when available.

`forge board` is a local team runtime board. It consumes the same snapshot as `forge status` and groups all local issues into active, ready, blocked, stale, and recent completion columns.

## JSON Mode

Both commands support `--json`.

```bash
forge status --json
forge board --json
```

The JSON shape mirrors the human sections:

- `context`: branch, worktree path, and working-tree cleanliness.
- `personal`: `forge status` personal issue groups.
- `board`: `forge board` team issue groups.
- `workflow`: detected workflow state for zero-argument status when available.
- `limits`: local-source caveats.

## Sample Output

```text
Context
  Branch: codex/0.0.18-team-status
  Worktree: linked
  Working tree: clean

Active Issues
  forge-sxg2 0.0.18 forge status command for personal work focus [in_progress]

Ready
  forge-next Follow-up issue

Blocked
  forge-11ds 0.0.18 team runtime board [open]

Stale
  none

Recent Completions
  forge-besw.12 0.0.17 insights and recap

Workflow
  Development (dev)
  Run now: /dev
  Next after this: /validate
```

```text
Team Runtime Board
Source: local Beads runtime state
Branch: codex/0.0.18-team-status
Working tree: clean

Active
  forge-sxg2 0.0.18 forge status command for personal work focus [in_progress]

Ready
  none

Blocked
  forge-11ds 0.0.18 team runtime board [open]

Stale
  none

Recent Completions
  forge-besw.12 0.0.17 insights and recap
```

## Limits

These commands are read-only and local. They do not create orchestration, mutate issue state, query GitHub, inspect review providers, infer CI health, or sync remote project fields. The data is only as current as `.beads/issues.jsonl` in the current checkout.

## Non-Scope

This surface does not implement ReviewAdapter, IssueAdapter, GitHub sync, GitHub Projects v2, sprint velocity, or remote review-response detection.
