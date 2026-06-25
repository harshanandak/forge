---
name: recap
description: >
  Produce a bounded, token-aware summary of an issue's history and current state
  — its description, status, dependencies, and accumulated comments. Wraps
  `forge recap` so an agent can rebuild context on a single issue after a
  session break without re-reading the entire issue store.
metadata:
  author: forge
  command: forge recap
---

# forge recap

## Purpose

Reconstruct context on one issue quickly. `forge recap <issue>` distills the
issue's description, status, dependency links, and comment trail into a bounded
summary, so you can resume work without manually scrolling its full history.

## When to Use

- At the start of a session that resumes a previously claimed issue.
- After context compaction, to reload what an issue is about and where it stands.
- Before commenting or closing, to confirm the latest state.

## Command

```bash
forge recap <issue>         # bounded summary of one issue
```

## Instructions

1. Run `forge recap <issue>` with the id you are resuming.
2. Read the summarized status, decisions, and open threads.
3. Treat the recap as the authoritative current state of the issue.
4. Continue with [comment](../comment/SKILL.md) or [close](../close/SKILL.md).

## Example

```
$ forge recap forge-142
forge-142  Wire kernel selector into dispatch  [in_progress]
- Selector wired in bin/forge.js (commit 467b868).
- Multi-id close acceptance test added and green (commit c3bcb36).
- Remaining: confirm release readiness gate clears.
```

## Success Criteria

- [ ] Current issue state is understood from the recap alone.
- [ ] No need to manually re-read the full issue history.

## Related Skills

- show: full raw detail when the bounded recap is not enough.
- comment: record the next progress note after resuming.
