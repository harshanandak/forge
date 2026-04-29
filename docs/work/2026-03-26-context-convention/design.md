# Context Convention — Design Doc

**Feature**: context-convention
**Date**: 2026-03-26
**Status**: planning
**Issue**: forge-8scl

---

## Purpose

AI agents create beads issues and stage transitions with minimal context. The current `stage-transition` output is a single line: "Stage: X complete -> ready for Y". When a different session, agent, or post-compaction revisit occurs, this sparse record makes it hard to understand what happened and why.

This feature enforces structured context at every workflow stage boundary so that any agent can pick up where another left off with full understanding of decisions made, artifacts produced, and priorities for the next stage.

## Success Criteria

1. Stage transitions include summary, decisions, artifact links, and next-stage priorities
2. `beads-context.sh validate <id>` checks required fields and warns on missing ones
3. Command files reference the convention so agents know to follow it
4. AGENTS.md documents the convention as a project standard

## Out of Scope

- Hard git hook enforcement (no exit-1 blocking)
- Automated context generation (agents write the context manually)
- Retroactive context for existing issues (only new transitions)

## Approach Selected

**Medium enforcement (Option B)**: Richer stage-transition templates in `beads-context.sh` plus a `beads-context.sh validate` subcommand that warns (soft block) when required fields are missing. Agents see warnings and self-correct. No hard git hooks.

Why this over alternatives:
- **Option A (docs-only)**: Too weak -- agents ignore conventions without tooling feedback
- **Option B (medium -- selected)**: Balanced -- templates guide agents, validation warns on gaps, no workflow breakage
- **Option C (hard enforcement)**: Too aggressive -- exit-1 hooks would block legitimate hotfix workflows

## Constraints

- Must not break existing workflow. Validation is advisory (exit 0 with warnings, not exit 1).
- Must work for all 7 stages.
- New flags to `stage-transition` are all optional -- existing calls continue to work unchanged.
- Shell script must remain cross-platform (Git Bash on Windows, macOS, Linux).

## Edge Cases

1. **Docs-only changes**: `security_notes` field not required -- no security surface.
2. **Hotfix stages**: May skip non-critical fields (summary is still required, but decisions/artifacts are optional).
3. **Agent ignores warnings**: Acceptable. Convention is self-correcting over time as agents learn from validation output. No hard block.
4. **No stage transitions yet**: `validate` warns "no transitions recorded" rather than erroring.
5. **Multiple transitions for same stage**: Valid (e.g., re-running /validate). Validate checks the most recent transition only.

## Ambiguity Policy

Use 7-dimension rubric scoring per /dev decision gate. >= 80% confidence: proceed and document. < 80%: stop and ask user. Applies project-wide.

---

## Technical Research

### OWASP Top 10 Analysis

This feature is a convention/documentation change with a shell script validator. No user input processing, no network calls, no authentication, no data storage. Risk surface: zero.

| Category | Applies? | Notes |
|----------|----------|-------|
| A01: Broken Access Control | N/A | No access control involved |
| A02: Cryptographic Failures | N/A | No cryptography involved |
| A03: Injection | N/A | Script uses existing `sanitize()` function; new flags follow same pattern |
| A04: Insecure Design | N/A | Advisory-only validation, no security decisions |
| A05: Security Misconfiguration | N/A | No configuration surfaces |
| A06: Vulnerable Components | N/A | No new dependencies |
| A07: Auth Failures | N/A | No authentication involved |
| A08: Data Integrity Failures | N/A | No data integrity concerns |
| A09: Logging Failures | N/A | Beads comments are the audit log; this improves them |
| A10: SSRF | N/A | No network requests |

### TDD Test Scenarios

1. **Happy path: rich stage transition** -- Call `stage-transition` with `--summary`, `--decisions`, `--artifacts`, `--next` flags. Assert the comment includes all four sections as structured lines below the header.

2. **Happy path: validate on well-documented issue** -- Issue has description, at least one stage transition with summary, and design metadata set. `validate` returns exit 0 with "All context fields present" message.

3. **Error: validate on sparse issue** -- Issue exists but has no summary in latest transition and no design metadata. `validate` returns exit 0 but prints warnings listing the missing fields.

4. **Error: validate on nonexistent issue** -- `validate` with a bogus ID returns non-zero exit and prints "Issue not found" error.

5. **Edge: docs-only transition** -- `stage-transition` called without `--security_notes`. No warning emitted for missing security notes (not required for docs changes).

6. **Edge: validate before any transitions** -- Issue exists but has no stage-transition comments. `validate` warns "no transitions recorded" and exits 0.
