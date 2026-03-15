# Decisions Log: Command Creator & Eval

- **Feature**: command-creator-and-eval
- **Date**: 2026-03-14
- **Task list**: docs/plans/2026-03-10-command-creator-and-eval-tasks.md
- **Design doc**: docs/plans/2026-03-10-command-creator-and-eval-design.md

---

<!-- Decisions will be logged below as they arise during /dev -->

## Decision: Skip agnix integration (Task 7)

**Date**: 2026-03-14
**Decision**: SKIP -- agnix does not provide sufficient value beyond our existing structural tests.

### Evaluation Summary

Ran `npx agnix@0.16.1 . --format json` against the repo.

**Results**: 228 diagnostics (26 errors, 196 warnings, 6 info) across 128 files checked.

### Rule Breakdown

| Count | Rule | Level | Assessment |
|-------|------|-------|------------|
| 161 | XP-003 (cross-platform) | warning | **False positive.** Flags `.claude/` paths as portability issues. This is the standard Claude Code directory -- by design, not a bug. |
| 16 | AS-010 (agent-skills) | warning | **Not applicable.** Wants "Use when..." trigger phrases in `.codex/skills/` SKILL.md frontmatter. Codex-specific formatting. |
| 11 | AS-002 (agent-skills) | error | **Not applicable.** Missing `name` field in `.codex/skills/` frontmatter. Codex skills follow a different spec than the universal agent skills spec agnix expects. |
| 7 | XML-003 (xml) | error | **False positive.** Flags `</HARD-GATE>` as unmatched XML. This is intentional prompt engineering markup in markdown, not XML. |
| 5 | XP-SK-001 (cross-platform) | info | Noise. Client-specific frontmatter fields. |
| 4 | CDX-AG-005 (codex) | warning | Codex-specific formatting suggestions. |
| 3 | REF-002 (references) | error | **Partially valid.** Broken links in `.codex/skills/rollback/SKILL.md`. But our existing `command-files.test.js` already covers dead reference checks for `.claude/commands/`. |
| 3 | PE-001 (prompt-engineering) | warning | Subjective. "Critical keyword in lost-in-the-middle zone." |
| 18 | Various | mixed | Legacy `.cursorrules` warning, AGENTS.md duplicate (test fixture), misc. |

### Why SKIP

1. **70% false positives**: 161 of 228 diagnostics are XP-003 warnings about `.claude/` paths. These are not portability issues -- `.claude/` is the standard Claude Code directory structure.
2. **XML false positives**: The 7 XML-003 errors about `<HARD-GATE>` are false positives. `HARD-GATE` is intentional prompt engineering markup, not XML.
3. **Existing coverage**: Our structural tests (`command-files.test.js`, `command-contracts.test.js`, `command-sync.test.js`) already cover dead references, contract validation, and sync drift -- the categories where agnix has some valid findings.
4. **Suppression burden**: Integrating agnix would require suppressing 200+ false positives to surface 3-5 genuinely useful findings. The maintenance cost exceeds the value.
5. **No Forge-specific checks**: agnix checks generic multi-agent patterns but does not understand Forge's 7-stage workflow, HARD-GATE semantics, or command contract structure.

### What agnix IS good at (for other projects)

- Detecting broken markdown links across agent config files
- Checking agent skill frontmatter against universal spec
- Cross-platform portability analysis for repos targeting multiple AI tools
- Prompt engineering anti-patterns (lost-in-the-middle, ambiguous terms)

For Forge specifically, these checks either don't apply or are already covered by custom structural tests that understand our domain.
