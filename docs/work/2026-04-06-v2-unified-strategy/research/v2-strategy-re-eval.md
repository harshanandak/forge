# Forge v2 Unified Strategy — Re-Evaluation

**Date**: 2026-04-06
**Evaluator context**: Fresh
**Previous score**: C / 0.80 (40%)
**Plan reviewed**: `docs/plans/2026-04-06-forge-v2-unified-strategy.md` (1,690 lines)

---

## Dimension Scores

### 1. Completeness (30%) — **1.6 / 2** (was 1/2)

**Reasoning**: Plan now has explicit scope statement (who it's for / who not), 6-row "what v2 cuts" table with savings, workstream-by-workstream effort tables, phased week-by-week roadmap, deferred-to-v3 list, beads issues mapped to workstreams, and risk-adjusted timeline with buffers. Schema-first ordering (WS4 week 1) is called out explicitly.

**Improved**: Workstream sequencing now justified ("WS4 schema FIRST", "WS3 before agents touch state", "WS13 before WS2 so migration is verifiable", "WS11 before WS5"). Migration story is explicit (parallel old/new for 2 sprints, deprecation warnings, CI grep validation). Right-sizing of WS3 from 8-22w to 4-5w is documented with rationale.

**Still missing**:
- No explicit rollback plan if WS3 sync layer fails in production (only "graceful fallback" mentioned for sub-cases)
- No cost model in dollars or token-budget per workflow cycle (efficiency profile shows relative tokens but not $/cycle)
- Schema versioning policy referenced ("schema FROZEN") but no actual version field shown in handoff JSON example

### 2. Clarity (25%) — **1.5 / 2** (was 1/2)

**Reasoning**: Headline value prop ("fast capture from inside the workflow") is now crisp. Stage math (10 commands → 5 stages, 3,379 → ~1,500 lines / 55%) is shown with line counts. Tables dominate over prose. Smart status scoring rubric is concrete (7 dimensions, weights sum to 100%).

**Improved**: SuperPowers credit added with star-count justification. Audience segmentation (20%/65%/15%) names "balanced" as primary path. Hybrid orchestrator pattern explained with diagram + rationale citing Anthropic.

**Still missing**:
- "Anthropic found models self-evaluate poorly" still uncited (no link or paper)
- "100k stars validates audience" — SuperPowers link in markdown is `(https://github.com/)`, broken/empty href
- Some success criteria still soft (e.g., "ships features faster with confidence" — no metric)
- WS9 metrics have targets but most other workstreams lack acceptance criteria

### 3. Feasibility (20%) — **1.0 / 2** (was 0/2)

**Reasoning**: Timeline went from 20w → 13-15w (stated), with 12-14w in headline and Phase 4 = 2 weeks of buffer. Per-week tables show concrete deliverables. Risk-adjusted timeline lists 5 risks with +1 week each. Right-sizing of WS3 is the biggest feasibility win — wrapping 50+ existing bd commands rather than reimplementing them.

**Improved**: Effort estimates per workstream are now bottom-up (WS1: 4w, WS2: 2.5w, WS3: 4-5w, WS5: 2-3w, WS10: 2-3w, WS11: 2w, WS12: 1w, WS13: 1-2w). The roadmap visibly schedules concurrent workstreams within a single week.

**Still optimistic for one engineer**:
- Phase 1 Week 1 lists WS4 + WS3-shared-Dolt + WS3-cloud-adapter prep + WS1 pre-work + WS13 + WS7 + WS11 + WS8 across 4 weeks. Even with parallelization, this is ~14 person-weeks of work in 4 weeks.
- Sum of stated efforts: WS1 (4) + WS2 (2.5) + WS3 (4-5) + WS4 (1) + WS5 (2-3) + WS7 (2-3) + WS8 (2-3) + WS9 (3, P1+P2 only) + WS10 (2-3) + WS11 (2) + WS12 (1) + WS13 (1-2) ≈ **27-32 person-weeks**, compressed into 12-14 calendar weeks.
- No staffing assumption stated. If this is one engineer, it's still ~2x optimistic. If 2-3 engineers, plausible — but plan never says.
- WS2 "2.5 weeks" to write 7 canonical YAMLs and generate templates for 6 agents (12+ formats including dual mode-based agents) feels light.

### 4. Risk coverage (15%) — **1.5 / 2** (was 1/2)

**Reasoning**: WS1 has 7 named blockers with mitigations. WS2 calls out 7 dispatch blockers. WS3 names 5 upstream beads bugs by ID. Risk-adjusted timeline section lists 5 cross-cutting risks with explicit week buffers. Inbound flow for external GitHub contributors is walked through step-by-step including default classification, mirror-all + filter-on-display, and dependency-cycle resolution.

**Improved**: Schema versioning is implied ("FROZEN" week 1) and rollback for individual sync sub-components is described (graceful fallback, last-write-wins, cycle detection surfacing). Conflict resolution is named (last-write-wins per field, append-only comments, set-based deps).

**Still gaps**:
- No failure cascade analysis: if `forge issues sync` daemon dies silently, what's the user-visible signal?
- No fallback for total WS3 sync failure (other than "graceful fallback" per-call) — e.g., "if outbound queue exceeds N items, switch to manual sync mode and alert"
- No explicit schema version field in the handoff JSON example shown in WS4
- Webhook (Method 3) marked optional but no fallback story if a team adopts it then it breaks

### 5. Strategic coherence (10%) — **1.7 / 2** (was 1/2)

**Reasoning**: "Stop doing" principle is now visibly applied to the plan itself: WS6 cut, WS9-P3 cut, WS3 right-sized 5x, /research deleted, WS5/WS13 overlap reduced. Quarterly harness audit is a standing item. The "Inspiration credit" section honestly acknowledges prior art instead of claiming novelty across the board.

**Improved**: Headline value prop is now sharp and differentiated ("capture without leaving the work" vs Linear/Jira/SuperPowers). Configurable issue backend interface (BeadsBackend / GitHubIssuesBackend / Linear / Jira) makes the project genuinely extensible without v2 having to ship every adapter. The "balanced is the primary optimized path" framing is a real product decision.

**Still gaps**:
- WS3-OBSOLETE section is left in the file (lines ~470-700). It's marked DEPRECATED but still consumes ~230 lines. Cutting it would walk the talk on "stop doing".
- WS1 smart-status spec is detailed (~60 lines, 7-dim rubric, 8 grouping rules, 6 presentation modes, time/role variants, ~1100 LOC estimate). Strong feature, but ambitious for a single workstream addition — risk of bolt-on.

---

## Weighted Score

| Dimension | Weight | Score | Weighted |
|-----------|-------:|------:|---------:|
| Completeness | 30% | 1.6 | 0.480 |
| Clarity | 25% | 1.5 | 0.375 |
| Feasibility | 20% | 1.0 | 0.200 |
| Risk coverage | 15% | 1.5 | 0.225 |
| Strategic coherence | 10% | 1.7 | 0.170 |
| **Total** | **100%** | — | **1.450 / 2** |

**Percentage**: 72.5%
**Grade**: **B** (was C / 40%)
**Improvement**: +32.5 percentage points

---

## Cross-Cutting Questions

**1. Did workstream reordering fix dependency problems?**
Mostly yes. WS4 (handoff schema) is now week 1, WS13 (guardrails) before WS2, WS11 before WS5, WS3 (state) before agents touch state. The remaining issue is that WS1 Phase 0 (pre-work) and WS3 component 1 are both scheduled in Week 1 but Phase 0 explicitly says "must complete before any migration" — there's a small ordering tension.

**2. Is 13-15 weeks realistic for one engineer?**
**No.** Sum of stated workstream efforts is ~27-32 person-weeks. This is feasible only if (a) there are 2-3 engineers, or (b) heavy parallelism via subagents on tasks the engineer can review-only. Plan should add a staffing assumption line.

**3. Does right-sized WS3 solve the dual-database core issue?**
**Yes, structurally.** Component 1 (shared Dolt launcher — one server, all worktrees connect) directly eliminates per-worktree divergence and the manual `bd dolt push/pull` UX. Component 2 (bidirectional GitHub sync) makes GitHub Issues the cross-machine truth and removes JSONL from git entirely. The pain identified in the original plan is properly addressed without the 8-22 week rewrite.

**4. Does smart status fit naturally or feel bolted on?**
**Partially bolted on.** It's well-specified and clearly valuable, but it's a 3-week, ~1100 LOC subsystem inserted into WS1 (which was supposed to be a CLI abstraction layer). It deserves its own workstream label or a clear note that WS1 is now "abstraction + smart status". Conceptually it depends on WS3's mirror-all design, so the dependency should be made explicit in the roadmap.

**5. Hidden assumptions or missing pieces?**
- **Staffing**: never stated. The whole timeline rides on this.
- **Token budget per cycle in dollars**: relative cost shown (1x/1.6x/3x), absolute not.
- **Telemetry/opt-out**: WS9 metrics observatory writes `.forge/stage-metrics/`. Is this local-only? Shared? Privacy considerations not addressed.
- **Beads fork maintenance burden**: Component 4 is "fork beads, fix bugs, file PRs". What if upstream rejects PRs or goes inactive? Who maintains the fork long-term?
- **Migration of existing forge users**: v1→v2 migration is mentioned in Phase 4 ("migration guide") but not detailed.

**6. Has "stop doing" been applied?**
**Yes, materially.** WS6 cut, WS9-P3 cut, WS3 right-sized 5x, /research deleted, smart-evaluator overlap reduced. The deferred-to-v3 list is concrete. **One residual issue**: the WS3-OBSOLETE section is left in the document (~230 lines). Either delete it or move to an archive file — keeping it is a small but visible "stop doing" violation.

**7. Is external GitHub inbound flow robust enough for real teams?**
**Mostly yes for small teams (1-10 devs), risky for larger.** The Method 1 + Method 2 (30-min daemon) approach handles random external contributors via mirror-all + classify-on-pull. Bot-comment dependency storage is the right call vs body-block. Cycle detection surfaces but doesn't auto-resolve, which is correct.

**Concerns**:
- 30-minute polling means external issues triaged by one teammate may be stale on another's machine for up to 30 min. For active teams, this is enough latency to cause double-triage.
- Webhook (Method 3) is opt-in but no concrete deployment guide for "I want real-time without exposing a public URL".
- Last-write-wins per field works for status/priority but is risky for fields like assignee in active teams.
- Bot-comment metadata can be deleted by a maintainer cleaning up issues. "Detect tampering" is mentioned but recovery isn't.

---

## Top 3 Improvements (vs previous eval)

1. **WS3 right-sizing**: 8-22w rewrite → 4-5w wrapper. Preserves 50+ bd commands and the skill ecosystem. Solves the core dual-database problem via shared Dolt launcher (Component 1) without the cost of replacing the database.
2. **Workstream ordering fixed**: WS4 schema week 1 → WS3 state → WS13 guardrails → WS2 migration → WS5/WS11 evaluator. Dependency arrows now point forward.
3. **Honest scope statement + cuts**: Audience explicitly defined ("not for vibe coders"), 4 cuts documented with weeks saved, deferred-to-v3 list concrete. Plan applies "stop doing" to itself.

## Top 3 Remaining Gaps

1. **Staffing assumption missing + timeline still optimistic**: Sum of efforts is ~27-32 person-weeks compressed into 12-14 calendar weeks. Realistic only with 2-3 engineers. Plan must state this or extend to 18-22 weeks for one engineer.
2. **WS3-OBSOLETE section left in document**: ~230 lines marked DEPRECATED but still in the plan. Either delete or move to archive — leaving it contradicts the "stop doing" principle.
3. **Schema versioning + rollback story still thin**: WS4 says "FROZEN" but no version field shown in handoff JSON. No documented rollback plan if sync layer fails in production beyond per-call graceful fallback. Failure-cascade analysis missing (what if daemon dies silently?).

---

## Final Verdict

**Minor revisions** before implementation start.

The plan is substantively improved and ready for execution after a small set of fixes:

1. Add a staffing assumption line in §0 (e.g., "assumes 2 engineers, 13-15 weeks; for 1 engineer, expect 22-26 weeks")
2. Delete the WS3-OBSOLETE section or move it to an archive file
3. Fix the empty SuperPowers link (`https://github.com/`)
4. Add 1-2 citations for "Anthropic found models self-evaluate poorly"
5. Add a `schema_version` field to the WS4 handoff JSON example
6. Add 3-5 lines on rollback if the WS3 sync layer fails in production
7. Either rename WS1 to "CLI Abstraction + Smart Status" or split smart status into its own WS

These are paper changes, not architectural rework. After them, the plan is ship-ready for a 2-engineer team. For a 1-engineer team, the timeline needs honest extension regardless.

**Score: 1.45 / 2 (72.5%) — Grade B, up from C / 40%.**
