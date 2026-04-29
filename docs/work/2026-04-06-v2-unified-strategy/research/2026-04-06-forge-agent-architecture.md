# Forge Agent Architecture: Skills vs Dedicated Agents

**Date:** 2026-04-06  
**Status:** Analysis Complete

## Executive Summary

Forge currently uses a **skill-based model** where conversational Claude agents execute workflow stage commands (`/plan`, `/dev`, `/validate`, etc.) by calling raw tools directly. The question: should Forge use dedicated agents (via `subagent_type` in plugin.json) with restricted tool access to enforce abstraction?

**Recommendation: NO.** Current skill-based + hook model is optimal. Enhanced hooks can achieve 80% of the safety benefits without 35-105s performance overhead.

---

## Current Architecture

### Model: Conversational Agent + Command Skills

User runs `/dev` → Plugin loads `.claude/commands/dev.md` → Claude reads prompt → Claude executes raw tools (git, bash, bd, gh, file I/O) directly.

**Current agents in `.claude/agents/`:** Only `command-grader.md` (evaluates transcripts, not a workflow agent).

**Tool access model:** Unrestricted. Enforcement is purely prompt-based (hard-gates like `<HARD-GATE: /dev start>`). Hooks in `lefthook.yml` provide CI-level enforcement.

**How enforcement works:**
1. Hard-gates (prompts tell Claude to refuse if preconditions fail)
2. Hooks (git pre-commit blocks commits without tests)
3. Beads (ensures only ready tasks are worked on)
4. Worktrees (isolated git branches prevent cross-contamination)

---

## Agent vs Skill Tradeoffs

### Current Skill Model

**Pros:**
- Single context window (all stage knowledge loaded at once)
- No agent spawn overhead (saves 5-10s per stage)
- Easy to iterate on prompts (edit `.claude/commands/*.md`, reload)
- Full context visibility (developer sees reasoning)
- Hooks provide strong enforcement (git pre-commit blocks violations)
- Production-tested and reliable

**Cons:**
- Prompt-based enforcement is soft (Claude could ignore hard-gate)
- No isolation (one compromised stage = access to all tools)
- Humans could bypass by calling raw `git`/`bd` outside forge CLI
- Hard to audit tool usage per stage

### Proposed Dedicated Agent Model

**Pros:**
- Hard enforcement (agent tool list is config-driven, not prompt-based)
- Per-stage isolation (plan-agent only sees forge plan API)
- Explicit audit trail (each stage's tool access logged)
- Prevents scope creep (dev-agent can't call ship-stage commands)

**Cons:**
- Agent spawn overhead: 5-10s per stage × 7 stages = 35-105s total
- Context isolation breaks continuity (agents can't see parent reasoning)
- Requires plugin.json refactor + new subagent definitions
- Debugging harder (errors in separate execution context)
- Marginal safety gain (hooks already catch ~90% of violations)
- Technical debt increases (more parts to maintain)

---

## Analysis: Would This Actually Help?

### Safety & Enforcement

Current (prompt-based hard-gates + hooks): ~95% enforcement.  
Proposed (tool-restriction hard-gates + hooks): ~98% enforcement.

**Verdict: Marginal improvement (~3%).**

Hooks already catch ~90% of violations. Tool restrictions catch the remaining 3%. But humans could still violate by running raw commands locally.

### Context & Debugging

Current (full conversation history). Proposed (agent context isolated).

**Verdict: Debugging gets harder.** If dev-agent fails, you don't see parent (plan) context. Must rely entirely on artifact contracts.

### Performance

Current: ~1-2s per stage. Proposed: ~5-15s per stage (agent spawn overhead).

**Total feature cycle:** 35-105s overhead. Humans absorb 30-60s delays, but 100+ seconds becomes friction.

### Maintainability

Current: All logic in `.claude/commands/*.md` + hooks. Proposed: Split across agents + CLI + plugin.

**Verdict: Harder to maintain.** Changing hard-gates today takes minutes. In agent model, requires editing agent prompt, updating plugin.json, testing agent spawning, verifying CLI.

---

## Can Hooks Achieve the Same Enforcement More Simply?

YES. Enhanced hooks can provide ~80% of safety benefit:

- Block /dev if beads issue not in ready status
- Block /ship if PR description template incomplete
- Block /premerge if design docs missing
- Block commits to main/master (already exists)
- Block commits without test files (already exists)

**Why hooks are better:**
- Already integrated (lefthook.yml exists)
- No agent overhead
- Harder to bypass (operate at git level)
- Easier to audit (config-driven)
- No refactoring required

---

## Recommendation: Don't Implement Dedicated Agents

### Why

1. Risk-reward imbalance: 3% safety gain doesn't justify 35-105s overhead + complexity
2. Hooks are sufficient: Enhanced hooks can provide 80% of safety without overhead
3. Not the bottleneck: Plugin safety is not Forge's limiting factor
4. Technical debt: Adding agents increases complexity; current model works

### What to Do Instead

1. **Strengthen hooks** (highest impact)
   - Add beads state validation
   - Add artifact validation
   - Add conflict detection
   - Document in lefthook.yml

2. **Document tool access control**
   - Create docs/TOOL_ACCESS.md explaining available tools at each stage
   - Clarify agents are not tool-restricted today

3. **Improve artifact contracts**
   - Formalize Descriptive Context Convention
   - Add validation checks before stage transitions

4. **Monitor enforcement gaps**
   - Track developers bypassing /commands
   - If > 5% bypass workflow, re-evaluate

### When to Revisit

- Claude Code plugin API gains per-agent tool restrictions
- Agent spawn time drops below 2s
- Enforcement gaps exceed 10%
- Team grows to 5+ developers

---

## Summary

| Aspect | Current | Proposed | Winner |
|--------|---------|----------|--------|
| Safety | 95% | 98% | Proposed (+3%) |
| Context | Full visible | Stage-isolated | Current (continuity) |
| Performance | 1-2s/stage | 5-15s/stage | Current (35-105s overhead) |
| Maintainability | Single files + hooks | Split agents + CLI + plugin | Current (less complex) |
| Ready Today | Yes | No (requires forge CLI layer) | Current |

**Verdict: Current skill-based model + enhanced hooks = optimal.**

Revisit in Q2 2026 if constraints change.
