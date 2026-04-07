# Forge v2 Unified Strategy — Final Evaluation

**Evaluator**: Fresh-context skeptical reviewer
**Date**: 2026-04-06
**Doc evaluated**: `docs/plans/2026-04-06-forge-v2-unified-strategy.md` (1645 lines)
**Previous score**: 1.45/2.00 (B, 72.5%)

---

## Weighted Scores

| Dimension | Weight | Score (0-2) | Weighted |
|-----------|:------:|:-----------:|:--------:|
| Completeness   | 30% | 1.75 | 0.525 |
| Clarity        | 25% | 1.75 | 0.4375 |
| Feasibility    | 20% | 1.5  | 0.300 |
| Risk coverage  | 15% | 1.75 | 0.2625 |
| Strategic coherence | 10% | 2.0 | 0.200 |
| **Total**      |     |      | **1.725 / 2.00** |

**Grade: B+ (86%)**
**Delta vs previous: +0.275 (+13.5 pts), promoted from B → B+**

---

## Dimension Notes

### 1. Completeness — 1.75 / 2

**Improved**: WS3 now has 5 explicit components, an effort table, a rollback path, and a clean separation between in-scope (1-4) and deferred-to-v3 (5). Migration via `forge config set` toggles is documented. Schema versioning policy is referenced and `schema_version` appears in handoff JSON. Killer demo, staffing reality, and 3-release sequenced fallback are all called out.

**Still wrong**:
- WS3 revision history line (line 571) still says "thin wrapper + cloud adapter (2-3 weeks)" while the actual effort table inside WS3 (line 802) and Section 4 (line 1454) say **4-5 weeks**. This is leftover stale text from an earlier revision and should be reconciled.
- The risk inventory referenced (`forge-issues-risk-inventory.md`) is acknowledged as written for the rejected rewrite — a fresh wrapper-specific inventory is still missing.

### 2. Clarity — 1.75 / 2

**Improved**: Section 4 Option E table cleanly justifies the wrapper choice against 4 alternatives. The MCP/CLI parity diagram now correctly references `bd` (lines 240/244), not SQLite. The "what's preserved / what's eliminated / what changes for users" tables are concrete and testable. SuperPowers + Anthropic citations are present.

**Still wrong**:
- The "GitHub Issues sync" section references "Recent external" group on line 685 — but smart status (line 134) **explicitly cut** that group down to 4. Minor narrative drift between WS1 and WS3.
- Source doc table (#3) marks beads-evolution-strategy as "SUPERSEDED" but doesn't link to the doc that supersedes it.

### 3. Feasibility — 1.5 / 2

**Improved**: Honest staffing assumption is the single biggest improvement. 13-15w (2 eng) vs 22-26w (1 eng) vs 3 sequenced releases is the most credible timeline this plan has had. Phase ordering (WS4 schema first, WS3 before WS1) is sensible. Component 5 (Go fork) is correctly deferred for solo work.

**Still concerning**:
- Phase 1 Week 1 still tries to deliver schema freeze + shared Dolt launcher in the same week. Aggressive even for 2 engineers.
- WS3 Component 2 is 2-2.5 weeks for **9 sub-components** including bidirectional sync, conflict resolution, dep cycles, daemon, and external classifier. That's roughly 1-2 days per sub-component — optimistic. Real-world bidirectional sync (especially conflict resolution and cycle detection across machines) historically blows past initial estimates.
- Phase 2 Week 6-7 stacks WS1 Codex/Cursor + WS2 all-agent templates + WS1 all-agent migration in adjacent weeks. Cross-agent config work historically reveals surprise incompatibilities.
- Sum of person-weeks (~27-32) compressed to 13-15 calendar weeks requires near-perfect parallelization with no blocking dependencies. The plan claims this but the dependency arrows (WS4 → WS3 → WS1 → WS2) suggest more sequencing than parallelization actually allows.

### 4. Risk coverage — 1.75 / 2

**Improved**: Rollback path per component, conflict resolution policy, dep-cycle handling, GitHub rate limit mitigation, "risks that disappear with wrapper" table. The 7 WS1 blockers are concrete and have mitigations.

**Still concerning**:
- No explicit risk for "shared Dolt server crashes / port collision / stale lock when main repo is on a different machine than worktree" — the shared launcher solves divergence but introduces a new SPOF.
- No mention of what happens when GitHub Issues is the source of truth and GitHub is down or the user is offline. Local cache should still work, but this isn't documented.
- No data-loss risk for the migration moment when `.beads/dolt/` moves out of git.

### 5. Strategic coherence — 2.0 / 2

The killer demo framing (60s contributor → forge status) is exactly the kind of focusing function this plan needed. The "stop doing" cuts (WS6, WS9-P3, smart-status modes, smart-status groups, --morning/--eod, delta tracking, original WS3 rewrite) are explicit and justified. Audience is sharply defined ("developers who care about TDD discipline") with explicit non-audience.

---

## Cross-Cutting Answers

1. **Internally consistent?** Mostly. Two minor drifts:
   - Line 571 says wrapper is "2-3 weeks" but effort table says 4-5 weeks
   - Line 685 references "Recent external" group that was cut from smart status

2. **Does the wrapper solve dual-database?** Yes. Shared Dolt launcher eliminates per-worktree divergence; GitHub Issues becoming source-of-truth eliminates JSONL merge conflicts; cloud adapter handles ephemeral environments. The architecture is coherent.

3. **Smart status properly scoped?** Yes. 4 groups (down from 8), 2 modes (down from 6), role as config not flag, --morning/--eod and delta tracking cut. ~1400 LOC across 6 files for 3-4 weeks is believable.

4. **Killer demo works?** Yes — and it's load-bearing. It forces every Phase 1 deliverable to justify itself against a single user-visible outcome. This is the strongest framing improvement in the revision.

5. **Staffing-honest timeline realistic?** The 22-26w solo number is plausible. The 13-15w 2-engineer number is aggressive but defensible IF the parallelization actually holds. The 3-release sequenced fallback (4-5w + 5-6w + 6-8w) is the most realistic path for the actual staffing reality.

6. **What's still missing or wrong that would prevent shipping?**
   - The 2-3w vs 4-5w stale text on line 571 (1-line fix)
   - "Recent external" reference on line 685 (1-line fix)
   - A fresh wrapper-specific risk inventory (the existing one is acknowledged as obsolete)
   - Explicit offline / GitHub-down behavior
   - Migration runbook for moving `.beads/dolt/` out of git

None of these are blockers. All are 1-2 day fixes.

---

## Top 3 Things Now Clearly Right

1. **WS3 wrapper approach is the right answer** — Section 4 Option E table makes it indefensible to choose anything else. Preserves 50+ bd commands, all skills, all forge integration, while solving every operational pain point.
2. **Honest staffing reality** — 13-15w / 22-26w / 3-release fallback is the most credible timeline this plan has had. No more "20 weeks" hand-wave.
3. **Killer demo as focusing function** — The 60-second contributor → forge status story is a real product narrative, not a feature list. It will drive correct prioritization in execution.

## Top 3 Things Still Concerning

1. **Component 2 (bidirectional GitHub sync) is under-budgeted** — 9 sub-components in 2-2.5 weeks is 1-2 days per sub-component. Bidirectional sync with conflict resolution historically blows out. Expect this to be 3-4 weeks in practice.
2. **Two minor narrative drifts** — line 571 (2-3w vs 4-5w) and line 685 (cut "Recent external" group). 5-minute fixes but they signal the doc hasn't had a final consistency pass.
3. **Shared Dolt launcher SPOF risk un-documented** — Solving divergence by introducing a single shared server is the right tradeoff, but the new failure modes (server crash, port collision, network partition between worktrees on different machines) need their own risk row.

---

## Final Verdict

**MINOR REVISIONS** before shipping.

The plan is structurally sound, internally ~95% consistent, and the strategic coherence is now strong. The remaining issues are 1-2 day fixes, not architectural rethinks:

1. Reconcile line 571 ("2-3 weeks") with the actual 4-5 week effort
2. Remove "Recent external" reference on line 685 (group was cut)
3. Add a wrapper-specific risk inventory (or annotate the existing one in-place)
4. Add 1 risk row for shared Dolt launcher SPOF
5. Add 1 paragraph on offline / GitHub-down behavior

Promote from B to **B+**. After the 5 fixes above, this would land at A-/A. The plan is ready to execute as a 3-release sequenced rollout for the realistic solo-engineer case, or as a 13-15w 2-engineer push if staffing materializes.

**Score: 1.725 / 2.00 (B+, 86%)**
**Previous: 1.45 / 2.00 (B, 72.5%)**
**Delta: +13.5 percentage points**
