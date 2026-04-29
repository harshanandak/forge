# Design: Clean up stale workflow refs in agent commands

- **Feature**: stale-workflow-refs
- **Date**: 2026-03-10
- **Status**: approved
- **Beads**: forge-ctc

## Purpose

Three `.claude/commands/` files reference removed tools (openspec), orphaned files (PROGRESS.md), and a dropped workflow stage (/research). This causes confusion when agents execute these commands and hit nonexistent resources. Additionally, `/premerge` has no CHANGELOG.md maintenance step, so the changelog has fallen behind (last updated 2026-02-03).

## Success Criteria

1. `status.md` — no references to openspec, PROGRESS.md, or /research; replaced with Beads equivalents
2. `rollback.md` — workflow flow shows correct 7-stage pipeline (no /research)
3. `premerge.md` — PROGRESS.md reference replaced with Beads equivalent; CHANGELOG.md update step added
4. All workflow flow diagrams in touched files match: `/status → /plan → /dev → /validate → /ship → /review → /premerge → /verify`
5. No functional/code changes — docs-only PR

## Out of Scope

- Documentation link checker (tracked separately — Beads issue to be created)
- Fixing stale refs in files outside `.claude/commands/` (e.g., package.json, QUICKSTART.md, docs/EXAMPLES.md)
- Changes to `research.md` (already a proper legacy alias redirect)

## Approach Selected

**Approach A: Minimal fix** — Update only the 3 command files to fix stale refs and add CHANGELOG step. Docs-only, no code changes.

Rationale: This is a docs cleanup task. Link checker infrastructure is a separate feature with its own Beads issue.

## Constraints

- Docs-only — no source code, no tests, no new dependencies
- Must preserve the existing structure/format of each command file
- CHANGELOG step in premerge should use Keep a Changelog format (already established in CHANGELOG.md)

## Edge Cases

1. **Stale ref found in a file we're already editing**: Fix inline, document in commit message
2. **CHANGELOG.md format**: Follow existing Keep a Changelog format already in the file
3. **Beads commands in status.md**: Use real `bd` commands that actually work (`bd list`, `bd stats`)

## Ambiguity Policy

Fix inline and document in commit. Low-risk for docs-only changes.

## Technical Research

### Stale Reference Inventory

| File | Line | Stale Reference | Replacement |
|------|------|----------------|-------------|
| status.md | 21 | `cat docs/planning/PROGRESS.md` | `bd list --status completed --limit 5` |
| status.md | 33 | `openspec list --active` | Remove (no replacement needed) |
| status.md | 45 | `openspec list --archived --limit 3` | Remove |
| status.md | 69 | `Next: /research <feature-name>` | `Next: /plan <feature-name>` |
| status.md | 74 | `Run /research <feature-name>` | `Run /plan <feature-name>` |
| rollback.md | 309 | `/status → /research → /plan → ...` | `/status → /plan → /dev → ...` |
| rollback.md | 334 | `/research payment-integration` | `/plan payment-integration` |
| premerge.md | 49 | `docs/planning/PROGRESS.md` | Replace with CHANGELOG.md step |
| premerge.md | 135 | `PROGRESS.md: Feature entry added` | `CHANGELOG.md: Entry added` |

### OWASP Top 10 Analysis

Not applicable — docs-only changes with no code, no user input, no authentication, no data storage.

### TDD Test Scenarios

1. **Happy path**: All 3 files updated, grep for stale terms returns 0 matches (excluding research.md legacy alias)
2. **Workflow consistency**: All workflow diagrams in touched files show identical 7-stage flow
3. **CHANGELOG format**: New premerge step references Keep a Changelog format consistent with existing CHANGELOG.md

### DRY Check

No existing "replace stale workflow refs" logic exists. This is a manual docs edit — no abstraction needed.

## Related Work

- **Link checker** (new Beads issue): Local Lefthook pre-push hook preferred over GitHub Action, to catch broken internal markdown links before they hit PRs. Reference workflow from user's other repo saved in issue description.
