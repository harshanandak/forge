# Development decisions

## Decision 1

**Date**: 2026-08-30
**Task**: Task 1 — Freeze benchmark identity and comparison
**Gap**: The plan requires a 1.20 token-ratio cap, but the existing test benchmark runner has no real token telemetry.
**Score**: 0 / 14
**Route**: PROCEED
**Choice made**: Keep token comparison fail-closed. The comparator enforces the cap when both artifacts contain verified per-group token evidence and returns `INCOMPLETE` otherwise. Do not fabricate token counts or widen Slice 0 into production telemetry.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-08-30
**Task**: Task 1 — Freeze benchmark identity and comparison
**Gap**: The converged `plan-v3.md` measurement contract was omitted when the immediate Slice 0 plan and task list were condensed.
**Score**: 0 / 14
**Route**: PROCEED
**Choice made**: Restore the explicit 3-warmup/30-sample floor and derived p95/min/max/median/coefficient-of-variation checks in the existing runner. Keep unit tests fast through direct injected counts; add no telemetry, framework, or CI wall-clock gate.
**Status**: RESOLVED
