# Design Doc: logic-level-dependency-detection

**Feature**: logic-level-dependency-detection
**Date**: 2026-03-18
**Status**: Phase 1 complete - design approved
**Branch**: codex/logic-level-dependency-detection
**Beads**: forge-9zv

---

## Purpose

`/plan` Phase 3 currently treats issue independence as a file-level question. That misses cases where planned logic changes alter behavior, contracts, or consumer expectations across issues even when the files do not overlap directly.

This feature upgrades `/plan` Phase 3 so it can assess whether a planned change will affect other open issues through:
- import/call-chain dependencies
- type/contract dependencies
- behavioral or rule-change dependencies

The goal is to make planning-time dependency decisions accurate enough that `/dev` can proceed with less human intervention, while still keeping the user in control of any Beads dependency mutations.

---

## Success Criteria

1. `/plan` Phase 3 performs logic-level dependency analysis for all three required categories: import/call-chain, type/contract, and behavioral/rule-change dependencies.
2. The analysis uses weighted rubric scoring rather than a binary heuristic and proposes dependency changes when a likely loss of issue independence is detected.
3. When detector outputs conflict, the system pauses for user input and presents the rubric result, tradeoffs, and proposed next steps.
4. When confidence falls below the 70% success threshold, the system escalates to the user before finalizing the plan.
5. When behavioral analysis is uncertain, the system still proposes the dependency update and waits for user approval.
6. Beads is the canonical machine-readable record for the dependency decision; plan docs contain only a concise human-readable summary.
7. On approval, the workflow can safely apply dependency updates via Beads, validate for cycles, and show the resulting execution-order graph.
8. The planning output improves downstream Beads signals, especially `bd ready`, by reducing false independence.
9. The feature uses Beads more effectively through JSON-first reads, `bd worktree create`, `bd dep`, `bd dep cycles`, `bd graph`, `bd ready`, `bd set-state` / `bd state`, and `bd comments`.
10. All existing tests pass after implementation.

---

## Out of Scope

1. Building the full multi-developer workflow from `forge-puh`.
2. Introducing `bd gate` as a required workflow primitive in this first version.
3. Auto-applying dependency updates without user approval.
4. Rewriting Beads internals or depending on unsupported CLI commands not present in the local installation.
5. Perfect semantic understanding of all behavioral changes; this version should surface strong planning signals, not guarantee theorem-level correctness.

---

## Approach Selected: Hybrid `dep-guard` Wrapper + Node Logic Analyzer

### Why this approach

The existing `dep-guard.sh` entry point is already wired into the planning workflow and already handles Beads-oriented setup tasks such as contract extraction and note storage. However, shell is the wrong place to implement reliable logic-level dependency analysis across imports, contracts, and behavioral changes.

The selected approach keeps the existing shell entry point for orchestration, but delegates the heavy analysis to a Node-based analyzer that can:
- read task-list intent in structured form
- inspect repository files and imports more reliably
- produce weighted rubric scores across the three dependency categories
- return structured results that the shell wrapper can present to the user and persist into Beads

### High-level flow

1. `/plan` Phase 3 creates the task list as usual.
2. `dep-guard.sh` extracts contracts and calls a Node analyzer with:
   - current issue metadata
   - task-list-derived contracts
   - other open issue metadata from Beads JSON
   - repository context needed for import/call-chain and contract matching
3. The analyzer scores dependency risk across:
   - import/call-chain coupling
   - type/contract coupling
   - behavioral/rule-change coupling
4. The wrapper renders:
   - detected issue pairs
   - rubric score and confidence
   - proposed dependency updates
   - pros and cons for each option
5. The user approves or rejects the proposed dependency mutations.
6. On approval, the workflow:
   - applies `bd dep add`
   - runs `bd dep cycles`
   - shows `bd graph`
   - updates decision status with `bd set-state`
   - records rationale with `bd comments`
   - re-checks `bd ready`

### Beads integration model

**Canonical record in Beads**
- Structured planning outcome lives in Beads, not duplicated in full inside docs.
- Current decision status is represented through Beads state labels.
- Human approval rationale is recorded through Beads comments.
- Approved dependency edges are represented through Beads dependency links.

**Concise summary in docs**
- The design doc and task list include a short summary of the approved dependency decision and point back to the Beads issue.
- Docs do not duplicate the full machine-readable analysis payload.

### Beads commands to adopt in this feature

- `bd worktree create` for worktree creation in a shared Beads-aware workflow
- `bd show --json`, `bd list --json`, and other JSON-first reads
- `bd dep add` for approved dependency updates
- `bd dep cycles` to prevent cycle-creating mutations
- `bd graph` to show the resulting dependency ordering
- `bd ready` to surface the impact on issue independence
- `bd set-state` / `bd state` for queryable workflow status
- `bd comments` for human-approved rationale and decision audit trail

`bd gate` is intentionally deferred. It may be useful later, but it would expand this feature from planning intelligence into workflow orchestration, which belongs more naturally in `forge-puh`.

---

## Constraints

1. The first shipped version must support all three detector types, not just one or two.
2. Dependency mutations remain user-approved; the system only proposes changes until approval is granted.
3. Any detector conflict must be surfaced to the user rather than silently flattened into a single answer.
4. If confidence is below the 70% threshold, the plan must pause for user input.
5. The feature should improve planning quality without bloating `/dev` with extra decision gates that should have been resolved earlier.
6. The implementation must use only Beads capabilities that exist in the local installed CLI.
7. The canonical decision record must avoid duplication and drift between Beads and docs.

---

## Edge Cases

1. **Cycle risk**: proposed dependency updates would create a Beads dependency cycle.
   Decision: run `bd dep cycles` before finalizing approved mutations and escalate to the user if a cycle is detected.

2. **Detector disagreement**: import/call-chain, type/contract, and behavioral detectors produce materially different results.
   Decision: use weighted rubric scoring, but stop and ask the user before deciding the final action.

3. **Behavioral change without explicit function names**: the task list describes a rule or output behavior change without naming concrete symbols.
   Decision: behavioral analysis must still score the risk and may propose a dependency even when symbol-level evidence is incomplete.

4. **Same developer owns both issues**: the overlap still matters even without cross-person coordination.
   Decision: still surface the dependency proposal and ask for approval; same-owner status lowers surprise, not impact.

5. **Weak direct signal, weak confidence**: no single detector finds a strong dependency, but the combined rubric falls below the 70% confidence threshold.
   Decision: escalate to the user and require approval before continuing.

6. **Uncertain behavioral dependency**: behavioral analysis is suggestive but not provable from code alone.
   Decision: propose the dependency update and ask for approval.

---

## Ambiguity Policy

If `/dev` encounters a spec gap that affects dependency safety or drops confidence below the 70% success threshold, pause and ask the user.

If the gap does not affect dependency safety, use weighted rubric scoring. Proceed only when the result still meets or exceeds the 70% threshold, and document the choice in the decisions log.

---
