# Design Doc: pre-change-dep-guard

**Feature**: pre-change-dep-guard
**Date**: 2026-03-16
**Status**: Phase 1 complete — design approved
**Branch**: feat/pre-change-dep-guard
**Beads**: forge-mze (open)

---

## Purpose

When multiple issues are in-flight, a logic change in one can silently break or force rework in another — even if they touch completely different files. Today there is no mechanism to detect this. Developers discover conflicts only at merge time or during review, causing rework and wasted effort.

This feature adds **contract-aware ripple analysis** at two trigger points:
1. **Issue creation** (`bd create`) — analyze where the new issue fits in the workflow, surface dependencies that should exist
2. **`/plan` Phase 1** — before design work, cross-check the feature's scope against all open/in-progress issues

**Who benefits**: Any developer (human or AI agent) starting work on a feature that may conflict with in-flight work.

---

## Success Criteria

1. When `bd create` is run, a Ripple Analyst agent automatically evaluates the new issue against all open/in-progress issues and reports: no conflict, low ripple, high ripple, or critical ripple
2. When `/plan` Phase 1 runs, a dep guard check queries Beads for open/in-progress issues and surfaces overlaps (file-level and logic-level)
3. `scripts/dep-guard.sh` exists with subcommands: `extract-contracts`, `find-consumers`, `check-ripple`, `store-contracts`
4. Contract metadata (affected functions/interfaces/CLI subcommands) is stored on Beads issues via `--append-notes` after `/plan` Phase 3
5. The Ripple Analyst agent receives contract changes + consumer code and returns a structured verdict: impact level (NONE/LOW/HIGH/CRITICAL), break scenarios, and recommended action
6. When uncertain, the agent defaults to HIGH (conservative)
7. HIGH/CRITICAL ripple shows actionable options: add dependency, coordinate, scope down, or override
8. All existing tests pass after changes
9. Command sync (`scripts/sync-commands.js`) still works

---

## Out of Scope

1. **Modifying Beads itself** — we consume existing `bd` commands, not change the tool
2. **Hard-blocking on any ripple level** — all warnings are advisory; dev always has override option
3. **Retroactively analyzing closed issues** — only open/in_progress issues are checked
4. **Pre-commit hook integration** — deferred to future iteration (v3)
5. **Automatic dependency creation** — the system recommends dependencies, dev confirms

---

## Approach Selected: Structured Script + LLM Hybrid (Progressive Rollout)

### Why this approach

- **Script** handles deterministic work: grep for consumers, query Beads metadata, store contracts
- **LLM agent** handles judgment: given a contract change and consumer code, how much rework is needed?
- **Progressive rollout**: v1 works from issue descriptions alone (no task list needed), v2 adds precision from task list contracts

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Trigger Points                                         │
│                                                         │
│  bd create ──→ dep-guard.sh check-ripple ──→ Report     │
│  /plan P1  ──→ dep-guard.sh check-ripple ──→ Report     │
│  /plan P3  ──→ dep-guard.sh extract-contracts ──→ Store │
└─────────────────────────────────────────────────────────┘
                        │
            ┌───────────┴───────────┐
            │                       │
     ┌──────▼──────┐       ┌───────▼───────┐
     │ Mechanical   │       │ LLM Judgment  │
     │ (dep-guard)  │       │ (Ripple Agent)│
     │              │       │               │
     │ • grep       │       │ • Break       │
     │   consumers  │       │   scenarios   │
     │ • query      │  ──→  │ • Impact      │
     │   Beads      │       │   sizing      │
     │ • store      │       │ • Recommended │
     │   metadata   │       │   action      │
     └──────────────┘       └───────────────┘
```

### Three layers of analysis

**Layer 1 — Contract extraction** (after /plan Phase 3)
Parse the task list's `File(s):` and `What to implement:` fields. Extract:
- Function/method names being added, modified, or removed
- CLI subcommands being changed
- Data format changes (output schemas, return types)
- Store as `contracts: file:function(change-type)` on the Beads issue

**Layer 2 — Consumer discovery** (grep-based, deterministic)
For each modified contract, grep the codebase for all callers/importers.
Output: `{contract, consumerFile, line, usagePattern}`

**Layer 3 — Ripple impact analysis** (LLM Ripple Analyst agent)
Feed the agent:
- The contract change description
- The consumer code snippets
- The open/in-progress issues that touch those consumers
Ask: "Imagine concrete break scenarios. How much rework does each consumer need?"

### Ripple levels and actions

| Level | Criteria | Action |
|-------|----------|--------|
| **NONE** | No open issue touches any consumer | ✅ Proceed freely |
| **LOW** | Consumers need trivial adjustment (add param, rename) | ✅ Proceed, note for downstream PR |
| **HIGH** | Consumer needs significant rework (parsing, data handling) OR agent is uncertain | ⚠️ Advisory: "Consider doing foundational work first" |
| **CRITICAL** | Consumer is in an active in_progress issue's task list | 🛑 Strong advisory: "forge-X is actively building on this. Recommend resolving order." |

### Progressive rollout

**v1 (this PR):**
- `dep-guard.sh` with `check-ripple` and `find-consumers` subcommands
- Ripple Analyst agent prompt (runs as subagent)
- Integration into `/plan` Phase 1
- Integration into issue creation workflow (hook or manual `dep-guard.sh check-ripple <id>`)
- Grep-based consumer discovery
- LLM judges impact from issue description + consumer code

**v2 (future PR):**
- `extract-contracts` subcommand: parse task list for precise contract changes
- `store-contracts` subcommand: persist contract metadata on Beads issues
- Precision matching: exact contract → consumer mapping instead of keyword grep

---

## Constraints

1. **Always advisory, never hard-blocking** — dev can always override with explicit choice
2. **Default to HIGH when uncertain** — conservative over permissive
3. **No Beads tool modifications** — use existing `bd` commands only
4. **Single script entry point** — `scripts/dep-guard.sh` (consistent with existing scripts/)
5. **Agent-agnostic** — works for any AI agent, not just Claude Code
6. **Must not slow down `/plan`** — ripple check should complete in <30 seconds

---

## Edge Cases

1. **No open issues** — skip ripple check, report "no conflicts detected"
2. **Issue predates this feature (no contract metadata)** — fall back to title/description keyword matching, label as "low confidence"
3. **LLM uncertain about impact** — default to HIGH, tag as "uncertain — manual review recommended"
4. **Circular dependencies detected** — surface clearly: "A depends on B depends on A — manual resolution needed"
5. **Same developer owns both conflicting issues** — still warn (they may not remember the conflict across sessions)
6. **Consumer is in a closed issue** — ignore, only check open/in_progress

---

## Ambiguity Policy

If a spec gap is found mid-dev: **default to HIGH (conservative)**, document the gap in the decisions log, and continue. Do not pause for input unless the gap affects the ripple check's core logic (false negatives that could miss real conflicts).

---

## OWASP Top 10 Analysis

| Category | Applies? | Mitigation |
|----------|----------|------------|
| A03: Injection | Yes — script takes issue IDs and file paths as input | `dep-guard.sh` sanitizes all input (same pattern as `beads-context.sh`) |
| A01: Broken Access Control | No — local tool, no auth boundary | N/A |
| A02: Crypto Failures | No — no secrets handled | N/A |
| A04: Insecure Design | Low — advisory system, no destructive actions | Defaults to conservative (HIGH) |
| A05-A10 | No | N/A |

---

## Technical Research

### DRY Check

Searched the entire codebase for: `dep-guard`, `dep_guard`, `depguard`, `conflict detect`, `ripple`, `impact analysis`, `check-ripple`, `find-consumers`, `extract-contracts`, `store-contracts`, `affected-files`. **No matches found.** All dep-guard code will be built from scratch.

### Template: `scripts/beads-context.sh`

The existing beads-context.sh (292 lines) provides the exact structural pattern:
- **Input sanitization** (lines 40-54): removes `"`, `$()`, backticks, semicolons, newlines via `printf '%s' | sed`
- **Bd wrapper functions** (lines 56-98): `bd_update()` checks both exit code AND stdout for errors (bd exits 0 even for non-existent issues)
- **JSON querying** (line 190): `bd show <id> --json` with jq fallback to grep/sed
- **Subcommand dispatcher** (lines 273-291): case statement routing to `cmd_*` functions
- **Metadata storage**: `bd update <id> --append-notes` for structured data

`dep-guard.sh` will replicate this pattern exactly.

### Integration Points (exact locations)

| Where | File | Lines | What to add |
|-------|------|-------|-------------|
| `/plan` Phase 1 | `.claude/commands/plan.md` | 58-77 | Ripple check between Q&A start and design doc write |
| `/plan` Phase 3 | `.claude/commands/plan.md` | 310-314 | `extract-contracts` + `store-contracts` after task list saved |
| `/plan` Phase 3 HARD-GATE | `.claude/commands/plan.md` | 324-335 | Add exit condition: dep-guard exit code 0 |
| `/dev` pre-flight (optional) | `.claude/commands/dev.md` | 54-62 | Advisory ripple check, non-blocking |

### Consumer Discovery Pattern

No existing cross-reference infrastructure. Will implement via grep:
```bash
grep -rn "$function_name" --include="*.js" --include="*.sh" --include="*.md" lib/ scripts/ .claude/ bin/
```

This covers: JS imports/requires, bash function calls, command references in markdown.

### Related Open Issues

- `forge-9zv` (P2): "Logic-level dependency detection in /plan Phase 3" — overlaps with v2 contract extraction. Could be merged or sequenced.
- `forge-puh` (P2): "Multi-developer workflow" — blocked by forge-mze. Will consume dep-guard output for merge ordering and conflict zone detection.

### TDD Test Scenarios

**Scenario 1 — Happy path: No conflicts detected**
- Input: New issue "add logging to bin/forge.js". No open issues touch bin/forge.js.
- Expected: `check-ripple` returns NONE, no warnings displayed.
- Test: Mock `bd list` with 3 open issues (none touching forge.js), run check-ripple, assert exit 0 + "no conflicts" output.

**Scenario 2 — HIGH ripple: Logic change affects consumer in another issue**
- Input: Issue A changes `parse-progress` output format in beads-context.sh. Issue B (in_progress) calls `parse-progress` in status.js and parses its output with regex.
- Expected: `find-consumers` returns status.js:34. Ripple Analyst agent returns HIGH with break scenario: "regex parsing will fail on new output format."
- Test: Mock task list with parse-progress change, mock grep results showing status.js consumer, assert HIGH level + actionable options in output.

**Scenario 3 — Edge case: Issue predates dep-guard (no contract metadata)**
- Input: Old issue forge-3na has no `contracts:` in notes. New issue touches payment area.
- Expected: Falls back to keyword matching on title/description. Labels result as "low confidence."
- Test: Mock `bd show forge-3na --json` with empty notes, run check-ripple, assert "low confidence" label in output.

**Scenario 4 — CRITICAL ripple: Active in_progress issue builds on changed contract**
- Input: Issue A modifies `bd_update()` in beads-context.sh. Issue B (in_progress) has task list that adds new subcommand using `bd_update()`.
- Expected: CRITICAL level. "forge-B is actively building on bd_update(). Recommend resolving merge order."
- Test: Mock both issues with overlapping contracts, assert CRITICAL + merge order recommendation.

**Scenario 5 — Error path: Invalid issue ID**
- Input: `dep-guard.sh check-ripple nonexistent-id`
- Expected: Exit code 1, error message "Issue not found: nonexistent-id"
- Test: Run with bad ID, assert exit 1 + error message.
