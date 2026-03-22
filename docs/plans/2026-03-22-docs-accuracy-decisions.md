# Decisions Log: docs-accuracy

**Epic**: forge-e3qj
**Date**: 2026-03-22
**Decision gates fired during /dev**: 0 (plan quality: Excellent)

## Design-Phase Decisions (from Phase 1 Q&A)

### Decision 1
**Task**: Task 1 — Version tags
**Choice**: Remove version tags entirely rather than using correct 0.0.3
**Rationale**: Avoids maintenance burden; features exist but aren't versioned releases

### Decision 2
**Task**: Task 2 — OWASP claim
**Choice**: Soften to "in every /plan" rather than removing entirely
**Rationale**: Honest about manual nature while preserving the value message

### Decision 3
**Task**: Task 3 — Tool catalog framing
**Choice**: Reframe around workflow stage categories, not raw count
**Rationale**: Value is breadth of coverage; stays accurate as catalog grows/shrinks

### Decision 4
**Task**: Task 4 — CLI-first wording
**Choice**: "Portability-first" over "CLI-first"
**Rationale**: Matches actual mcpJustified filtering logic in plugin-recommender.js

### Decision 5
**Task**: Task 5 — Plugin docs link
**Choice**: Point to docs/TOOLCHAIN.md
**Rationale**: Best UX — users want setup info, not agent architecture source code

### Decision 6
**Task**: Task 7 — CHANGELOG rename note
**Choice**: Add note at top, don't rewrite history
**Rationale**: Preserves historical record while preventing confusion

### Decision 7
**Task**: Task 8 — Paid alternatives enforcement
**Choice**: No action needed — test already exists and passes
**Rationale**: Existing test at test/plugin-catalog.test.js:148 covers this

### Decision 8
**Task**: Task 9 — QUICKSTART stage numbering
**Choice**: /status as "Utility", stages 1-7 match canonical workflow
**Rationale**: Consistent with README table and AGENTS.md stage definitions
