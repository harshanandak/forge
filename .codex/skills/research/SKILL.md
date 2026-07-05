---
name: research
description: >
  Runs the Forge RESEARCH stage — the technical-investigation phase now embedded as /plan
  Phase 2. Use it when the user wants JUST the research work for a specific feature (not the
  whole plan flow): deep web research on best practices and known gotchas for the chosen
  approach, an OWASP Top 10 risk pass documenting which categories apply and how they'll be
  mitigated, DRY / blast-radius codebase exploration for existing patterns to reuse, and
  identification of at least three TDD test scenarios — all appended under `## Technical
  Research` in that feature's `docs/work/YYYY-MM-DD-<slug>/design.md`. Trigger on phrasings
  like "run the research phase", "do the technical research for this feature", "run an OWASP
  analysis on this", "explore the codebase for reusable patterns before we build", "check
  we're not duplicating an existing helper (DRY)", "add the security + best-practices research
  to the design doc", or "find TDD scenarios for X". If the design doc doesn't exist yet,
  create it first, then research into it. Pick this skill over its siblings: choose `plan`
  instead when the user is starting a feature from scratch and wants the FULL stage —
  one-question-at-a-time design brainstorm plus branch/worktree/task-list setup — not only the
  research; choose `parallel-deep-research` instead when the ask is an external market,
  competitive, or industry report via Parallel AI (business analysis, vendor comparison,
  funding/landscape), not code-level technical/OWASP/DRY research; choose `dev` or `validate`
  instead when the user wants to implement tasks or run security scans/lint/tests against code
  rather than research it.
allowed-tools: Bash, Read, Write, Grep, Glob, WebSearch, WebFetch
---

> **Note**: `/research` is legacy support for the research capability used by planning workflows.
>
> Forge v3 treats `/plan`, `/dev`, `/validate`, `/ship`, `/review`, and `/verify` as configurable building blocks over runtime skills, not a product-wide mandatory ladder. The pre-merge doc gate runs inside `/ship` and `/review` rather than as its own stage.
> `/plan` remains the default planner template and can include:
> - Design intent: constraints, success criteria, and ambiguity policy
> - Technical research: web search, OWASP, codebase exploration, TDD scenarios
> - Setup: branch, worktree, Forge issue, task list
>
> Run `/plan <feature-slug>` when the active workflow needs the default planner template, or invoke the research skill fragment directly when the active plan permits it.

# Research (Legacy Alias)

This skill previously ran a standalone research phase. It is now embedded in `/plan` as Phase 2.

## If you want to run just the research phase

Jump to Phase 2 of `/plan` manually:

1. Read or create the design doc at `docs/work/YYYY-MM-DD-<slug>/design.md`
2. Run parallel web search using the `parallel-deep-research` skill
3. Run OWASP Top 10 analysis for the feature
4. Use the Explore agent for codebase exploration
5. Identify at least 3 TDD test scenarios
6. Append findings under `## Technical Research` in the design doc

Then continue with `/plan <slug> --continue` to run Phase 3 (setup + task list).

## Integration with Workflow

```
Utility: /status  -> Understand current context before starting

Default template:
  /plan      -> Optional default planner; external planners may satisfy /dev entry (research support)
  /dev       -> Implement each task with subagent-driven TDD
  /validate  -> Type check, lint, tests, security
  /ship      -> Push + create PR
  /review    -> Address PR feedback
  /verify    -> Post-merge health check

Pre-merge gate: doc updates + CI-green checkpoint embedded in /ship and /review (not a separate stage).
```
