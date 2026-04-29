# Forge v2 Strategy — Pass 4 Final Evaluation

**Date**: 2026-04-06
**Evaluator**: Fresh-context, no conversation history
**Doc evaluated**: `docs/plans/2026-04-06-forge-v2-unified-strategy.md` (1715 lines)
**Previous passes**: P1=0.80 (C/40%), P2=1.45 (B/72.5%), P3=1.725 (B+/86%)

---

## TL;DR

**Final score: 1.84/2.00 = A- (92%)**
**Verdict: SHIP NOW.** Minor revisions are nice-to-have, not blockers. The doc has crossed the line from "plan that needs more planning" to "plan that needs execution."

---

## Dimension Scores

### 1. Completeness (30%) — 1.85/2.00

**Strong**:
- All major problems addressed: dual-database, cross-worktree divergence, agent abstraction, cloud agents, doc rot, review pain.
- WS3 rollback path (L806-814) is component-by-component togglable. Rare in plan docs.
- Risk inventory references present per workstream (WS1 lists 5 separate risk files).
- Schema versioning exists (`schema_version: 1` in handoff format L848).
- Beads issue mapping table (L1689) ties strategy to existing work tracker — 16 closed, 9 obsolete, 14 unchanged. Concrete.
- Section 4.5 pattern documentation closes the meta-loop.

**Still imperfect**:
- Phase 4 ordering oddity: WS4 P2-P4 (full prompt decomposition) is in Week 14 while WS4 P0-P1 was Week 1. Reasonable but undocumented why P2-P4 weren't bundled with WS5.
- Schema versioning is mentioned but no migration policy spelled out for `schema_version: 2`.
- L1435 "Phase 4: Harness Audit (Ongoing)" duplicates the Phase 4 header (L1415) — minor formatting bug, two sections with same name.

### 2. Clarity (25%) — 1.85/2.00

**Strong**:
- Decision rationale is documented with citations (Anthropic Harness Design article cited multiple times).
- WS3 explicitly shows the broken-vs-fixed Dolt diagram (L585-599) — a different team could implement it from this alone.
- Profile design (L514-552) is unambiguous: balanced is the primary path, performance/efficient are side cases.
- Tier model (L75-82) anchors every decision in "does it work at Tier 1-3?".

**Still imperfect**:
- L1685 "Beads Issues Incorporated" still references `forge-f3lx → WS3 (forge-issues MCP, GitHub-backed coordination)` — but WS3 is now a wrapper, not an MCP server. Stale phrasing.
- WS3 Component 5 "deferred to v3 if solo engineer" but the roadmap Phase 3 Week 12 still lists "Fork beads + fix 5 upstream bugs" — slight inconsistency between staffing-aware and roadmap views.

### 3. Feasibility (20%) — 1.75/2.00

**Strong**:
- Honest re-baseline of WS3 to 5-6 weeks acknowledged with explicit reasoning (L796, L801-803).
- Two-engineer assumption stated openly (L1660).
- Solo-engineer fallback offered as 3 staged releases v2.0/v2.1/v2.2 totaling 16-19 weeks (L1670-1675).
- 13-15 weeks for 2 engineers is plausible given the work tables.

**Still imperfect**:
- Sum-of-effort sanity check: WS1 (4w) + WS2 (2.5w) + WS3 (5-6w) + WS4 (~1w) + WS5 (~1w) + WS7 (~1w) + WS8 (~1w) + WS9 (~1w) + WS10 (~2w) + WS11 (~1w) + WS12 (~1.5w) + WS13 (~1.5w) ≈ 22.5-23.5 person-weeks. The doc says 27-32 person-weeks. The discrepancy isn't reconciled — either the per-WS estimates are low or the total is padded. Both are defensible but the math should match.
- "13-15 weeks with 2 engineers" assumes near-perfect parallelism with WS3 on one engineer and WS1+WS2 on the other. WS5/WS10/WS11/WS13 converging "in the second half" is hand-wavy. A real Gantt would expose 1-2 weeks of slack/coordination loss.
- Smart status at "1400 LOC in 3-4 weeks" is plausible but the existing 819 LOC of `smart-status.sh` (called out by feasibility evaluator) is not explicitly carried into the estimate as either "throwaway" or "salvage."

### 4. Risk Coverage (15%) — 1.90/2.00

**Strong**:
- Shared Dolt SPOF is now explicitly called out as **the most important new failure mode** (L1508) with 4 concrete mitigations (watchdog, PID/port recovery, graceful errors, crash-safe Dolt files). This is exactly the right framing.
- 7 WS1 blockers + 7 WS2 dispatch blockers itemized with mitigations.
- Risk-Adjusted Timeline table (L1707) with concrete buffer allocations.
- Risks that DISAPPEAR with the wrapper approach (L1514) is honest accounting — shows author understands what was traded.

**Still imperfect**:
- Watchdog auto-restart for the Dolt SPOF is asserted but not designed. Who runs the watchdog? A daemon? Per-command check? On Windows where there's no native daemon model, this is non-trivial.
- No mention of what happens if the **GitHub Issues sync queue itself corrupts** (the new write path is `bd → queue → gh` — queue corruption is now in the critical path).

### 5. Strategic Coherence (10%) — 1.90/2.00

**Strong**:
- "Stop doing" is genuinely applied: WS6 cut, WS9-P3 cut, smart status cut from 8→4 groups and 6→2 modes, morning/eod cut, delta tracking cut.
- Professional dev as primary user (L511, L516) is consistent throughout: balanced profile is "the primary optimized path," not just the default.
- The killer demo (L1677-1683) gives one sentence anyone can rally around: "External contributor opens an issue → 60 seconds later it's in `forge status` → forge plan picks it up."
- Section 4.5 makes the recursive proof point: the plan ships the pattern that built it. This is genuinely valuable, not self-congratulatory — it's instructive for implementers about HOW to use the pattern.

**Still imperfect**:
- The "Stop doing" of WS9-P3 vs WS9 still appearing in Phase 2 Week 8 and Phase 3 Week 11 is fine, but the deferred parts vs included parts could be one clearer table.

---

## Weighted Total

| Dimension | Weight | Score | Weighted |
|-----------|:------:|:-----:|:--------:|
| Completeness | 30% | 1.85 | 0.555 |
| Clarity | 25% | 1.85 | 0.4625 |
| Feasibility | 20% | 1.75 | 0.350 |
| Risk Coverage | 15% | 1.90 | 0.285 |
| Strategic Coherence | 10% | 1.90 | 0.190 |
| **Total** | **100%** | — | **1.84/2.00 = A- (92%)** |

---

## Comparison to Pass 3

| Pass | Score | Grade | Delta |
|------|:-----:|:-----:|:-----:|
| Pass 1 | 0.80 | C (40%) | — |
| Pass 2 | 1.45 | B (72.5%) | +0.65 |
| Pass 3 | 1.725 | B+ (86%) | +0.275 |
| **Pass 4** | **1.84** | **A- (92%)** | **+0.115** |

The diminishing-returns curve is correct — Pass 4 should be smaller gains than Pass 2. The doc is converging.

---

## Critical Questions Answered

1. **Internally consistent now?** Mostly yes. Two minor stale phrasings: L1685 "forge-f3lx → forge-issues MCP" should say "wrapper", and the WS3 Phase 3 Week 12 fork-beads work isn't reconciled with the staffing-aware deferral. Not blockers.

2. **Does Section 4.5 add value?** YES. It's instructive (gives implementers concrete milestone evaluator questions in the L1553 table), self-aware (Anti-pattern section L1574), and the recursive proof point (L1583) is intellectually honest, not back-patting. The C→B→B+ table is calibration data future evaluators can use. Keep it.

3. **WS3 wrapper realistically scoped at 5-6 weeks?** Yes, given the Component 2 sub-breakdown (2a-2i, ~16-22 days of work) plus Components 1, 3, 4. This is no longer the optimistic estimate it was in pass 2.

4. **Shared Dolt SPOF mitigation adequate?** ALMOST. The framing is right (L1508), but the watchdog implementation is asserted not designed. On Windows specifically, "auto-restart watchdog on every forge command" is the only practical option — this should be stated. 8/10.

5. **Smart status right-sized at 4 groups?** Yes. The cut rationale (L134) is concrete: each cut group is justified by what handles it instead. 4 groups + 2 modes + role config is the right floor.

6. **Can 2 engineers execute in 13-15 weeks?** Probably. Tight but achievable. 1 week of slip is realistic; 3+ weeks would mean a misjudged dependency. The 16-19 week solo path is the safer bet for any team that isn't fully staffed.

7. **What still feels wrong?** (a) Two duplicate "Phase 4" headers. (b) Minor stale phrasings tying WS3 to "MCP server" language. (c) Watchdog design hand-wave. (d) Person-week math doesn't reconcile (22.5 vs 27-32). None are showstoppers.

8. **Ready to ship or showstoppers?** Ready. No showstoppers. The remaining items are polish-during-execution, not block-execution.

---

## Top 3 Things Now Clearly Excellent

1. **WS3 right-sizing with honest re-baseline.** The before/after Dolt diagrams + component-by-component effort table + rollback path is exemplary. Other teams can follow this template.

2. **Section 4.5 (Evaluator Pattern documentation).** Closes the loop between the planning method and the shipped feature. Provides concrete implementer guidance via the per-milestone evaluator question table. The "Anti-pattern: Evaluator as rubber stamp" section shows mature awareness.

3. **Killer demo as anchor (L1677).** "External contributor opens issue → 60 seconds later in forge status → forge plan picks it up" gives every Phase 1 deliverable a single judgment criterion. Rare in 1700-line strategy docs.

---

## Top 3 Things Still Imperfect (Non-Blocking)

1. **Person-week math doesn't reconcile.** Sum of per-WS estimates ≈ 22.5-23.5; doc claims 27-32. Pick one and update either the per-WS table or the total. 30-minute fix.

2. **Shared Dolt watchdog under-designed.** The SPOF is acknowledged (good), the mitigations are listed (good), but "auto-restart watchdog" needs one paragraph on the implementation model — especially for Windows where there's no daemon convention. The whole forge workflow depends on this single component.

3. **Minor stale references and duplicate headers.** L1685 still calls WS3 "forge-issues MCP." Two "Phase 4" headers (L1415 and L1435). Trivial to fix; trips a careful reader.

---

## Final Verdict

**SHIP NOW.**

The doc has crossed every meaningful threshold:
- Honest about scope and staffing
- Concrete about risks and rollbacks
- Internally consistent (with 2-3 cosmetic exceptions)
- Anchored to a single killer demo
- Documents its own methodology so the pattern can be reused

Continuing to polish would yield Pass 5 = 1.88, Pass 6 = 1.90, asymptotically approaching but never reaching 2.00. That's wasted calendar time. The remaining imperfections will be discovered and fixed faster by execution than by another evaluator pass.

**Recommended action**: Fix the 3 trivial items above in a 30-minute editing pass, then start Phase 1 Week 1 (WS4 handoff schema + WS3 shared Dolt launcher). Do not commission Pass 5.

**Confidence in this verdict**: High. The pass-over-pass score progression (0.80 → 1.45 → 1.725 → 1.84) shows the doc is converging, not oscillating. Diminishing returns are real.
