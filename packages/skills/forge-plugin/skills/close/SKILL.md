---
name: close
description: >
  Mark one or more completed issues as done. Wraps `forge close` so finishing
  work updates the Forge issue backend, releases the claim, and unblocks any
  issues that depended on the one you just completed.
metadata:
  author: forge
  command: forge close
---

# forge close

## Purpose

Transition an issue to closed once its acceptance criteria are met. Closing
removes the issue from the ready/in-progress sets and recomputes the dependency
graph so downstream work becomes available.

## When to Use

- After verifying an issue's acceptance criteria (tests green, change shipped).
- When wrapping up several finished issues at once.

## Command

```bash
forge close <id>                # close a single issue
forge close <id> <id> <id>      # close several issues at once
forge issue close <id>          # equivalent issue-scoped form
```

## Instructions

1. Confirm the work is genuinely complete — run the relevant tests first.
2. Leave a final note with [comment](../comment/SKILL.md) if context is useful.
3. Run `forge close <id>` (or pass multiple ids) to close the issue(s).
4. Run [ready](../ready/SKILL.md) again to see what the closure unblocked.

## Example

```
$ forge close forge-142
Closed forge-142. Unblocked: forge-150.
```

## Success Criteria

- [ ] Acceptance criteria are met and verified before closing.
- [ ] Newly unblocked issues are checked with `forge ready`.

## Related Skills

- comment: leave a final note before closing.
- ready: discover what closing this issue unblocked.
