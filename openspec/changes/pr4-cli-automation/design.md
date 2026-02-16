# Design: CLI Command Automation

Technical design and architecture decisions for PR4.

---

## Architecture Decisions

### Decision 1: Plain Node.js (No CLI Framework)

Use plain Node.js without Commander.js/yargs/oclif

**Reasoning**: Established patterns, only 9 commands, custom logic needed

**Pattern**: Switch statement dispatch like bin/forge-validate.js

### Decision 2: Stage Detection Algorithm

Multi-factor scoring based on:
- Branch state
- File existence  
- PR state
- Check results
- Beads issue state

Confidence: High (90-100%), Medium (70-89%), Low (<70%)

### Decision 3: Command Handler Structure

Modular exports for testability:
- lib/commands/status.js
- lib/commands/research.js
- lib/commands/plan.js
- lib/commands/ship.js
- lib/commands/review.js

### Decision 4: Security Mitigations

**Input Validation**: Only allow `/^[a-z0-9-]+$/`
**Safe Execution**: Use execFile() with argument arrays
**Secret Redaction**: Never log full API keys
**Path Safety**: Use path.basename() to prevent traversal

### Decision 5: Review Aggregation

Structured output with severity levels:
- Critical
- High
- Medium

---

## Module Responsibilities

**status.js**: Detect stage, calculate confidence, suggest next command
**research.js**: Validate slug, invoke Parallel AI, create research doc
**plan.js**: Detect scope, create OpenSpec/Beads, create branch
**ship.js**: Extract decisions, calculate coverage, generate PR
**review.js**: Aggregate Greptile + SonarCloud + GitHub Actions

---

## Testing Strategy

**Unit**: 25 tests (handlers in isolation)
**Integration**: 10 tests (CLI parsing)
**E2E**: 3 tests (full workflow)

---

## API Integration

**Parallel AI**: Web research (existing in research doc)
**GitHub GraphQL**: PR state, checks, reviews
**Greptile**: Leverage existing .claude/scripts/greptile-resolve.sh
**SonarCloud**: Leverage existing /sonarcloud skill

---

## Error Handling

User-friendly messages with actionable next steps
Graceful degradation when APIs unavailable
Caching to avoid rate limits

---

## References

- Research: [docs/research/pr4-cli-automation.md](../../../docs/research/pr4-cli-automation.md)
- Pattern: bin/forge-validate.js
- Tests: test/e2e/ (PR3)
