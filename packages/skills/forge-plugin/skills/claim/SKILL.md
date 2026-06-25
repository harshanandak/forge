---
name: claim
description: >
  Take ownership of a ready issue and move it into in-progress for the current
  agent. Wraps `forge claim` so work is visibly assigned in the Forge issue
  backend before any code is written, preventing two agents from racing on the
  same task.
metadata:
  author: forge
  command: forge claim
---

# forge claim

## Purpose

Mark an issue as actively worked by you. Claiming transitions the issue to
in-progress and records ownership, which keeps the ready list accurate for every
other agent.

## When to Use

- Immediately before starting implementation on a ready issue.
- After selecting an id from `forge ready` and reviewing it with `forge show`.

## Command

```bash
forge claim <id>            # claim a single ready issue
```

## Instructions

1. Confirm the issue is ready (see the [ready](../ready/SKILL.md) skill).
2. Run `forge claim <id>` to take ownership.
3. Begin the work; record progress with [comment](../comment/SKILL.md).
4. When finished, transition the issue with [close](../close/SKILL.md).

## Example

```
$ forge claim forge-142
Claimed forge-142 — status: in_progress (owner: current agent)
```

## Success Criteria

- [ ] The issue is in-progress and owned before any edits are made.
- [ ] No other agent is already working the same id.

## Related Skills

- ready: find a claimable id.
- close: release the claim by completing the issue.
