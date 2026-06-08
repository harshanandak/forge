# Architecture Note Governance: Mandatory Capture, Scale, and Brownfield Adoption

## Problem

Forge needs a way to ensure architectural knowledge is not lost when humans or agents make changes. The issue is broader than formal ADRs:

- business-defined architecture constraints,
- domain rules,
- component boundaries,
- API contracts,
- data model decisions,
- workflow behavior,
- operational assumptions,
- product/business rules that shape implementation,
- discovered architecture from existing/brownfield systems.

Some notes are accepted decisions. Some are observations. Some are open questions. Some are existing facts discovered after the product already exists. They all need a mandatory capture path, but they should not all be placed as giant prose inside one 10,000-line file.

## Core recommendation

Use a two-layer model:

```text
docs/PROJECT_DESIGN.md
  = readable current project map and active architectural index

Architecture Note Records
  = many small scoped records under docs/architecture/** or future KnowledgeStore records
```

`docs/PROJECT_DESIGN.md` must remain the first place humans and agents look, but it should become an index and curated current-state map, not the only storage location for every detail.

## Record types

Forge should distinguish architectural records by lifecycle:

```text
architecture_note
  = observed architectural fact, constraint, domain rule, or component behavior

architecture_decision
  = accepted direction after alternatives/tradeoffs

architecture_question
  = unresolved ambiguity or decision needed

architecture_conflict
  = two records disagree or code contradicts a record

architecture_exception
  = deliberate deviation with owner/expiry/review date
```

Not every note needs consensus. A discovered fact can be recorded as an `architecture_note` with source evidence and status `observed`. It becomes an accepted decision only when reviewed/approved.

## Mandatory capture rule

Any PR, agent session, design discussion, or issue that changes or discovers architecture-significant information must create or update one of:

1. `docs/PROJECT_DESIGN.md` index entry,
2. a scoped architecture note record,
3. an ADR,
4. a work-folder decision/evidence record,
5. a future Kernel/KnowledgeStore proposal.

Work-folder evidence is acceptable as source/proposal material. Accepted/current project direction must be promoted to `PROJECT_DESIGN.md`, an ADR, a scoped architecture record, or a Kernel decision event; it must not remain hidden only in a work folder.

The rule is:

> If future implementers would need to know it to avoid breaking the system, it must be captured as an architecture record with source evidence.

## Scope model for large projects

A Google-scale or large e-commerce project cannot keep every architectural detail in one file. Use scopes:

```text
project
  domain
    bounded_context
      subsystem
        component
          API / data model / workflow / operation
```

Suggested file layout for Markdown phase:

```text
docs/PROJECT_DESIGN.md
  = current high-level map and links

docs/architecture/
  index.md
  domains/
    commerce.md
    identity.md
    fulfillment.md
  subsystems/
    cart.md
    pricing.md
    checkout.md
    inventory.md
  decisions/
    PD-YYYYMMDD-slug.md
  notes/
    AN-YYYYMMDD-slug.md
  questions/
    AQ-YYYYMMDD-slug.md
  conflicts/
    AC-YYYYMMDD-slug.md
```

`PROJECT_DESIGN.md` should link to these scoped files and list current accepted/high-impact records. It should not inline every detail forever.

## E-commerce example

For an e-commerce system, `PROJECT_DESIGN.md` may say:

```text
Cart architecture lives in docs/architecture/subsystems/cart.md.
Pricing architecture lives in docs/architecture/subsystems/pricing.md.
Checkout architecture lives in docs/architecture/subsystems/checkout.md.
Inventory architecture lives in docs/architecture/subsystems/inventory.md.
```

Then `docs/architecture/subsystems/cart.md` contains records such as:

```yaml
id: AN-20260608-cart-price-snapshot
record_type: architecture_note
topic: commerce.cart.price_snapshot
scope: subsystem:cart
status: observed
source:
  - path: apps/api/cart/service.ts
  - path: docs/work/2026-06-08-cart-discovery/evidence.md
```

Statement:

```text
Cart items store a price snapshot at add-to-cart time. Checkout recalculates final price from the pricing service before payment capture.
```

That note may not be a new decision; it is a discovered architecture fact. It still matters and must be retrievable.

Another record:

```yaml
id: PD-20260608-checkout-price-authority
record_type: architecture_decision
topic: commerce.checkout.price_authority
scope: subsystem:checkout
status: accepted
supersedes: []
```

Statement:

```text
Checkout uses Pricing Service as final price authority. Cart price snapshots are UX/reference data, not payment authority.
```

This prevents agents from later treating cart price as payment truth.

## Mandatory enforcement points

### 0. Layered hook enforcement

Architecture capture should be enforced through multiple gates, with agent-native hooks as the preferred user experience and Lefthook as a fallback adapter rather than the policy source of truth:

```text
agent-native hooks      = contextual guidance/blocking before and during work
Forge check engine      = shared policy implementation all adapters call
Lefthook/Git hooks      = repo-local convenience adapter and human safety net
CI/required check       = non-bypass merge gate
future Kernel authority = server-side accepted decision/fact/conflict validation
```

Agents must not bypass Forge workflow gates with `git commit --no-verify`, `git push --no-verify`, `HUSKY=0`, `LEFTHOOK=0`, `git -c core.hooksPath=...`, script-mediated hook bypasses, or hook removal unless the user explicitly authorizes an audited Forge bypass event for that specific action.

See [Hook-Based Architecture Capture Enforcement](architecture-capture-hooks.md) for the detailed hook design.

### 1. Agent/session start

Agents should begin architecture-sensitive work by reading:

```text
docs/PROJECT_DESIGN.md
docs/architecture/index.md
relevant scoped architecture files
```

Future command:

```bash
forge orient --scope cart --include-architecture
```

### 2. PR template

Add a mandatory section:

```markdown
## Architecture impact

- [ ] No architecture-significant behavior changed or discovered.
- [ ] Updated architecture record(s): <AN/PD/AQ/AC IDs or paths>
- [ ] Added source evidence: <paths>
- [ ] Opened question/conflict for unresolved architecture ambiguity: <ID>
```

### 3. Change-path detection

A validator should require an architecture-impact answer when PRs touch sensitive paths:

```text
schema/migrations/**
lib/kernel/**
lib/knowledge/**
lib/storage/**
api/**
services/**
auth/**
payments/**
pricing/**
checkout/**
workflow/**
public CLI/MCP contracts
```

The paths should be configurable per project.

### 4. Architecture record validator

Future command:

```bash
forge architecture check
```

Checks:

- every architecture record has ID, type, topic, scope, status, statement, source link,
- no duplicate active records for the same topic/scope unless allowed,
- broken source paths fail,
- accepted decisions have evidence and reviewer/accepted date,
- superseded records point to replacements,
- conflicts are visible and assigned,
- exceptions include owner, reason, affected scope, expiry/review date, and compensating follow-up,
- `PROJECT_DESIGN.md` links the architecture index.

### 5. Diff-aware architecture guard

Future command:

```bash
forge architecture impact --changed-files <files>
```

It should return:

- architecture records likely affected by touched files,
- missing architecture record warning,
- possible conflicts,
- whether PR checklist can claim “no architecture impact”.

This should start with path/topic rules and later add semantic retrieval.

## Brownfield adoption path

For products that already exist, Forge should not demand complete documentation before value begins. Use progressive discovery.

### Phase 1 — Baseline map

Create:

```text
docs/PROJECT_DESIGN.md
docs/architecture/index.md
```

Record known high-level systems, owners, and unknown areas.

### Phase 2 — Discovery notes

As agents/users touch code, they create `architecture_note` records:

```text
Observed from code, tests, migrations, logs, or old docs.
```

These are not automatically accepted decisions. They are retrievable evidence-backed observations.

### Phase 3 — Confidence and review

Each note carries:

```text
status: observed | reviewed | accepted | stale | superseded | conflict
confidence: low | medium | high
source_kind: code | test | migration | old_doc | user_statement | issue | PR
```

### Phase 4 — Coverage tracking

Forge tracks architecture coverage by scope:

```text
cart: partial
checkout: reviewed
pricing: unknown
inventory: partial
```

The value starts immediately: every new task improves the architecture map instead of waiting for a full rewrite.

### Phase 5 — Conflict resolution

When a note conflicts with code, old docs, or another note, Forge records an `architecture_conflict` and surfaces it in orient/recap/PR review.

## How this avoids a 10,000-line single file

`PROJECT_DESIGN.md` should be constrained to:

- top-level architecture map,
- active project-wide decisions,
- links to scoped architecture files,
- unresolved high-impact conflicts/questions,
- update rules.

Detailed records live elsewhere and are indexed by KnowledgeStore.

In database-backed phase:

```text
PROJECT_DESIGN.md
  = generated/curated map

KnowledgeStore
  = queryable records, source links, FTS/vector search, impact lookup

Kernel
  = accepted decisions/facts/conflicts authority
```

## Minimal implementation sequence

1. Add `docs/architecture/index.md` template.
2. Add `docs/architecture/subsystems/README.md` and `docs/architecture/notes/README.md` templates.
3. Add `.forge/architecture-impact.yaml` schema/defaults for changed-path detection.
4. Add `forge architecture check` as a docs-first validator.
5. Add `forge architecture impact` using path/topic rules and changed-file input.
6. Add PR checklist/session gate text for architecture impact.
7. Add agent-native architecture-impact adapters/instructions before treating Lefthook as sufficient.
8. Add `forge hooks doctor/install/sync` to detect missing worktree/container/agent hook adapters.
9. Wire Lefthook as a fallback adapter to the Forge policy engine.
10. Add no-verify guard policy and audited bypass semantics for agents.
11. Add CI required architecture capture check that validates missing declarations, unknown policy, and audited bypass records.
12. Index architecture records in KnowledgeStore as verbatim/provenance sources and proposals.
13. Add Kernel event types for accepted architecture decisions/facts/conflicts/exceptions.

## Key decision

Architecture capture is mandatory, but global consensus is not required for every record.

```text
Discovered fact -> architecture_note with source evidence
Unclear implication -> architecture_question
Contradiction -> architecture_conflict
Accepted direction -> architecture_decision / ADR / Kernel decision event
Temporary deviation -> architecture_exception
```

This gives value for new and brownfield products while keeping the system scalable.
