# Subsystem Architecture Records

Use this directory for scoped architecture maps and records by subsystem/component.

Recommended file names:

```text
cart.md
pricing.md
checkout.md
identity.md
kernel.md
knowledge.md
```

Each subsystem file should stay readable and link to detailed notes, ADRs, work folders, tests, and source files.

## Subsystem file template

```markdown
# <Subsystem> Architecture

## Current summary

Short current-state overview.

## Active records

- `<ID>` — short statement and link.

## Data model / contracts

Important entities, invariants, APIs, events, and ownership rules.

## Operational behavior

Runtime flows, failure behavior, retries, consistency model, queues, projections.

## Open questions and conflicts

- `<AQ/AC ID>` — link and short summary.

## Source evidence

- Code/docs/tests/work-folder links.
```
