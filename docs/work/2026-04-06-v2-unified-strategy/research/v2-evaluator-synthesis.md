# Forge v2 Strategy: Convergent Evaluator Synthesis

**Date**: 2026-04-07
**Sources**: 4 separate-context evaluator agents (Anthropic GAN-inspired pattern applied to the strategy itself)

---

## Overall Verdict

**The v2 plan is architecturally sound but operationally and strategically broken.**

| Evaluator | Score | Verdict |
|-----------|:-----:|---------|
| Strategy plan evaluator | **C (0.80/2.00 = 40%)** | "Defensible but should not ship as-is" |
| External value evaluator | **3/10 external value** | "Internal tool dressed up as a product" |
| Beads vs forge-issues | **WS3 is 5-10x over-scoped** | "Build the cloud-agent adapter as a 1-week addition. Keep beads. Skip the rewrite." |
| Cross-stage impact | **WS3 = deepest root, WS2 = deepest sink** | "Workstream ordering wrong; serialization risk in cluster B" |

**All 4 evaluators converge on the same root cause: scope discipline failure.**

---

## Convergent Critiques

### 1. The plan does not apply Anthropic's "stop doing" principle to itself

| Evaluator | Quote |
|-----------|-------|
| Strategy | "v2 ADDS 7 new systems despite invoking the principle. What is v2 *removing* besides Dolt and `/research`?" |
| Value | "Cargo-culting Anthropic's internal patterns. Anthropic's internal tools work because Anthropic engineers built them for themselves." |
| Beads | "WS3 is 5-10x the effort of the smallest fix that addresses the same pain." |

### 2. Timeline is 2-3x too optimistic

| Evaluator | Finding |
|-----------|---------|
| Strategy | "20 weeks is misleading. Realistic: 30-40 weeks for one engineer or specify a 3-4 person team." |
| Value | "6+ FTE of ongoing work for a single-maintainer OSS project." |
| Beads | "WS3 alone: 8-12 weeks realistic, 17-22 weeks for parity. The plan budgets 4-5 weeks." |

### 3. Workstream ordering is wrong

| Should ship before | Currently ships after | Why |
|--------------------|---------------------|-----|
| WS13 (guardrails) | WS2 (commands→agents) | Migration is unverified for 8 weeks |
| WS11 (tech-stack skills) | WS5 (evaluator) | Evaluator grades with stale rules for 6 weeks |
| WS4 (handoff schema freeze) | WS8/WS13 (consumers) | Schema drift breaks downstream |

### 4. Re-implementing what already exists

| Evaluator | Finding |
|-----------|---------|
| Value | "Re-implementing what Claude Code added in 2025-2026 — skills, agents, plan mode, code review natively." |
| Strategy | "WS13 guardrails could obviate WS5 evaluator for many cases. Overlap not analyzed." |
| Beads | "WS3 inherits the same WSL/Windows binary problem it claims to fix via better-sqlite3." |

### 5. Hidden user assumption

| Evaluator | Finding |
|-----------|---------|
| Strategy | "65% professional devs asserted without evidence — no user research cited." |
| Value | "The persona is imagined. Real personas: solo dev opens Cursor, types prompt, ships. Forge ceremony is repulsive." |

---

## The WS3 Bombshell

The beads evaluator makes the most concrete, actionable finding of any of them:

**Original WS3 plan**: Build forge-issues MCP server from scratch (4-5 weeks claimed, 8-22 weeks realistic).

**Reality**:
- Beads has **50+ subcommands**. WS3 acknowledges only ~10.
- Replacing beads loses: `bd history`, `bd diff`, `bd restore`, `bd memories`, `bd gates`, `bd kv`, `bd swarm`, `bd refile`, `bd lint`, `bd defer`, `bd supersede`, `bd stale`, `bd orphans`, `bd preflight`, `bd find-duplicates`, `bd federation`.
- Breaks 14+ installed `beads:*` skills in user environments.
- Forge code already wired to `bd` in 8+ files (beads-context.sh, dep-guard.sh, forge-team scripts, github-beads-sync, beads-health-check.js, beads-setup.js).
- **Inherits the same WSL/Windows binary problem** via better-sqlite3 that it claims to fix by removing Dolt.
- Original pain (4 specific operational issues) can be fixed in **1-2 weeks** with a thin wrapper.

**The killer insight**: The cloud-agent / API-only mode is the only thing WS3 actually adds that beads cannot do. Everything else (shared state, GitHub sync, MCP, CLI) can be built as a thin layer on top of beads.

**Beads evaluator's recommendation**:
> Build the cloud-agent adapter as a 1-week addition. Keep beads. Skip the rewrite.

### Concrete WS3 alternative (the right scope)

| Component | Effort | Solves |
|-----------|--------|--------|
| Shared Dolt launcher (1 server, all worktrees connect via TCP) | 2-3 days | Per-worktree servers + divergence |
| `forge issues sync` wrapper (auto sync on git push) | 1-2 days | Manual `bd dolt push/pull` |
| Symlink `.beads/` to `.git/common/beads/` (alt to shared server) | 1 day | Worktree divergence |
| Cloud-agent CLI adapter (`forge issue` routes to `gh` when no `.git/`) | 1 week | Codex/Copilot support without local state |
| Fork beads, fix 5 upstream bugs, file PRs | 2-3 weeks (Go) | Permanently removes workaround tax |

**Total: 2-3 weeks instead of 8-22.** Same pain solved. All beads features preserved. Skill ecosystem intact.

---

## Convergent Cuts (what to remove from v2)

Both strategy and value evaluators agree these should be removed or deferred:

| Workstream | Action | Reason |
|-----------|--------|--------|
| **WS3 (forge-issues MCP rewrite)** | **CUT — replace with thin wrapper + cloud adapter (2-3 weeks)** | 5-10x over-scoped; inherits problems it claims to fix |
| **WS6 (Parallel agent teams)** | **CUT — defer to v3** | Not load-bearing; 6-8 weeks; complex coordination across 6 agents |
| **WS9 Phase 3 (Cross-agent parity testing)** | **CUT — defer to v3** | Too expensive; only 2 weeks of stable workflow to test against |
| **Multi-agent generation in WS2** | **REDUCE to Claude Code only** | "Universal across 6 agents" is vendor concern, not user value |
| **WS5 self-evaluation overlap with WS13** | **MERGE** | Strategy evaluator: WS13 guardrails could obviate WS5 evaluator for many cases |

**Net effect**: ~10-12 weeks of work removed. Plan becomes 8-10 weeks instead of 20.

---

## Convergent Reorderings (what's still in v2)

| Order | Workstream | Why this position |
|------|-----------|------------------|
| 1 | WS4 schema freeze (handoff format) | Foundation for all consumers |
| 2 | WS3 (thin wrapper, NOT rewrite) | Operational pain fix |
| 3 | WS13 (guardrails) | Verifies migration |
| 4 | WS11 (Context7 skills) | Context-aware day 1 |
| 5 | WS1 (CLI abstraction) | After WS3 stabilizes |
| 6 | WS5 (evaluator with WS11 context) | Now has tech-aware skills |
| 7 | WS2 (commands → agents, Claude Code only) | Verified by WS13 guardrails |
| 8 | WS10 (universal review) | After WS2 stage definitions exist |
| 9 | WS12 (doc automation) | Integrates with WS2 ship-agent |
| 10 | WS7 (safety/auto mode) | Ties together with guardrails |
| 11 | WS8 (long-running harness) | Independent enhancement |

---

## The Hardest Question: External Value 3/10

The value evaluator's score is the most painful finding:

> "The only person who unambiguously needs Forge v2 is the Forge maintainer, because the workflow is shaped like their brain."

**Strongest evidence:**
- Time-to-first-value: 30+ min vs Cursor's 30 seconds
- Claude Code now has skills, agents, plan mode, code review natively
- Real adoption pattern is "type prompt → ship," not "5-stage workflow"
- No defensible moat against VC-funded incumbents
- Single maintainer can't sustain 13-workstream surface area

**The genuinely novel piece** (per value evaluator):
> "The evaluator subagent with separate context + rubric. That's the one genuinely novel piece, and it maps to a real pain point (AI slop in PRs)."

### Three honest options

| Option | Description | Time | External value | Honest? |
|--------|-------------|------|:--------------:|:-------:|
| **A: Ship v2 as planned** | All 13 workstreams, 20 weeks | 20w (40w realistic) | 3/10 | No |
| **B: Pivot to Forge Evaluate** | Ship `forge evaluate <pr>` as standalone CI tool | 1-2 weeks | 7/10 | Yes |
| **C: Right-size v2** | Cut WS3 rewrite, WS6, WS9-P3, multi-agent. Reorder. Honest scope. | 8-10w | 5/10 | Yes |
| **D: Embrace internal tool** | Drop external pretense, document as "Harsha's workflow" | 0 | 2/10 | Yes |

---

## Top 5 Recommendations (cross-evaluator consensus)

1. **Cut WS3 rewrite. Replace with 2-3 week thin wrapper + cloud adapter + beads fork.**
   This is the single highest-leverage change. Saves 5-15 weeks. Preserves all beads features. Solves the same pain.

2. **Lead with `forge evaluate` as the headline product.**
   It's the only genuinely novel piece. CI-runnable, agent-agnostic, single command. Real pain point (AI slop in PRs). No incumbent owns it yet.

3. **Cut WS6 and WS9-P3 from v2.**
   Defer to v3. Not load-bearing. Add complexity without proportional value.

4. **Drop "universal across 6 agents" pitch. Pick Claude Code as primary.**
   Other agents = best-effort. The vendor-side multi-agent story is not user value.

5. **Add honest scope statement to the strategy doc:**
   - "This is for: AI tinkerers and small teams who want structured AI workflows. Not for: solo devs who want fast iteration, enterprises who want commercial support."
   - "What we're NOT doing in v2: parallel agent teams, multi-agent generation beyond Claude Code, cross-agent eval parity."
   - "Realistic timeline: 8-10 weeks at one engineer."

---

## What To Do This Week

1. **Pause v2 implementation.** Don't write code based on the current plan.
2. **Read the 4 evaluator reports** (this synthesis + the 4 inline reports).
3. **Decide between Option B (pivot) and Option C (right-size).** Don't try to do both.
4. **Update the strategy doc** to reflect the chosen scope.
5. **Close 25+ beads issues** that become irrelevant or obsolete with the reduced scope.
6. **State the honest user persona** with evidence — or admit it's a personal tool.

---

## The Meta-Lesson

This evaluation IS the GAN-inspired pattern from Anthropic's harness design article applied to a strategy doc. Four evaluators with separate contexts read the plan and converged on the same critique without coordination.

**This is why the pattern works.** The orchestrator (the conversation that built v2) was too invested in the plan to see its own scope creep. Fresh evaluators saw it immediately.

**The plan should adopt this pattern for itself**: every major strategy doc should be evaluated by a separate-context evaluator before implementation begins. This would have caught the scope creep at week 1 instead of after 20+ research agents and 24+ plan documents.
