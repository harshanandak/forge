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

## OWASP Top 10 Analysis

| Category | Applies? | Mitigation |
|----------|----------|------------|
| A03: Injection | Yes | Keep shell orchestration sanitized, prefer `bd ... --json` over human-output parsing, and pass file paths / issue IDs as structured args |
| A04: Insecure Design | Yes | No automatic dependency mutation without user approval; detector conflicts and sub-70% confidence escalate to the user |
| A05: Security Misconfiguration | Low | Use only Beads commands available in the installed CLI, avoid assuming doc-only features such as `bd pin` when absent locally |
| A08: Software and Data Integrity Failures | Yes | Validate dependency updates with `bd dep cycles`, keep Beads as canonical state, and record human-approved rationale in comments |
| A09: Security Logging and Monitoring Failures | Low | Record state transitions and user-approved rationale in Beads comments / state for auditability |
| A01, A02, A06, A07, A10 | No material feature-specific risk | N/A |

---

## Technical Research

### DRY Check

I searched the checked-out codebase for the planned analyzer terms and existing integration points.

No existing implementation was found for:
- logic-level dependency analysis
- import/call-chain dependency scoring
- behavioral dependency scoring
- rubric-based dependency proposals
- `bd worktree create` integration
- `bd set-state` integration in the current workflow docs

Relevant existing code to extend was found in:
- `scripts/dep-guard.sh:184` - `cmd_check_ripple()` is the current keyword-only detector
- `scripts/dep-guard.sh:358` - `cmd_store_contracts()` already persists contract metadata
- `scripts/dep-guard.sh:389` - `cmd_extract_contracts()` already derives contract hints from task lists
- `scripts/beads-context.sh:56` - `bd_update()` wrapper pattern for safe Beads writes
- `scripts/beads-context.sh:79` - `bd_comment()` wrapper pattern for safe comment writes
- `.claude/commands/plan.md:374` - current Phase 3 contract extraction and re-check step
- `.claude/commands/plan.md:386` - current Phase 3 note that the re-check is still keyword-only in v1

Conclusion: the correct implementation is to extend the existing `dep-guard` and Beads integration path rather than create a second planning-analysis pipeline.

### Codebase Exploration

The repo currently has:
- a shell-based dependency guard entry point in `scripts/dep-guard.sh`
- shell-based Beads context helpers in `scripts/beads-context.sh`
- workflow docs that mention contract extraction/storage but do not yet implement logic-level Phase 3 dependency decisions
- no dedicated AST parser dependency in `package.json`

This means the import/call-chain and contract analysis layer will need either:
- a new parser dependency, or
- brittle regex-only parsing

Regex-only parsing is not sufficient for the day-one scope because the first version must support all three detector types and must be robust enough to drive Beads dependency proposals.

### Parser / Analysis Options

**Option A - `@babel/parser`**
- Official docs confirm support for `sourceType: "commonjs"` and `sourceType: "unambiguous"`.
- Official docs also confirm `errorRecovery`, which is useful when scanning a mixed repository during planning.
- This is a good fit because the repo includes both CommonJS (`require`) and some ESM-style `import` usage.

**Option B - Acorn**
- Official docs describe Acorn as a small, fast JavaScript parser and note companion packages `acorn-loose` and `acorn-walk`.
- This is appealing for minimal footprint, but mixed module handling and error recovery would require more assembly work.

**Selected research outcome**
- Use `@babel/parser` for the Node analyzer.
- Reason: the repo mixes CommonJS and ESM, and the parser's `unambiguous` / `commonjs` modes plus `errorRecovery` reduce analysis brittleness.
- Inference from sources: this is the best balance of resilience and implementation effort for the current codebase.

### Broader External Tooling Research

I expanded the research beyond parsers into dependency-analysis tooling and known integration issues.

**`dependency-cruiser`**
- Official README positions it as a validator and visualizer for JavaScript, TypeScript, CoffeeScript, ES6, CommonJS, and AMD.
- It can emit multiple formats including `dot`, `json`, `csv`, `html`, and text.
- It supports rule-based validation, including built-in starter rules for circular dependencies, missing dependencies, and orphans.
- This makes it strong for module/file dependency graphing and policy checks.

Tradeoffs:
- Best at module dependency graphs, not behavioral reasoning.
- More useful as a graph/rules engine than as the full Phase 3 decision system.
- Configuration is another moving part to maintain for a relatively small repo if we only need a narrow slice of its capability.

**`madge`**
- Official README positions it as a graph tool for CommonJS, AMD, and ES6 module dependencies.
- It can show circular dependencies, dependents, orphans, leaves, and emit JSON / DOT / SVG.
- It explicitly documents mixed-import caveats and the need for extra configuration when a project mixes JS/TS or import styles.
- It also documents cases where files can be skipped because of resolution or parse errors, with `--warning` / `--debug` recommended to diagnose missing dependencies.

Tradeoffs:
- Useful for graph generation and circular checks.
- More limited than `dependency-cruiser` for rule-based validation.
- Its own FAQ documents resolution and mixed-syntax caveats, which is a risk for this repo because it mixes CommonJS and ESM-style imports.

**`ts-morph`**
- Official docs show strong support for import inspection and call-expression traversal.
- It would be powerful if the repo were TypeScript-heavy or if type-aware analysis were the dominant requirement.

Tradeoffs:
- This repo is primarily JavaScript, not TypeScript-first.
- Using `ts-morph` would pull in compiler-project complexity that is likely heavier than needed for the first version.

### Selected Broader Research Outcome

The most practical solution remains a custom Node analyzer using `@babel/parser`, with the option to borrow ideas from graph tools rather than adopting them wholesale.

Reasoning:
- We need three detector classes, and only one of them is really a module graph problem.
- File/module graph tools help with import/call-chain evidence, but not enough for contract and behavioral scoring on their own.
- `@babel/parser` gives us direct control over mixed CommonJS/ESM parsing and error recovery.
- If we later need richer graph export or rule validation, `dependency-cruiser` is the stronger follow-on candidate than `madge`.

### Known Failure Modes and Mitigations

Based on official tool docs and the current repo shape, the likely external-tool failure modes are:

1. **Mixed module syntax**
   - Babel docs warn that `unambiguous` can produce false matches because valid modules can omit `import` / `export`.
   - Mitigation: prefer explicit `commonjs` or `module` mode when file type or package context is known, and use `unambiguous` only as a fallback.

2. **Skipped or unresolved files in graph tooling**
   - Madge docs note that files may be skipped due to resolution or parsing errors and recommend `--warning` / `--debug`.
   - Mitigation: keep the first implementation's graphing logic local and deterministic, using repo-specific path resolution instead of outsourcing the full analysis to a generic graph CLI.

3. **Type-only and async import noise**
   - Madge docs explicitly call out configuration needed to skip type imports and async imports.
   - Mitigation: separate type/contract scoring from import/call-chain scoring rather than blending them into one generic dependency pass.

4. **Rule-engine overhead**
   - Dependency-cruiser offers powerful rule config, but that introduces another config surface that may be unnecessary for the first shipped version.
   - Mitigation: keep rubric rules in code first, then consider external rule configuration only if the policy surface becomes large.

### Beads Research

External Beads docs and the local installed CLI show an important distinction:
- the Beads documentation describes a broader multi-agent feature surface
- the local installed CLI is the real compatibility boundary for this repo

Key findings:
- The local CLI supports `dep`, `graph`, `ready`, `comments`, `state`, `gate`, `prime`, `stale`, and `worktree`
- The local CLI explicitly supports `bd worktree create`, which is more appropriate than raw `git worktree add` for Beads-aware parallel work because it keeps worktrees on the shared Beads database
- The local CLI does not expose some commands referenced in broader docs, such as `bd pin`, so this feature must not assume them

Implication:
- `forge-9zv` should use the real installed Beads surface aggressively, but only where it exists locally
- the best immediate additions are `bd worktree create`, JSON-first reads, `bd dep add`, `bd dep cycles`, `bd graph`, `bd ready`, `bd set-state` / `bd state`, and `bd comments`
- `bd gate` is still deferred because it is more orchestration-heavy and fits better in `forge-puh`

### Blast Radius

This feature does not remove or rename an existing public tool or dependency, so the formal remove/rename blast-radius search is not required.

The direct change surface is still clear:
- `scripts/dep-guard.sh`
- likely a new Node analyzer under `lib/` or `scripts/`
- Beads-aware workflow docs in `.claude/commands/plan.md`
- tests covering dep-guard and Phase 3 planning behavior

### TDD Test Scenarios

**Scenario 1 - Happy path: clear import/call-chain dependency**
- Input: Phase 3 task list changes a shared helper used by another open issue's task list.
- Expected: analyzer scores import/call-chain risk above threshold, proposes a dependency, and shows pros/cons before mutation.

**Scenario 2 - Contract dependency with cycle prevention**
- Input: approved dependency proposal would create a cycle.
- Expected: `bd dep cycles` catches the cycle, mutation is not finalized, and the user is asked to choose an alternative path.

**Scenario 3 - Behavioral dependency without explicit symbols**
- Input: task list describes a rule/output change but does not name a function.
- Expected: behavioral detector still scores the issue pair, proposes a dependency if warranted, and asks for approval.

**Scenario 4 - Detector disagreement**
- Input: import/call-chain detector is LOW, type/contract detector is HIGH, behavioral detector is uncertain.
- Expected: weighted rubric is shown, conflict is surfaced, and the user is asked to decide before Phase 3 completes.

**Scenario 5 - No dependency impact**
- Input: analyzer finds no strong coupling and confidence remains at or above the threshold.
- Expected: no dependency mutation is proposed, Beads state is updated accordingly, and `bd ready` still shows the issue as independent.

### Sources

- Beads docs: https://steveyegge.github.io/beads/
- Beads multi-agent docs: https://steveyegge.github.io/beads/multi-agent
- Babel parser docs: https://babeljs.io/docs/babel-parser
- Acorn repository README: https://github.com/acornjs/acorn

---
