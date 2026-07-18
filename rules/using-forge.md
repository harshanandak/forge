---
description: "Always: before any response, if a Forge skill could apply, invoke it (or run forge skill for)"
alwaysApply: true
globs: []
---

# Using Forge (skill dispatch — auto-trigger)

**Before ANY response or action** — including clarifying questions, exploring the
codebase, or checking files — if there is even a **1% chance** a Forge skill
applies to what you are doing, invoke that skill first. Then announce
`Using [skill] to [purpose]` and follow it.

- Not sure which skill fits? Run `forge skill for "<what you are about to do>"`
  for the deterministic best-fit, or read the routing table in the dispatch skill.
- Common routes: build/scope a feature -> plan; implement a task -> dev; fix a
  failing test -> dev (debug first); run checks/lint/tests -> validate; open a PR
  -> ship; address review feedback -> review; where am I -> status.

This rule is a **thin pointer**. The full 1%-rule, red-flags table, subagent
escape hatch, and routing table live in the **`using-forge` dispatch skill**,
installed into your agent's own skill surface by `forge setup` (for Cursor:
`.cursor/skills/using-forge/SKILL.md`) — invoke it by name, or run
`forge skill for "<situation>"`. Do not duplicate that policy here.
