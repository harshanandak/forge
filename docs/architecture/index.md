# Architecture Index

**Status:** Architecture record index and scoped navigation entry point.  
**Update rule:** Any architecture-significant behavior that future implementers need must be captured as a scoped architecture record, ADR, work-folder evidence, or future Kernel/KnowledgeStore proposal.

## Record types

```text
architecture_note      observed architectural fact, rule, constraint, or behavior
architecture_decision  accepted direction after tradeoffs
architecture_question  unresolved ambiguity or decision needed
architecture_conflict  contradictory records or code/docs disagreement
architecture_exception deliberate deviation with owner, reason, and review/expiry
```

## Scope map

Add project scopes here as they become known:

```text
project
  domain
    bounded_context
      subsystem
        component
          API / data model / workflow / operation
```

## Scoped files

- `subsystems/` — subsystem/component architecture records.
- `notes/` — individual architecture notes when no better scoped file exists yet.
- `decisions/` — scoped decision records that are smaller than ADRs or waiting for ADR promotion.
- `questions/` — open architecture questions.
- `conflicts/` — active architecture conflicts.

## Mandatory capture rule

If future users or agents would need the information to avoid breaking the system, capture it with source evidence.

Use:

```text
Observed fact      -> architecture_note
Accepted direction -> architecture_decision or ADR
Unclear topic      -> architecture_question
Contradiction      -> architecture_conflict
Temporary deviation -> architecture_exception
```

## Brownfield adoption

For existing products, do not block work waiting for complete documentation. Start with partial records and improve coverage as files are touched.

Each discovered note should include:

```yaml
id: AN-YYYYMMDD-short-slug
record_type: architecture_note
topic: <domain.subsystem.detail>
scope: <project/domain/subsystem/component>
status: observed
confidence: low | medium | high
source:
  - path: <file-or-doc>
```
