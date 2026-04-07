# Context Engineering Improvements for Forge

**Date**: 2026-04-06  
**Researcher**: Claude Code  
**Source**: Anthropic's "Effective context engineering for AI agents" principles

---

## Executive Summary

Forge implements a comprehensive 7-stage TDD-first workflow with excellent structural discipline (Beads issue tracking, worktree isolation, hard gates). However, its context engineering is **suboptimal** for AI agent cost and performance:

- **98.7KB of static prompts** (~24.7K tokens) loaded fresh per command execution
- **Zero prompt caching** — each stage pays full token cost
- **No context pruning** between stages — tool outputs accumulate indefinitely
- **Stage transitions rely on append-only Beads comments** instead of structured handoff artifacts
- **Prompts are not ordered for cache hits** (static first, dynamic last)

**Estimated opportunity**: 2,200-3,000 tokens saved per workflow execution if prompt caching and pruning implemented.

---

## 1. Current Context Consumption

### Prompt Sizes by Command

| Command | Lines | Bytes | Tokens |
|---------|-------|-------|--------|
| plan.md | 566 | 22,000 | 5,500 |
| rollback.md | 721 | 17,000 | 4,250 |
| review.md | 448 | 14,000 | 3,500 |
| dev.md | 345 | 12,000 | 3,000 |
| validate.md | 288 | 9,500 | 2,375 |
| verify.md | 269 | 8,600 | 2,150 |
| ship.md | 212 | 7,200 | 1,800 |
| premerge.md | 186 | 5,500 | 1,375 |
| status.md | 90 | 2,900 | 725 |
| **TOTAL** | **3,125** | **98,700** | **24,675** |

**Cost Impact**:
- Per-command baseline: ~2,700 tokens (average)
- Full 7-stage workflow: ~24.7K tokens (no caching, no pruning)
- With 90% cache hits: ~2,470 tokens (90% savings)
- **Cost difference per workflow**: ~2,200 tokens (5-10% of typical agent context)

---

## 2. Analysis: Static vs. Dynamic Ordering

### Current State: NOT OPTIMIZED FOR CACHING

**Problem**: Each command (plan.md, dev.md, validate.md, etc.) is a standalone markdown file loaded dynamically. There is:
- No shared system prompt containing static tool definitions
- No cached prefix across stages
- No distinction between static (always the same) and dynamic (varies per execution)

**Evidence**:
- All 9 command files are markdown stored in `.claude/commands/`
- AGENTS.md is reference documentation, not a cached system prompt
- No `.claude/system.md` or equivalent system-level prompt
- MCP configuration (Context7) is in `.mcp.json`, not integrated into cached system context

**Impact on Cache Hits**:
- First /plan execution: Full 5,500 tokens (not cached)
- Second /plan (same session): Full 5,500 tokens again (cache miss)
- Why: No **static prefix** established; Claude API doesn't know what to cache

---

## 3. Stage Transitions: Current Mechanism

### How Handoff Works Today

Stage transitions use: `bash scripts/beads-context.sh stage-transition <id> dev validate --summary "..." --decisions "..." --artifacts "..." --next "..."`

**What happens**:
1. Appends a comment to the Beads issue (append-only)
2. Comment format: `Stage: <from> complete → ready for <to>` + optional fields
3. Next stage reads Beads issue comments to understand prior work
4. Also reads external files: `docs/plans/YYYY-MM-DD-*-design.md`, `*-tasks.md`, `*-decisions.md`

**Weaknesses**:
- **No single source of truth** — data spread across Beads + 3 markdown files
- **Not pruned** — accumulates indefinitely in Beads history
- **Next stage must re-read all files** — context is not self-contained in handoff
- ~5-10 additional context reads per transition just to understand where we are

---

## 4. Context Pruning: Not Implemented

### Current Behavior

- **Tool results accumulate** — Every Bash, Grep, Read command output stays in message history
- **No removal at stage boundaries** — Validation test output from /dev remains when entering /validate
- **No message history editing** — No mechanism to delete old results between stages
- **No compaction mechanism** — Unlike OpenCode (which has `compaction.prune: true`), Forge has no pruning

### Example: /dev → /validate

/dev stage accumulates:
- 50+ Bash command outputs (file edits, commits, test runs)
- 20+ Grep search results (DRY checks, blast-radius searches)
- 10+ Read operations (context loading)

When entering /validate, ALL this remains unless manually cleared. By /ship, the conversation history could be 200-300KB of stale results.

---

## 5. Prompt Structure: Bloat & Monolithic Design

### Largest Offenders

**plan.md (566 lines, 22KB)**
- Covers 3 separate phases (Design Intent, Technical Research, Setup)
- Could be split: `plan-phase1.md`, `plan-phase2.md`, `plan-phase3.md`
- Currently ALL loaded even if user only needs Phase 1

**rollback.md (721 lines, 17KB)**
- Emergency recovery — rarely used
- Should not be in main workflow prompt cache
- Could be lazy-loaded only if /rollback is invoked

**review.md (448 lines, 14KB)**
- Covers GitHub feedback handling, OWASP review, SonarCloud integration
- Could extract GitHub-specific sections to external skill

---

## 6. Context Engineering Recommendations

### 6.1 Implement Prompt Caching (Static First)

**Action**: Reorganize prompts for maximum cache hits. Put shared workflow context in system prompt, not in commands.

**Estimated savings**: 1,500-2,000 tokens per workflow (12-15% reduction)

### 6.2 Structured Handoff Artifacts

**Action**: Create a `.claude/handoff/` directory. Each stage exit writes a **single JSON file** containing all context needed by the next stage.

**Benefit**: Self-contained handoff, no external file I/O, easier to parse, cache-friendly

### 6.3 Context Pruning at Stage Boundaries

**Action**: Implement a `--prune` flag for stage transitions.

Example: `bash scripts/beads-context.sh stage-transition <id> dev validate --prune-before dev`

**Estimated savings**: 50-100KB per boundary (3-5 stages = 150-500KB recovered)

### 6.4 Prompt Decomposition & Lazy Loading

**Action**: Break large commands into phases.

**Before**: `.claude/commands/plan.md` (566 lines, all phases)

**After**: 
- `.claude/commands/plan.md` (entry point, ~80 lines)
- `.claude/commands/plan-phase1-design.md` (Design Intent)
- `.claude/commands/plan-phase2-research.md` (Technical Research)
- `.claude/commands/plan-phase3-setup.md` (Setup + Task List)

**Benefit**: Only load the phase the user is in; saves 6-8KB per phase

### 6.5 Cache-Friendly Prompt Ordering

**Action**: Reorder command files to put **stable content first**, then dynamic content.

**Benefit**: Shared sections cached, command-specific variations reused

---

## 7. Implementation Roadmap (Priority Order)

| Priority | Change | Effort | Savings |
|----------|--------|--------|---------|
| **P0** | Structured handoff artifacts (.claude/handoff/) | 2-3h | 1,000 tokens/workflow |
| **P1** | Context pruning hook at stage boundaries | 2-3h | 500 tokens/workflow |
| **P2** | Prompt decomposition (plan phases) | 4-5h | 300 tokens/workflow |
| **P3** | Cache-friendly prompt ordering | 3-4h | 500 tokens/workflow |
| **P4** | System-level shared prompt cache | 4-5h | 1,000 tokens/workflow |

**Total potential savings**: 3,300 tokens per workflow (~13% overall context reduction)

---

## 8. Why Anthropic's Principles Apply to Forge

| Principle | Forge Status | Impact |
|-----------|-------------|--------|
| **Static first, dynamic last** | Not implemented | Commands are all static, but not cached |
| **Structured handoff artifacts** | Partial (Beads only) | Text comments unreliable; no structured format |
| **Context pruning** | Not implemented | Tool outputs accumulate indefinitely |
| **Tool result editing** | Not implemented | No removal of stale results between stages |
| **Cache hit optimization** | Not used | No breakpoints, no shared prefix |

**All 5 Anthropic strategies are applicable to Forge.** Implementing even 2-3 would yield measurable cost and latency improvements.

---

## Conclusion

Forge excels at **workflow structure** (Beads, worktrees, hard gates) but underutilizes **context efficiency** (caching, pruning, structured handoffs).

By implementing Anthropic's context engineering principles, Forge can:
- Reduce per-workflow token cost by 13-15%
- Improve stage transition reliability (structured artifacts)
- Enable faster multi-turn interactions (cache hits)
- Support larger, more complex projects (pruned context)

Recommended starting point: **Structured handoff artifacts (P0)** + **context pruning (P1)** in Week 1.
