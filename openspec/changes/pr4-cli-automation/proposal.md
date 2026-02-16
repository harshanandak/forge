# Proposal: CLI Command Automation

**Type**: Architecture Change  
**Timeline**: 3-4 days  
**Impact**: High - Fundamentally changes user experience

---

## Problem

Forge currently uses a **documentation-driven workflow** where:
- 11 markdown command files define workflow stages
- AI agents manually read docs and execute bash commands
- No executable command dispatcher
- No automated stage detection
- Users must manually track workflow progress

**Pain Points**:
1. Manual execution - Every command requires AI agent interpretation
2. Error-prone - Easy to skip steps or run in wrong order
3. No automation - Research, planning, PR creation all manual
4. Scattered feedback - Review comments not consolidated
5. Lost users - No intelligent guidance on next steps

---

## Solution

Create an **executable CLI automation layer**:

### 1. Command Dispatcher

```
Usage: forge <command> [args]

Commands:
  status                    → Detect current workflow stage (1-9)
  research <feature-name>   → Auto-invoke parallel-ai
  plan <feature-slug>       → Create branch + Beads + OpenSpec
  ship                      → Auto-generate PR body, create PR
  review <pr-number>        → Aggregate all review feedback
  merge <pr-number>         → Update docs, merge, cleanup
```

### 2. Intelligent Stage Detection

Multi-factor with confidence scoring:
- Branch state (exists, commits, matches PR)
- File existence (research doc, plan, tests)
- PR state (open, reviews, approval)
- Check results (CI/CD status)
- Beads issue state

Output:
```
✓ Current Stage: 6 - /ship (Confidence: High 95%)

Completed:
  ✓ Research doc exists
  ✓ Branch created
  ✓ Tests passing
  ✓ Validation passed

Next: /ship (create PR)
```

### 3. Automated Handlers

**research.js**: Auto-invoke parallel-ai, create research doc  
**plan.js**: Detect scope, create branch, Beads, OpenSpec  
**ship.js**: Extract decisions, calculate coverage, create PR  
**review.js**: Aggregate Greptile + SonarCloud + GitHub Actions

### 4. Architecture

```
bin/forge-cmd.js
  ↓
lib/commands/
  ├── status.js
  ├── research.js
  ├── plan.js
  ├── ship.js
  └── review.js
```

---

## Alternatives

**CLI Framework (Commander/yargs)**: Rejected - unnecessary overhead for 9 commands  
**Full Automation**: Rejected - users need control over critical operations  
**Documentation-Only**: Rejected - users requested automation

---

## Impact

**Speed**: 6-10x faster (30 seconds vs 3-5 minutes per command)  
**Accuracy**: Eliminate human error in manual steps  
**Compatibility**: Backward compatible, additive only

**Security**:
- Input validation: `/^[a-z0-9-]+$/` only
- Use execFile() not exec()
- Redact secrets in output
- File permission checks
- Git repo validation

**Testing**: ~38 new tests (unit + integration + E2E)

---

## References

- Research: [docs/research/pr4-cli-automation.md](../../../docs/research/pr4-cli-automation.md)
- Beads: forge-9tp
- Roadmap: PR4 (Phase 2)
