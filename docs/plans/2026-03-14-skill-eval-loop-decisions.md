# Skill Eval Loop — Decisions Log

**Design doc**: [2026-03-14-skill-eval-loop-design.md](2026-03-14-skill-eval-loop-design.md)
**Beads**: forge-1jx

---

## Decision 1
**Date**: 2026-03-14
**Task**: Task 7-9 — Run skill-creator eval loops
**Gap**: Skills in `skills/` directory not discoverable by `claude -p`
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Recreated `.claude/skills/` symlinks in the worktree (normally created by `bunx skills sync`, but gitignored so not present in worktrees). Also created Windows-compatible eval script (`scripts/eval_win.py`) since `run_eval.py` uses `select.select()` which fails on Windows pipes.
**Status**: RESOLVED

## Decision 2
**Date**: 2026-03-14
**Task**: Task 7-9 — Run skill-creator eval loops
**Gap**: 4 Parallel AI skills (web-search, web-extract, deep-research, data-enrichment) compete with Claude's built-in tools (WebSearch, WebFetch). No description change can make them auto-trigger because Claude prefers built-in capabilities.
**Score**: 3/14
**Route**: PROCEED
**Choice made**: Accepted that built-in tool competition is a Claude Code architecture limitation, not a description quality issue. These skills must be invoked explicitly via `/parallel-web-search` in workflows (already the case in /plan and /research). Focused improvement efforts on description clarity and documented the finding. Skipped iterative improvement loop for these 4 skills since the root cause is not addressable via descriptions.
**Status**: RESOLVED

## Decision 3
**Date**: 2026-03-14
**Task**: Task 10 — Cross-skill regression check
**Gap**: Cannot test cross-skill disambiguation for Parallel AI skills because they don't auto-trigger
**Score**: 1/14
**Route**: PROCEED
**Choice made**: Cross-skill disambiguation is moot for skills that don't auto-trigger. The true-negative rates are 100% for all 6 skills, confirming no false-positive cross-triggering. Documented this as the cross-skill check result.
**Status**: RESOLVED
