---
name: show
description: >
  Read the full detail of a single issue — title, description, status,
  dependencies, and discussion — by its id. Wraps `forge show` so you gather
  complete context before claiming, commenting on, or closing an issue.
metadata:
  author: forge
  command: forge show
---

# forge show

## Purpose

Retrieve everything Forge knows about one issue so you can act on it with full
context: the description, acceptance criteria, current status, blocking and
blocked-by links, and any prior comments.

## When to Use

- Right after picking an id from `forge ready`, to understand the task.
- Before commenting, to see what has already been recorded.
- Before closing, to confirm the acceptance criteria are met.

## Command

```bash
forge show <id>             # full detail for one issue
forge issue show <id>       # equivalent issue-scoped form
```

## Instructions

1. Run `forge show <id>` with the issue id you want to inspect.
2. Read the description and acceptance criteria to understand the goal.
3. Check the dependency links to confirm the issue is actionable.
4. Review existing comments so you do not repeat prior context.

## Example

```
$ forge show forge-142
forge-142  Wire kernel selector into dispatch
status: in_progress
depends on: forge-130 (closed)
---
Route `forge <command>` through the kernel selector when the kernel backend
is active. Acceptance: multi-id close works end to end.
```

## Success Criteria

- [ ] The issue's description and status are understood before acting.
- [ ] Dependency state is confirmed actionable.

## Related Skills

- ready: find which issue id to show.
- comment: record findings after reviewing the issue.
