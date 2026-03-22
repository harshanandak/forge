# Design Doc: README & Documentation Accuracy

**Feature**: docs-accuracy
**Date**: 2026-03-22
**Status**: approved
**Epic**: forge-e3qj

## Purpose

README.md and supporting docs contain multiple factual inaccuracies vs the actual codebase — wrong versions, wrong flag names, wrong paths, overclaimed features. This erodes trust on first contact. Fix all 8 identified inaccuracies in a single PR.

## Success Criteria

1. No version tags (v1.5, v1.6, v1.7) appear in README feature headers
2. OWASP claim reworded to reflect manual checklist, not automated gate
3. Tool catalog framed around category breadth, not raw count
4. "CLI-first" replaced with portability-first wording matching actual MCP filtering logic
5. Plugin docs link points to docs/TOOLCHAIN.md
6. CHANGELOG has note at top about /check -> /validate and /merge -> /premerge rename
7. Test exists enforcing paid catalog entries always have free alternatives
8. README workflow profiles section acknowledges varying stage counts (3-8)
9. All tests pass, lint clean

## Out of Scope

- Roadmap/planned-features section (deferred to separate issue)
- Bumping package.json version
- Adding automated OWASP gate (separate feature)
- Fixing other epics (CI alignment, validate contracts, onboarding)

## Approach Selected

Doc-only fixes for 7 of 8 issues. One small test addition (forge-b1ai) to enforce paid tools always have free alternatives in the catalog. No production code changes.

## Constraints

- README must remain accurate to current codebase state (0.0.3)
- CHANGELOG is historical — add clarifying note, don't rewrite history
- No feature additions — only corrections and clarifications

## Edge Cases

- Profile stage counts vary (3-8) — README should mention the range without overwhelming the reader
- "30+ tools" → reframe around categories, not count, so it stays accurate as catalog grows/shrinks
- OWASP wording must sound valuable while being honest about manual nature

## Ambiguity Policy

Make reasonable choice and document it. All changes are doc-only (except one test), so risk is minimal.

## Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Remove version tags from feature headers | Version 0.0.3 makes v1.5+ tags misleading; features exist but aren't versioned releases |
| 2 | Soften OWASP to "in every /plan" | Accurate — it's a manual checklist in Phase 2, not an automated gate |
| 3 | Reframe tool count around categories | Value is breadth of coverage, not raw number |
| 4 | "Portability-first" over "CLI-first" | Matches actual mcpJustified filtering logic |
| 5 | Plugin docs → docs/TOOLCHAIN.md | Best UX — users want setup info, not source code |
| 6 | CHANGELOG note at top, not rewrite | Preserves historical record while preventing confusion |
| 7 | Add enforcement test for paid alternatives | Prevents future regressions; all paid tools already comply |
| 8 | Acknowledge profile stage range | Honest about varying workflows without complexity |

## Technical Research

### OWASP Analysis

Not applicable — this PR is doc fixes + one test. No user input, no auth, no API, no data processing. Zero security risk surface.

### Blast-Radius Search

Version tags (v1.5, v1.6, v1.7) also appear in:
- docs/ENHANCED_ONBOARDING.md (6 occurrences) — out of scope (forge-z1ft epic)
- docs/AGENT_INSTALL_PROMPT.md (1 occurrence) — out of scope (forge-z1ft epic)
- docs/research/dependency-chain.md (2 occurrences) — research docs, not user-facing

Only README.md lines 166, 180, 194 are in scope for this PR.

"30+" claim appears only in README.md line 181 — single fix point.

### Verified Findings

| Item | README Claim | Actual Code | File |
|------|-------------|-------------|------|
| Version | v1.5.0, v1.6.0, v1.7.0 | 0.0.3 | package.json:3 |
| Tool count | "30+ curated tools" | 15 tool entries | lib/plugin-catalog.js |
| CLI-first | "Prefers CLI over MCPs" | Skips MCPs unless mcpJustified=true | lib/plugin-recommender.js:117-124 |
| OWASP | "built-in" | Manual checklist in /plan Phase 2 | .claude/commands/plan.md:206 |
| Plugin docs | lib/agents/README.md | Should be docs/TOOLCHAIN.md | README.md:192 |
| Profiles | "7-stage" universal | 6 profiles, 3-8 stages | lib/workflow-profiles.js |
| Paid alts | "Every paid tool shows free alternatives" | parallel-deep-research missing alternatives | lib/plugin-catalog.js:78 |
| CHANGELOG | /check in v1.4.0 section | Should be /validate | CHANGELOG.md:381 |

### TDD Test Scenarios

1. **Happy path**: All `tier: 'paid'` entries in plugin-catalog have a non-empty `alternatives` array
2. **Failure path**: Test fails when a paid entry has no alternatives (validates enforcement)
3. **Edge case**: Each alternative has required `tool` and `tier` fields
