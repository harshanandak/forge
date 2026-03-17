# Decisions Log: Command Behavioral Eval + Improvement Loop

- **Design**: docs/plans/2026-03-16-command-eval-design.md
- **Tasks**: docs/plans/2026-03-16-command-eval-tasks.md
- **Branch**: feat/command-eval
- **Beads**: forge-agp

---

## Decision 1
**Date**: 2026-03-16
**Task**: Task 9 — Improvement loop
**Gap**: Spec lists `reason: "improved"` but there's no code path that produces it — improvement always continues to max_iterations
**Score**: 0/14
**Route**: PROCEED
**Choice made**: `max_iterations` with `bestScore > originalScore` is functionally equivalent to "improved". Adding a fourth reason code for a narrow edge case that can't occur (improved but didn't hit max) adds complexity for no benefit.
**Status**: RESOLVED

## Advisory Notes (from final review)
- **A1**: Convert `execSync` git commands in eval-runner.js to `execFileSync` array form (defense-in-depth, not a current vulnerability)
- **A2**: Setup/teardown shell commands are intentionally trusted repo-committed content
- **A3**: CLI `_rewriteCommand` placeholder — CLI not standalone-usable yet, by design
- **A4**: Consider renaming `_invokeGrader` in pipeline to `_gradeOverride` for clarity
- **A5**: `status.eval.json` `in_progress_work` query has placeholder IDs in setup/teardown — needs dynamic setup mechanism
