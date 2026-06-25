---
name: comment
description: >
  Append a progress note, decision, or finding to an issue's discussion thread.
  Wraps `forge comment` so durable context lives on the issue in the Forge issue
  backend — recoverable across sessions and visible to every other agent —
  rather than only in a transcript.
metadata:
  author: forge
  command: forge comment
---

# forge comment

## Purpose

Record narrative context on an issue: what you tried, what you decided, what is
blocked, or what the next agent needs to know. Comments are the persistent
memory of an issue's history.

## When to Use

- After a meaningful step (a decision made, a blocker hit, a test passing).
- Before pausing work, to leave a clean handoff for the next session.
- When `forge show` reveals missing context you can now supply.

## Command

```bash
forge comment <id> "<message>"        # add a comment to an issue
forge issue comment <id> "<message>"  # equivalent issue-scoped form
```

## Instructions

1. Identify the issue id you are working (from `forge claim`).
2. Run `forge comment <id> "<message>"` with a concise, specific note.
3. Reference commit shas or file paths so the note is actionable later.

## Example

```
$ forge comment forge-142 "Selector wired in bin/forge.js; multi-id close acceptance green (commit c3bcb36)."
Comment added to forge-142.
```

## Success Criteria

- [ ] The note is specific enough to act on without re-deriving context.
- [ ] Decisions and blockers are captured on the issue, not just in chat.

## Related Skills

- show: read existing comments before adding a new one.
- recap: summarize an issue's accumulated comments.
