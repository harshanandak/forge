---
description: Write OpenSpec + Beads + tasks
---

Create formal plan based on research, with optional OpenSpec proposal for strategic changes.

# Plan

This command creates a formal implementation plan after research is complete.

## Usage

```bash
/plan <feature-slug>
```

## What This Command Does

### Step 1: Read Research
Load the research document:
```bash
cat docs/research/<feature-slug>.md
```

### Step 2: Determine Scope

**Tactical** (Quick fix, < 1 day):
- Skip OpenSpec
- Create Beads issue only
- Single-session work

**Strategic** (Major feature, architecture change):
- Create OpenSpec proposal first
- Wait for approval
- Then create Beads issue
- Multi-session or parallel work

> **💭 Plan-Act-Reflect Checkpoint**
> Before proceeding, reflect on this scope decision:
> - Does this change affect system architecture, APIs, or data models?
> - Will future features depend on getting this design right now?
> - Would a team discussion reveal concerns or better alternatives?
>
> **If unsure**: Review your research doc (`docs/research/<feature-slug>.md`) for complexity signals

### Step 3A: If Tactical

```bash
# Create Beads issue
bd create "<feature-name>"
bd show <id>

# Create branch
git checkout -b feat/<feature-slug>
```

**Output**:
```
✓ Scope: Tactical (no OpenSpec needed)
✓ Beads Issue: bd-p8q1 "Fix login validation bug"
✓ Branch: feat/fix-login-validation
✓ Research: docs/research/fix-login-validation.md

Next: /dev
```

### Step 3B: If Strategic

```bash
# Create OpenSpec proposal
openspec proposal create <feature-slug>

# Write to openspec/changes/<feature-slug>/:
# - proposal.md (problem, solution, alternatives, impact)
# - tasks.md (implementation checklist, TDD-ordered)
# - design.md (technical decisions from research)
# - specs/<capability>/spec.md (delta changes)

# Validate
openspec validate <feature-slug> --strict

# Create Beads issue
bd create "<feature-name> (see openspec/changes/<feature-slug>)"
bd show <id>

# Create branch
git checkout -b feat/<feature-slug>

# Commit proposal
git add openspec/ docs/research/
git commit -m "proposal: <feature-name>

Research documented in docs/research/<feature-slug>.md
OpenSpec proposal in openspec/changes/<feature-slug>/"

git push -u origin feat/<feature-slug>

# Create proposal PR
gh pr create --title "Proposal: <feature-name>" \
  --body "See openspec/changes/<feature-slug>/proposal.md"
```

**Output**:
```
✓ Scope: Strategic (architecture change)
✓ OpenSpec Proposal: openspec/changes/stripe-billing/
  - proposal.md: ✓ (references research doc)
  - tasks.md: ✓ (8 steps, TDD-ordered)
  - design.md: ✓ (8 key decisions documented)
  - specs/payments/spec.md: ✓ (delta changes)
  - Validation: PASSED

✓ Beads Issue: bd-x7y2 "Stripe billing (see openspec/changes/stripe-billing)"
✓ Branch: feat/stripe-billing
✓ Committed: Proposal + research doc
✓ PR created: https://github.com/.../pull/456

⏸️  WAITING FOR PROPOSAL APPROVAL

After approval, run: /dev
```

### Step 4: Link Beads to OpenSpec (if strategic)

```bash
bd update <id> --comment "OpenSpec: openspec/changes/<feature-slug>"
```

## Integration with Workflow

```
1. /status               → Understand current context
2. /research <name>      → Research and document
3. /plan <feature-slug>  → Create plan and tracking (you are here)
4. /dev                  → Implement with TDD
5. /check                → Validate
6. /ship                 → Create PR
7. /review               → Address comments
8. /merge                → Merge and cleanup
9. /verify               → Final documentation check
```

## Tips

- **Strategic vs Tactical**: When in doubt, start tactical. Refactor to strategic if needed.
- **OpenSpec for architecture**: Use proposals for anything that changes system design
- **Use research decisions**: Reference research doc in OpenSpec proposal
- **TDD-ordered tasks**: Order tasks.md by test dependencies
- **Link everything**: Connect Beads → OpenSpec → Research doc
