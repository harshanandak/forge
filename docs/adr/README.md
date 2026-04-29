# Architectural Decision Records

This directory holds **Architectural Decision Records (ADRs)** — short, immutable documents that capture a single architectural decision, its context, and its consequences.

## When to add an ADR

Add an ADR when a decision:

- Affects how multiple components interact (cross-cutting).
- Is hard to reverse later (one-way door).
- Locks Forge into a specific tool, format, schema, or pattern.
- Future contributors will ask "why did we do this?" about.

For decisions scoped to a single work item, prefer the `decisions.md` file inside the relevant `docs/work/<date>-<slug>/` folder.

## File naming

`<NNNN>-<short-slug>.md`, e.g., `0001-layered-skeleton-config.md`. NNNN is a zero-padded sequence; never reuse numbers.

## Template

```markdown
# NNNN — <decision title>

**Date**: YYYY-MM-DD
**Status**: proposed | accepted | superseded by ADR-XXXX | deprecated

## Context

What is the issue we are seeing that motivates this decision? Provide enough background that a future reader does not need to consult anything else.

## Decision

What we are going to do, stated in active voice.

## Consequences

- Positive consequence 1
- Negative consequence 1
- Trade-off accepted

## Alternatives considered

- Option A — rejected because ...
- Option B — rejected because ...
```

## Current ADRs

(none yet — populate as v3 skeleton decisions land)
