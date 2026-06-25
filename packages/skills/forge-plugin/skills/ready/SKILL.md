---
name: ready
description: >
  Find the issues an agent can start right now — those whose dependencies are
  all satisfied and that nobody is actively working. Wraps `forge ready` so you
  pick the next unit of work from the Forge issue backend instead of guessing or
  reading the issue store by hand.
metadata:
  author: forge
  command: forge ready
---

# forge ready

## Purpose

Surface the set of issues that are unblocked and available to claim. Forge
computes this from the issue dependency graph, so the list only contains work
whose prerequisites are already closed.

## When to Use

- At the start of a session, to decide what to work on next.
- After closing an issue, to see what its completion just unblocked.
- Before claiming, to confirm an issue is actually ready (not still blocked).

## Command

```bash
forge ready                 # human-readable list of ready issues
forge issue ready --json    # machine-readable list for scripting/agents
```

Prefer the `--json` form when an agent needs to parse ids programmatically.

## Instructions

1. Run `forge ready` (or `forge issue ready --json` to parse the output).
2. Read the issue ids, titles, and priorities in the result.
3. Pick the highest-priority ready issue that fits the current goal.
4. Hand the chosen id to the [claim](../claim/SKILL.md) skill.

## Example

```
$ forge issue ready --json
[
  { "id": "forge-142", "title": "Wire kernel selector into dispatch", "priority": 1 },
  { "id": "forge-143", "title": "Document release readiness gate", "priority": 2 }
]
```

## Success Criteria

- [ ] Only unblocked issues appear in the result.
- [ ] The chosen id is passed on to `forge claim`.

## Related Skills

- claim: claim the issue you selected here.
- show: inspect a ready issue's full detail before claiming.
