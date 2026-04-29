# Skill Eval Loop — Results Summary

**Date**: 2026-03-14
**Beads**: forge-1jx
**Branch**: feat/skill-eval-loop

---

## Before/After Trigger Rates

| Skill | Before (recall) | After (recall) | True-Negative | Score |
|-------|----------------|----------------|---------------|-------|
| citation-standards | 0% (0/6) | **50% (3/6)** | 100% (6/6) | 9/12 |
| sonarcloud-analysis | 0% (0/6) | **50% (3/6)** | 100% (6/6) | 9/12 |
| parallel-data-enrichment | 0% (0/7) | **14% (1/7)** | 100% (8/8) | 9/15 |
| parallel-deep-research | 0% (0/7) | **0% (0/7)** | 100% (8/8) | 8/15 |
| parallel-web-search | 0% (0/8) | **0% (0/8)** | 100% (7/7) | 7/15 |
| parallel-web-extract | 0% (0/8) | **0% (0/8)** | 100% (7/7) | 7/15 |

**Note**: "Before" baselines were all 0% due to two issues:
1. Skills were in `skills/` (not discoverable) — needed to be in `.claude/skills/`
2. Previous eval script used `select.select()` on Windows (broken on pipes)

After fixing discovery + eval script, the "after" results above are the true baselines with improved descriptions.

## What Changed

### Discovery Fix
- Skills must be in `.claude/skills/<name>/SKILL.md` for Claude Code to discover them
- Project uses `skills/` as source of truth (committed), with `.claude/skills/` as gitignored symlinks
- Worktrees need symlinks recreated: `ln -s "../../skills/$name" ".claude/skills/$name"`

### Description Improvements
All 6 skill descriptions were updated to be more "pushy" per skill-creator guidance:
- Added explicit trigger phrases (e.g., "ALWAYS use this when...")
- Added trigger keyword examples (e.g., "Trigger on phrases like 'search for', 'find sources'")
- Added context about when to prefer the skill over alternatives

### Eval Query Improvements
All eval queries rewritten to be:
- More substantive (multi-step, complex tasks)
- More realistic (contextual detail, backstory, file paths)
- Better cross-skill disambiguation (Parallel AI siblings)

### Windows-Compatible Eval Script
Created `scripts/eval_win.py`:
- Uses `subprocess.communicate()` instead of `select.select()` (works on Windows)
- Runs queries sequentially instead of ProcessPoolExecutor (avoids paging file crashes)
- Tests REAL skill triggering (no temp command files) via `.claude/skills/` discovery
- Flexible name matching for skill aliases (e.g., `sonarcloud` matches `sonarcloud-analysis`)

## Key Finding: Built-in Tool Competition

**Skills that compete with Claude's built-in tools get 0% recall regardless of description quality.**

| Skill | Competing Built-in Tool | Auto-trigger? |
|-------|------------------------|---------------|
| parallel-web-search | WebSearch | No |
| parallel-web-extract | WebFetch | No |
| parallel-deep-research | WebSearch + reasoning | No |
| parallel-data-enrichment | WebSearch + JSON output | Rarely (14%) |
| citation-standards | None | Yes (50%) |
| sonarcloud-analysis | None (specialized) | Yes (50%) |

From the skill-creator docs: *"Claude only consults skills for tasks it can't easily handle on its own. Simple queries won't trigger a skill even if the description matches perfectly."*

**Implication**: The 4 Parallel AI skills must be invoked explicitly via `/parallel-web-search`, `/parallel-deep-research`, etc. in workflows like `/plan` and `/research`. They cannot auto-trigger from user queries because Claude handles those tasks natively.

## Cross-Skill Regression Check

All 6 skills achieved **100% true-negative rate** — no false-positive cross-triggering between skills. The cross-skill disambiguation queries worked perfectly (skills that shouldn't trigger never do).

## Recommendations

1. **Keep explicit invocation** for Parallel AI skills in /plan and /research workflows
2. **Consider `run_loop.py` improvement** for citation-standards and sonarcloud-analysis (50% → higher recall possible via description optimization)
3. **Fix Windows compatibility** in upstream `run_eval.py` if running full skill-creator loops is needed
4. **Document skill directory requirement** in project setup (`.claude/skills/` symlinks needed for worktrees)
